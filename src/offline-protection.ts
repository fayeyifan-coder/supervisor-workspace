import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { m1Protection, WorkspaceFault } from "./database";
import { growthProtection } from "./growth-profile";
import { intakeProtection, intakeSourceDigest } from "./student-intake";
import { parseIntake } from "./intake-format";
import { worklogProtection } from "./worklog";

const layouts = [m1Protection, worklogProtection, growthProtection, intakeProtection] as const;
const magic = Buffer.from("SWBACK1\n");
const maxDatabase = 32 * 1024 * 1024;
const maxPackage = 129 * 1024 * 1024;
const maxManifest = 16 * 1024;
const maxRecoveryEvidence = 32 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ManifestDatabase {
  file: string;
  applicationId: number;
  schemaVersion: number;
  schemaSha256: string;
  length: number;
  sha256: string;
  initialization: { file: string; content: string };
}
export interface ProtectionSummary {
  createdAt: string;
  applicationVersion: string;
  students: number;
  workItems: number;
  growthProfiles: number;
  intakeBindings: number;
  unfinishedImports: number;
}
export interface ProtectionResult extends ProtectionSummary { location: string; profileName?: string }
interface Manifest {
  formatVersion: 1;
  createdAt: string;
  applicationVersion: string;
  databases: ManifestDatabase[];
}
type Layout = (typeof layouts)[number];
type Store = { protectionConnection(): DatabaseSync };

export function requireSupportedProfileOpen(name: string, hasRestoreRecord = false): void {
  if (hasRestoreRecord || /^sw-m2d-(restore|active)-/i.test(name)) {
    throw new WorkspaceFault("recovery", "恢复档案不能从普通入口打开。请在工作台中选择并激活恢复副本。");
  }
}

function reject(message: string): never { throw new WorkspaceFault("invalid", message); }
function sha(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function schema(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name").all());
}
function expectedSchema(layout: Layout): string {
  const db = new DatabaseSync(":memory:");
  try {
    for (const ddl of layout.ddl) db.exec(ddl);
    return schema(db);
  } finally { db.close(); }
}
function checkImage(db: DatabaseSync, layout: Layout): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== layout.applicationId ||
      db.prepare("PRAGMA user_version").get()?.user_version !== layout.version ||
      schema(db) !== expectedSchema(layout)) {
    reject("数据库身份或 Schema 不匹配：" + layout.key);
  }
  const integrity = db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check;
  if (integrity !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
    reject("数据库完整性或外键校验失败：" + layout.key);
  }
}

