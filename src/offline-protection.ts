import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { m1Protection, m1EditProtection, verifyStudentEdits, WorkspaceFault, type M1Version } from "./database";
import { growthProtection } from "./growth-profile";
import { intakeProtection, intakeSourceDigest } from "./student-intake";
import { parseIntake } from "./intake-format";
import { worklogProtection } from "./worklog";

import { operationsProtection, verifyOperationsStudentLinks } from "./operations-schema";

const fourLayouts = [m1Protection, worklogProtection, growthProtection, intakeProtection] as const;
const fiveLayouts = [...fourLayouts, operationsProtection] as const;
export type ProtectionFormat = 1 | 2;
function layoutsFor(format: ProtectionFormat, m1Version: M1Version = 1) {
  if (m1Version === 2) {
    if (format !== 2) reject("新版学生档案只支持五库备份。");
    return [m1EditProtection, worklogProtection, growthProtection, intakeProtection, operationsProtection];
  }
  return format === 2 ? fiveLayouts : fourLayouts;
}
const magic = Buffer.from("SWBACK1\n");
const fiveMagic = Buffer.from("SWBACK2\n");
const maxDatabase = 32 * 1024 * 1024;
const maxPackage = 161 * 1024 * 1024;
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
  integrity?: "ok";
}
export interface ProtectionSummary {
  formatVersion: ProtectionFormat;
  m1Version: M1Version;
  upgradedM1?: true;
  attendancePlans?: number;
  learningBlocks?: number;
  learningTasks?: number;
  upgradedFromFour?: true;
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
  formatVersion: ProtectionFormat;
  upgradedFrom?: string;
  m1UpgradedFrom?: string;
  createdAt: string;
  applicationVersion: string;
  databases: ManifestDatabase[];
}
type Layout = (typeof fiveLayouts)[number];
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
  if (layout.key === "mvp" && layout.version === 2) verifyStudentEdits(db);
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
function summary(dbs: DatabaseSync[], manifest: Omit<Manifest, "databases">): ProtectionSummary {
  const [m1, work, growth, intake, operations] = dbs;
  const students = new Set(m1.prepare("SELECT id FROM students").all().map(x => String(x.id)));
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
  if (operations) {
    verifyOperationsStudentLinks(operations, students);
    if (manifest.upgradedFrom && operationsProtection.tables.some(table => count(operations, table) !== 0)) {
      reject("从四库备份升级的教务库必须为空。");
    }
  }
  if (manifest.m1UpgradedFrom && (count(m1, "student_edits") !== 0 || count(m1, "student_edit_pending") !== 0)) {
    reject("从 M1 v1 升级的编辑历史与待核对请求必须为空。");
  }
  return { createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion,
    formatVersion: manifest.formatVersion, m1Version: m1.prepare("PRAGMA user_version").get()?.user_version === 2 ? 2 : 1,
    ...(manifest.m1UpgradedFrom ? { upgradedM1: true as const } : {}),
    ...(manifest.upgradedFrom ? { upgradedFromFour: true as const } : {}),
    ...(operations ? { attendancePlans: count(operations, "attendance_plans"),
      learningBlocks: count(operations, "learning_blocks"), learningTasks: count(operations, "learning_tasks") } : {}),
    students: students.size, workItems: count(work, "work_items"), growthProfiles: count(growth, "growth_profiles"),
    intakeBindings: imported.size, unfinishedImports };
}

