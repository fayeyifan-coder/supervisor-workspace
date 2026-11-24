import { createHash, randomUUID } from "node:crypto";
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceDatabase, WorkspaceFault } from "./database";
import { closeStoresIndependently } from "./database-lifecycle";
import { GrowthProfileDatabase } from "./growth-profile";
import { captureProtection, prepareProtectionRestore, ProtectionFiles, validateProtection } from "./offline-protection";
import { saveActivation, verifyActiveProfile, verifyProfileData } from "./profile-activation";
import { createLocalDirectory, isWithin, primaryMarker, productionLayout, productionRootOf,
  requireLocalDirectory, sha256Pattern } from "./production-profile";
import { IntakeStore } from "./student-intake";
import { WorkLogDatabase } from "./worklog";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const workArea = (root: string) => join(root, "Profiles", "Staging");
const stageName = () => randomUUID().replaceAll("-", "");

export async function prepareLegacyMigration(root: string, source: string, files: ProtectionFiles) {
  const { exports } = productionLayout(root);
  requireLocalDirectory(exports);
  if (isWithin(root, source)) throw new WorkspaceFault("invalid", "旧 M1 来源必须位于新安装档案之外。");
  const original = await files.readLegacy(source);
  const stage = join(workArea(root), "legacy-" + stageName());
  createLocalDirectory(stage);
  const m1Name = join(stage, "mvp.sqlite3");
  const m1Marker = join(stage, "mvp.initialized");
  writeFileSync(m1Name, original, { flag: "wx", flush: true });
  writeFileSync(m1Marker, "mvp-v1\n", { flag: "wx", flush: true });
  const stores: { close(): void }[] = [];
  let legacy: Buffer;
  try {
    const m1 = WorkspaceDatabase.open(m1Name, m1Marker);
    stores.push(m1);
    const work = WorkLogDatabase.open(join(stage, "worklog.sqlite3"), join(stage, "worklog.initialized"));
    stores.push(work);
    const growth = GrowthProfileDatabase.open(join(stage, "growth.sqlite3"), join(stage, "growth.initialized"));
    stores.push(growth);
    const intake = IntakeStore.open(join(stage, "student-intake.sqlite3"), join(stage, "student-intake.initialized"));
    stores.push(intake);
    legacy = captureProtection([m1, work, growth, intake], "legacy-m1", 1, 1);
  } finally {
    if (closeStoresIndependently(...stores.reverse().map(store => () => store.close())).length > 0) {
      throw new WorkspaceFault("recovery", "迁移暂存库无法关闭。请保留原档案和暂存资料。");
    }
  }
  const legacyBackup = await files.publish(exports, legacy);
  const upgraded = prepareProtectionRestore(legacy, 2, 6);
  const candidate = await files.publish(exports, upgraded);
  return { sourceSha256: hash(original), legacyBackup, candidate, activationSha256: hash(upgraded) };
}

export async function provisionPrimary(root: string, backup: string, expectedSha256: string, files: ProtectionFiles) {
  const { owner, logs, exports } = productionLayout(root);
  if (lstatSync(owner, { throwIfNoEntry: false })) {
    throw new WorkspaceFault("conflict", "正式档案已存在。请使用应用内的独立恢复入口。");
  }
  requireLocalDirectory(exports);
  requireLocalDirectory(join(logs, "Crash"));
  const bytes = await files.read(backup);
  const digest = hash(bytes);
  if (!sha256Pattern.test(expectedSha256) || digest !== expectedSha256) {
    throw new WorkspaceFault("invalid", "待激活备份摘要与人工核验结果不符。");
  }
  const { summary } = validateProtection(bytes);
  if (summary.formatVersion !== 2 || summary.m1Version !== 6) {
    throw new WorkspaceFault("invalid", "正式初始化需要经过校验的 SWBACK2 / M1 v6 备份。");
  }
  // Leave the selected package and a second durable export intact even if preflight stops.
  const independent = await files.publish(exports, bytes);
  const stage = join(workArea(root), "primary-" + stageName());
  createLocalDirectory(stage);
  const prepared = await files.restore(stage, bytes, true);
  const readback = await files.inspect(stage, prepared.profileName, 2, 6, "activation");
  if (readback.digest !== digest) throw new WorkspaceFault("recovery", "待启用档案的读回摘要与备份不一致。");
  const checked = verifyActiveProfile(stage, { name: prepared.profileName, digest }, true, 2, 6);
  const primary = join(stage, "Primary");
  createLocalDirectory(primary);
  const profile = join(primary, "profile");
  createLocalDirectory(profile);
  createLocalDirectory(join(profile, "chromium"));
  renameSync(join(checked, "restore.ready"), join(stage, "provision.evidence"));
  renameSync(join(checked, "data"), join(profile, "data"));
  verifyProfileData(profile, true, 2, 6);
  saveActivation(primary, { version: 1, active: null, pending: null });
  writeFileSync(join(primary, primaryMarker), JSON.stringify({
    version: "production-primary-v1", backupSha256: digest,
  }), { flag: "wx", flush: true });

  // Publish only the complete new directory. Windows rejects a rename onto an existing directory.
  requireLocalDirectory(dirname(owner));
  if (lstatSync(owner, { throwIfNoEntry: false })) throw new WorkspaceFault("conflict", "正式档案已存在。");
  renameSync(primary, owner);
  return { location: owner, independentBackup: independent.location, backupSha256: digest, summary };
}

export async function reviewOperationsBackup(backup: string, files: ProtectionFiles) {
  const bytes = await files.read(backup);
  const { images, summary } = validateProtection(bytes);
  if (summary.formatVersion !== 2) throw new WorkspaceFault("invalid", "核对教务需要 SWBACK2 备份。");
  const db = new DatabaseSync(":memory:", { allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    db.deserialize(images[4]);
    db.exec("PRAGMA query_only=ON");
    const receipts = db.prepare(`SELECT r.request_id, r.command, c.student_id, c.entity_kind, c.entity_id,
      c.revision, c.changed_at FROM operation_requests r JOIN operation_changes c USING (request_id)
      ORDER BY c.changed_at DESC, r.request_id LIMIT 501`).all();
    return { backupSha256: hash(bytes), summary, receipts: receipts.slice(0, 500), truncated: receipts.length > 500 };
  } finally { db.close(); }
}

export async function runProductionCommand(executable: string, command: string, input: string, expectedDigest: string) {
  const root = productionRootOf(executable);
  if (!root) throw new WorkspaceFault("invalid", "请从受控的版本化安装目录运行部署工具。");
  requireLocalDirectory(dirname(executable));
  const path = resolve(input);
  const helper = join(dirname(executable), "resources", "recovery-io.exe");
  const files = new ProtectionFiles(helper);
  if (command === "prepare-legacy") return prepareLegacyMigration(root, path, files);
  if (command === "activate-primary") return provisionPrimary(root, path, expectedDigest, files);
  if (command === "review-operations") return reviewOperationsBackup(path, files);
  throw new WorkspaceFault("invalid", "未知的部署操作。");
}