function snapshot(source: DatabaseSync, layout: Layout): Buffer {
  checkImage(source, layout);
  const pageCount = Number(source.prepare("PRAGMA page_count").get()?.page_count);
  const pageSize = Number(source.prepare("PRAGMA page_size").get()?.page_size);
  if (!Number.isSafeInteger(pageCount * pageSize) || pageCount * pageSize > maxDatabase) {
    reject("数据库超过离线备份上限：" + layout.key);
  }
  const memory = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    memory.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=MEMORY; PRAGMA max_page_count=8192; BEGIN");
    for (const ddl of layout.ddl) memory.exec(ddl);
    memory.exec("PRAGMA defer_foreign_keys=ON");
    for (const table of layout.tables) {
      const columns = memory.prepare("PRAGMA table_info(" + table + ")").all().map(c => String(c.name));
      const read = source.prepare("SELECT * FROM " + table);
      read.setReadBigInts(true);
      const write = memory.prepare("INSERT INTO " + table + " VALUES(" + columns.map(() => "?").join(",") + ")");
      for (const row of read.iterate()) write.run(...columns.map(column => row[column]));
    }
    memory.exec("PRAGMA application_id=" + layout.applicationId + "; PRAGMA user_version=" + layout.version + "; COMMIT");
    const bytes = Buffer.from(memory.serialize());
    if (bytes.length > maxDatabase || bytes[18] !== 1 || bytes[19] !== 1) reject("无法生成普通 SQLite 镜像。");
    return bytes;
  } finally { memory.close(); }
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare("SELECT count(*) AS n FROM " + table).get()?.n);
}
function summary(dbs: DatabaseSync[], manifest: Pick<Manifest, "createdAt" | "applicationVersion">): ProtectionSummary {
  const [m1, work, growth, intake] = dbs;
  const students = new Set(m1.prepare("SELECT id FROM students").all().map(x => x.id));
  for (const id of students) if (typeof id !== "string" || !uuid.test(id)) reject("M1 学生 UUID 无效。");
  const requireStudent = (id: unknown) => {
    if (typeof id !== "string" || !students.has(id)) reject("备份含有找不到 M1 学生的关联。");
  };
  for (const row of work.prepare("SELECT student_id FROM work_items WHERE student_id IS NOT NULL").iterate()) {
    requireStudent(row.student_id);
  }
  for (const row of work.prepare("SELECT snapshot FROM work_changes").iterate()) {
    const value: unknown = JSON.parse(String(row.snapshot));
    if (!value || typeof value !== "object" || !("studentId" in value)) reject("工作事项历史无效。");
    if (value.studentId !== null) requireStudent(value.studentId);
  }
  for (const row of growth.prepare("SELECT student_id FROM growth_profiles UNION SELECT student_id FROM growth_requests").iterate()) {
    requireStudent(row.student_id);
  }

  let unfinishedImports = 0;
  const request = growth.prepare("SELECT student_id FROM growth_requests WHERE request_id=?");
  const imported = new Set<string>();
  const growthRefs = new Set<string>();
  for (const row of intake.prepare("SELECT code,student_id,state,student_confirmed,plan_json,source_json,digest FROM intake_bindings JOIN intake_jobs USING (code)").iterate()) {
    const plan = JSON.parse(String(row.plan_json));
    const id = row.student_id as string;
    const archived = JSON.parse(String(row.source_json));
    const extracted = parseIntake(JSON.stringify(archived.source));
    if (extracted.code !== row.code || archived.code !== row.code || intakeSourceDigest(extracted.source) !== row.digest) {
      reject("导入来源、代号或摘要不一致。");
    }
    if (typeof id !== "string" || !uuid.test(id) || plan?.growth?.studentId !== id ||
        (plan.target?.kind === "existing" ? plan.target.studentId !== id :
          plan.target?.kind !== "new" || plan.newStudent?.id !== id) ||
        typeof plan.growth.requestId !== "string" || !uuid.test(plan.growth.requestId) || growthRefs.has(plan.growth.requestId)) {
      reject("导入凭据的学生或请求编号不一致。");
    }
    imported.add(String(row.code));
    growthRefs.add(plan.growth.requestId);
    const result = request.get(plan.growth.requestId);
    if (result && result.student_id !== id) reject("导入请求指向另一个成长档案。");
    if (row.student_confirmed === 1 || row.state !== "pending") requireStudent(id);
    if (row.state === "done" && (!result || row.student_confirmed !== 1)) {
      reject("已完成导入缺少对应的成长档案保存凭据。");
    }
    if (row.state !== "done") unfinishedImports++;
  }
  if (imported.size !== count(intake, "intake_bindings")) reject("存在没有导入请求的代号绑定。");
  return { createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion,
    students: students.size, workItems: count(work, "work_items"), growthProfiles: count(growth, "growth_profiles"),
    intakeBindings: imported.size, unfinishedImports };
}

function withProtectionConnections<T>(stores: readonly Store[], operation: (connections: DatabaseSync[]) => T): T {
  if (stores.length !== layouts.length) reject("备份库清单无效。");
  const connections = stores.map(store => store.protectionConnection());
  const locked: DatabaseSync[] = [];
  try {
    // All application writes run synchronously in the main process. IMMEDIATE also excludes separate SQLite writers.
    for (const connection of connections) {
      connection.exec("BEGIN IMMEDIATE");
      locked.push(connection);
    }
    return operation(connections);
  } finally {
    let rollbackError: unknown;
    for (const db of locked.reverse()) {
      try { db.exec("ROLLBACK"); } catch (error) { rollbackError ??= error; }
    }
    if (rollbackError) throw new WorkspaceFault("recovery", "无法释放备份快照事务，请关闭应用核对数据库。");
  }
}