function withProtectionConnections<T>(stores: readonly Store[], format: ProtectionFormat, operation: (connections: DatabaseSync[]) => T): T {
  if (stores.length !== layoutsFor(format).length) reject("备份库清单无效。");
  const connections = stores.map(store => store.protectionConnection());
  if (new Set(connections).size !== connections.length) reject("备份库连接重复。");
  const locked: DatabaseSync[] = [];
  try {
    // All application writes run synchronously in the main process. IMMEDIATE also excludes separate SQLite writers.
    for (const connection of connections) {
      if (connection.isTransaction) throw new WorkspaceFault("busy", "数据库正在写入，未生成备份。");
      try { connection.exec("BEGIN IMMEDIATE"); }
      catch (error) {
        if (connection.isTransaction) locked.push(connection);
        throw error;
      }
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

export function verifyProtectionStores(stores: readonly Store[], applicationVersion: string, format: ProtectionFormat = 1, m1Version: M1Version = 1): void {
  const layouts = layoutsFor(format, m1Version);
  withProtectionConnections(stores, format, connections => {
    connections.forEach((db, index) => checkImage(db, layouts[index]));
    summary(connections, { createdAt: new Date().toISOString(), applicationVersion, formatVersion: format });
  });
}

export function captureProtection(stores: readonly Store[], applicationVersion: string, format: ProtectionFormat = 1, m1Version: M1Version = 1): Buffer {
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(applicationVersion)) reject("备份库清单无效。");
  const layouts = layoutsFor(format, m1Version);
  const { images, createdAt } = withProtectionConnections(stores, format, connections => {
    const createdAt = new Date().toISOString();
    const images = connections.map((db, index) => snapshot(db, layouts[index]));
    if (format === 2) summary(connections, { createdAt, applicationVersion, formatVersion: format });
    return { images, createdAt };
  });
  return encodeProtection({ formatVersion: format, createdAt, applicationVersion,
    databases: layouts.map((layout, index) => manifestDatabase(layout, images[index], format)) }, images);
}

function manifestDatabase(layout: Layout, image: Buffer, format: ProtectionFormat): ManifestDatabase {
  return {
    file: layout.key + ".sqlite3",
    applicationId: layout.applicationId, schemaVersion: layout.version, schemaSha256: sha(expectedSchema(layout)),
    length: image.length, sha256: sha(image),
    initialization: { file: layout.key + ".initialized", content: layout.marker },
    ...(format === 2 ? { integrity: "ok" as const } : {}),
  };
}

export function prepareProtectionRestore(bytes: Buffer, format: ProtectionFormat, m1Version: M1Version = 1): Buffer {
  const { manifest, images } = validateProtection(bytes);
  const sourceVersion = manifest.databases[0].schemaVersion;
  layoutsFor(format, m1Version);
  if (sourceVersion > m1Version) reject("备份中的学生档案版本较新，不能降级恢复。");
  if (manifest.formatVersion === format && sourceVersion === m1Version) return bytes;
  if (format === 1) reject("五库备份需要支持教务库的隔离环境，未写入任何恢复文件。");
  const nextManifest: Manifest = { ...manifest, formatVersion: format,
    databases: manifest.databases.map(entry => ({ ...entry, integrity: "ok" })) };
  const nextImages = [...images];
  const sourceDigest = sha(bytes);
  if (sourceVersion === 1 && m1Version === 2) {
    const m1 = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      m1.exec("PRAGMA trusted_schema=OFF");
      m1.deserialize(Buffer.from(images[0]));
      for (const ddl of m1EditProtection.ddl.slice(m1Protection.ddl.length)) m1.exec(ddl);
      m1.exec("PRAGMA user_version=2");
      const upgraded = snapshot(m1, m1EditProtection);
      nextImages[0] = upgraded;
      nextManifest.databases[0] = manifestDatabase(m1EditProtection, upgraded, 2);
      nextManifest.m1UpgradedFrom = sourceDigest;
    } finally { m1.close(); }
  }

  if (manifest.formatVersion === 1) {
    const db = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      for (const ddl of operationsProtection.ddl) db.exec(ddl);
      db.exec(`PRAGMA application_id=${operationsProtection.applicationId}; PRAGMA user_version=${operationsProtection.version}`);
      const empty = snapshot(db, operationsProtection);
      nextImages.push(empty);
      nextManifest.databases.push(manifestDatabase(operationsProtection, empty, 2));
      nextManifest.upgradedFrom = sourceDigest;
    } finally { db.close(); }
  }
  const upgraded = encodeProtection(nextManifest, nextImages);
  validateProtection(upgraded);
  return upgraded;
}

function encodeProtection(manifest: Manifest, images: Buffer[]): Buffer {
  const json = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  const body = Buffer.concat([manifest.formatVersion === 2 ? fiveMagic : magic, length, json, ...images]);
  return Buffer.concat([body, Buffer.from(sha(body), "hex")]);
}

export function validateProtection(packageBytes: Buffer): { summary: ProtectionSummary; images: Buffer[]; manifest: Manifest } {
  const header = packageBytes.subarray(0, magic.length);
  const format: ProtectionFormat = header.equals(fiveMagic) ? 2 : 1;
  if (packageBytes.length > (format === 2 ? maxPackage : 129 * 1024 * 1024) || packageBytes.length < 64 ||
      (format === 1 && !header.equals(magic))) reject("备份包格式或长度无效。");
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
  if (!manifest || manifest.formatVersion !== format ||
      (manifest.upgradedFrom !== undefined && (format !== 2 || typeof manifest.upgradedFrom !== "string" ||
        !/^[a-f0-9]{64}$/.test(manifest.upgradedFrom))) ||
      typeof manifest.applicationVersion !== "string" || !/^[A-Za-z0-9_.+-]{1,64}$/.test(manifest.applicationVersion) ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
      !Array.isArray(manifest.databases) || manifest.databases.length !== layoutsFor(format).length) reject("备份清单版本或时间无效。");
  const m1Version = manifest.databases[0]?.schemaVersion;
  if (m1Version !== 1 && m1Version !== 2) reject("备份中的学生档案版本不受支持。");
  if (manifest.m1UpgradedFrom !== undefined && (m1Version !== 2 || typeof manifest.m1UpgradedFrom !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.m1UpgradedFrom))) reject("新版学生档案的来源摘要无效。");
  const layouts = layoutsFor(format, m1Version);
  let offset = start + manifestLength;
  const images = layouts.map((layout, index) => {
    const entry = manifest.databases[index];
    if (!entry || entry.file !== layout.key + ".sqlite3" || entry.applicationId !== layout.applicationId ||
        entry.schemaVersion !== layout.version || entry.schemaSha256 !== sha(expectedSchema(layout)) ||
        (format === 2 && entry.integrity !== "ok") ||
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

  async inspect(parent: string, name: string, format: ProtectionFormat = 1, m1Version: M1Version = 1) {
    const wire = await this.native(["inspect", parent, name, String(format), String(m1Version)]);
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
    if (evidence.manifest?.formatVersion !== format || evidence.manifest?.databases?.[0]?.schemaVersion !== m1Version) {
      reject("恢复副本与当前库清单不兼容。");
    }
    const images = layoutsFor(format, m1Version).map(() => part(maxDatabase));
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
    await this.native([forActivation ? "activate" : "restore", parent, name, String(verified.manifest.formatVersion),
      String(verified.summary.m1Version)], input);
    return { ...verified.summary, location: join(parent, name, "profile"), profileName: name };
  }
}