export function verifyProtectionStores(stores: readonly Store[], applicationVersion: string): void {
  withProtectionConnections(stores, connections => {
    connections.forEach((db, index) => checkImage(db, layouts[index]));
    summary(connections, { createdAt: new Date().toISOString(), applicationVersion });
  });
}

export function captureProtection(stores: readonly Store[], applicationVersion: string): Buffer {
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(applicationVersion)) reject("备份库清单无效。");
  const { images, createdAt } = withProtectionConnections(stores, connections => ({
    createdAt: new Date().toISOString(),
    images: connections.map((db, index) => snapshot(db, layouts[index])),
  }));
  const manifest: Manifest = { formatVersion: 1, createdAt, applicationVersion,
    databases: layouts.map((layout, index) => ({
      file: layout.key + ".sqlite3",
      applicationId: layout.applicationId, schemaVersion: layout.version, schemaSha256: sha(expectedSchema(layout)),
      length: images[index].length, sha256: sha(images[index]),
      initialization: { file: layout.key + ".initialized", content: layout.marker },
    })) };
  return encodeProtection(manifest, images);
}

function encodeProtection(manifest: Manifest, images: Buffer[]): Buffer {
  const json = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  const body = Buffer.concat([magic, length, json, ...images]);
  return Buffer.concat([body, Buffer.from(sha(body), "hex")]);
}

export function validateProtection(packageBytes: Buffer): { summary: ProtectionSummary; images: Buffer[]; manifest: Manifest } {
  if (packageBytes.length > maxPackage || packageBytes.length < 64 ||
      !packageBytes.subarray(0, magic.length).equals(magic)) reject("备份包格式或长度无效。");
  const end = packageBytes.length - 32;
  if (sha(packageBytes.subarray(0, end)) !== packageBytes.subarray(end).toString("hex")) reject("备份不完整或总体 SHA-256 不匹配。");
  const manifestLength = packageBytes.readUInt32LE(magic.length);
  const start = magic.length + 4;
  if (manifestLength === 0 || manifestLength > maxManifest || start + manifestLength >= end) reject("备份清单长度无效。");
  const manifestBytes = packageBytes.subarray(start, start + manifestLength);
  let manifest: Manifest;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    manifest = JSON.parse(decoded) as Manifest;
    if (JSON.stringify(manifest) !== decoded) reject("备份清单包含非规范或重复的内容。");
  } catch { reject("备份清单无法读取。"); }
  if (!manifest || manifest.formatVersion !== 1 ||
      typeof manifest.applicationVersion !== "string" || !/^[A-Za-z0-9_.+-]{1,64}$/.test(manifest.applicationVersion) ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
      !Array.isArray(manifest.databases) || manifest.databases.length !== layouts.length) reject("备份清单版本或时间无效。");
  let offset = start + manifestLength;
  const images = layouts.map((layout, index) => {
    const entry = manifest.databases[index];
    if (!entry || entry.file !== layout.key + ".sqlite3" || entry.applicationId !== layout.applicationId ||
        entry.schemaVersion !== layout.version || entry.schemaSha256 !== sha(expectedSchema(layout)) ||
        !Number.isInteger(entry.length) || entry.length < 512 || entry.length > maxDatabase || offset + entry.length > end ||
        entry.initialization?.file !== layout.key + ".initialized" || entry.initialization.content !== layout.marker) {
      reject("缺少数据库或清单身份不匹配：" + layout.key);
    }
    const image = packageBytes.subarray(offset, offset + entry.length);
    offset += entry.length;
    if (sha(image) !== entry.sha256 || image.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        image[18] !== 1 || image[19] !== 1) reject("数据库镜像不完整或 SHA-256 不匹配：" + layout.key);
    return image;
  });
  if (offset !== end) reject("备份包含未声明的内容。");
  const dbs: DatabaseSync[] = [];
  try {
    for (const [index, image] of images.entries()) {
      const db = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
      dbs.push(db);
      db.exec("PRAGMA trusted_schema=OFF");
      db.deserialize(image);
      db.exec("PRAGMA query_only=ON");
      checkImage(db, layouts[index]);
    }
    return { summary: summary(dbs, manifest), images, manifest };
  } catch (error) {
    if (error instanceof WorkspaceFault) throw error;
    return reject("无法检查备份中的数据库内容或业务关联。");
  } finally { for (const db of dbs.reverse()) db.close(); }
}

export class ProtectionFiles {
  constructor(private readonly helper: string) {}

  private native(args: string[], input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, args, { windowsHide: true, shell: false });
      const chunks: Buffer[] = [];
      let length = 0;
      let outputOverflow = false;
      let stdinFailed = false;
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxPackage) {
          outputOverflow = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => { stdinFailed = true; });
      child.once("error", () => reject(new WorkspaceFault("failed", "Windows 文件保护组件无法启动。")));
      child.once("close", code => {
        if (code !== 0 || outputOverflow || stdinFailed) {
          reject(new WorkspaceFault("failed", "Windows 无法确认路径、文件或写入结果。请保留可能留下的文件。"));
        } else resolve(Buffer.concat(chunks, length));
      });
      child.stdin.end(input);
    });
  }

  async publish(parent: string, bytes: Buffer): Promise<ProtectionResult> {
    const verified = validateProtection(bytes);
    const leaf = "sw-backup-" + randomUUID().replaceAll("-", "");
    await this.native(["publish", parent, leaf, String(bytes.length)], bytes);
    return { ...verified.summary, location: join(parent, leaf, "workspace.swbackup") };
  }

  async read(path: string): Promise<Buffer> { return this.native(["read", path]); }

  async inspect(parent: string, name: string) {
    const wire = await this.native(["inspect", parent, name]);
    let offset = 0;
    const part = (max: number): Buffer => {
      if (offset + 4 > wire.length) return reject("恢复副本不完整。");
      const size = wire.readUInt32LE(offset);
      offset += 4;
      if (size === 0 || size > max || offset + size > wire.length) return reject("恢复副本长度不正确。");
      const bytes = wire.subarray(offset, offset + size);
      offset += size;
      return bytes;
    };
    const record = JSON.parse(part(2 * maxRecoveryEvidence).toString("utf8"));
    if (record?.format !== "sw-recovery-evidence-v1" || record.profileName !== name ||
        typeof record.packageEvidenceBase64 !== "string") reject("恢复副本缺少有效的完成记录。");
    const evidence = JSON.parse(Buffer.from(record.packageEvidenceBase64, "base64").toString("utf8"));
    const images = layouts.map(() => part(maxDatabase));
    if (offset !== wire.length) reject("恢复副本包含未声明数据。");
    const bytes = encodeProtection(evidence.manifest, images);
    const digest = sha(bytes);
    if (digest !== evidence.packageSha256) reject("恢复副本与原备份摘要不一致。");
    return { bytes, digest, summary: validateProtection(bytes).summary };
  }

  async restore(parent: string, verificationBytes: Buffer, forActivation = false): Promise<ProtectionResult & { profileName: string }> {
    // Both the integrity checks and native writes consume this one in-memory copy, never a reread of the backup path.
    const verified = validateProtection(verificationBytes);
    const name = (forActivation ? "sw-m2d-active-" : "sw-m2d-restore-") + randomUUID().replaceAll("-", "");
    const evidence = Buffer.from(JSON.stringify({
      packageSha256: sha(verificationBytes),
      manifest: verified.manifest,
    }));
    if (evidence.length > maxRecoveryEvidence) reject("恢复完成记录超出允许大小。");
    const input = Buffer.concat([evidence, ...verified.images].flatMap(bytes => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      return [length, bytes];
    }));
    await this.native([forActivation ? "activate" : "restore", parent, name], input);
    return { ...verified.summary, location: join(parent, name, "profile"), profileName: name };
  }
}
