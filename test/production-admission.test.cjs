const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkspaceDatabase } = require("../build/database.js");
const { WorkLogDatabase } = require("../build/worklog.js");
const { GrowthProfileDatabase } = require("../build/growth-profile.js");
const { IntakeStore } = require("../build/student-intake.js");
const { OperationsDatabase } = require("../build/operations.js");
const { OperationsPending } = require("../build/operations-pending.js");
const { ProtectionFiles, captureProtection, validateProtection } = require("../build/offline-protection.js");
const { provisionPrimary, prepareLegacyMigration, reviewOperationsBackup } = require("../build/production-admission.js");
const { productionRootOf, requireProductionProfile, primaryMarker } = require("../build/production-profile.js");
const { readActivation, saveActivation, verifyActiveProfile, approveActiveProfile } = require("../build/profile-activation.js");
const { DatabaseSync } = require("node:sqlite");

const native = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
const spec = { alias: "虚构学生甲", grade: "七年级", subjects: "数学", goal: "", notes: "" };
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const proof = expected => error => error.code === expected;
const root = () => mkdtempSync(join(realpathSync.native(tmpdir()), "sw-admission-"));
function fixture() {
  const parent = root();
  const target = join(parent, "Deployment");
  const source = join(parent, "M1");
  for (const path of ["Profiles/Staging", "Profiles/Synthetic", "Exports", "Logs/Crash"]) mkdirSync(join(target, path), { recursive: true });
  mkdirSync(source);
  const database = WorkspaceDatabase.open(join(source, "mvp.sqlite3"), join(source, "mvp.initialized"));
  const student = database.createStudent({ ...spec, id: randomUUID() });
  return { target, source, database, student };
}
function openFive(profile, t) {
  const data = join(profile, "data");
  const m1 = WorkspaceDatabase.open(join(data, "mvp.sqlite3"), join(data, "mvp.initialized"), 6);
  const work = WorkLogDatabase.open(join(data, "worklog.sqlite3"), join(data, "worklog.initialized"));
  const growth = GrowthProfileDatabase.open(join(data, "growth.sqlite3"), join(data, "growth.initialized"));
  const intake = IntakeStore.open(join(data, "student-intake.sqlite3"), join(data, "student-intake.initialized"));
  const ops = OperationsDatabase.open(data, m1);
  const stores = [m1, work, growth, intake, ops];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const store of [...stores].reverse()) store.close();
  };
  t.after(close);
  return { m1, ops, stores, close };
}

test("only fixed versioned EXE paths select production admission", () => {
  const app = ["App", "Versions", "a".repeat(40), "SupervisorWorkspace-MVP.exe"];
  const formal = "D:\\SupervisorWorkspace";
  const rehearsal = "D:\\Codex-Development\\Builds\\sw-production-admission-" + "d".repeat(32);
  assert.equal(productionRootOf(join(formal, ...app)), formal);
  assert.equal(productionRootOf(join(rehearsal, ...app)), rehearsal);
  for (const other of ["D:\\Codex-Development\\Temp", "C:\\SupervisorWorkspace", join(formal, "Profiles", "Synthetic")]) {
    assert.equal(productionRootOf(join(other, ...app)), undefined);
  }
  assert.equal(productionRootOf(join(formal, "App", "SupervisorWorkspace-MVP.exe")), undefined);
});

test("native legacy capture refuses a live writer, unexpected sidecars and mismatched markers", async () => {
  const { source, database, target } = fixture();
  try {
    await assert.rejects(prepareLegacyMigration(target, source, native), proof("failed"));
  } finally { database.close(); }
  const db = join(source, "mvp.sqlite3");
  const before = digest(db);
  const sidecar = db + "-wal";
  writeFileSync(sidecar, "synthetic leftover");
  await assert.rejects(prepareLegacyMigration(target, source, native), proof("failed"));
  assert.equal(readFileSync(sidecar, "utf8"), "synthetic leftover");
  unlinkSync(sidecar);
  writeFileSync(join(source, "mvp.initialized"), "mvp-v2\n");
  await assert.rejects(prepareLegacyMigration(target, source, native), proof("failed"));
  assert.equal(digest(db), before);
  assert(!existsSync(join(target, "Profiles", "Primary")));
  assert.deepEqual(readdirSync(join(target, "Exports")), []);
});

test("native backup reads preserve all bytes through a backpressured Windows pipe", async () => {
  const input = join(root(), "synthetic.swbackup");
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) bytes.writeUInt32LE(i, i);
  writeFileSync(input, bytes);
  const helper = spawn(join(__dirname, "../build/recovery-io.exe"), ["read", input], { windowsHide: true });
  const done = once(helper, "close");
  helper.stderr.resume();
  await delay(200);
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of helper.stdout) {
    received += chunk.length;
    hash.update(chunk);
  }
  assert.deepEqual(await done, [0, null]);
  assert.equal(received, bytes.length);
  assert.equal(hash.digest("hex"), digest(input));
});

test("legacy v1 migration preserves the original, publishes verified packages, and admits only a fresh v6 five-store Primary", async t => {
  const { source, database, student, target } = fixture();
  database.addLesson({ id: randomUUID(), studentId: student.id, date: "2026-11-18", subject: "数学",
    task: "合成练习", completion: "合成完成", assessment: "", nextStep: "" });
  database.close();
  const sourceName = join(source, "mvp.sqlite3");
  const before = digest(sourceName);
  const result = await prepareLegacyMigration(target, source, native);
  assert.equal(result.sourceSha256, before);
  assert.equal(result.legacyBackup.formatVersion, 1);
  assert.equal(result.candidate.formatVersion, 2);
  assert(result.candidate.upgradedFromFour && result.candidate.upgradedM1);
  assert.equal(result.candidate.m1Version, 6);
  assert.equal(result.candidate.attendancePlans, 0);
  const originalPackage = digest(result.legacyBackup.location);
  await assert.rejects(provisionPrimary(target, result.candidate.location, "0".repeat(64), native), /摘要/);
  await assert.rejects(provisionPrimary(target, result.legacyBackup.location, originalPackage, native), /SWBACK2/);
  assert.throws(() => requireProductionProfile(target), proof("recovery"));
  assert(!existsSync(join(target, "Profiles", "Primary")));
  const provisioned = await provisionPrimary(target, result.candidate.location, result.activationSha256, native);
  assert.equal(digest(provisioned.independentBackup), result.activationSha256);
  const { owner, profile } = requireProductionProfile(target);
  await assert.rejects(provisionPrimary(target, result.candidate.location, result.activationSha256, native), proof("conflict"));
  assert.equal(readActivation(owner, true).active, null);
  assert.throws(() => WorkspaceDatabase.open(join(profile, "data", "mvp.sqlite3"),
    join(profile, "data", "mvp.initialized")), proof("recovery"));
  const first = openFive(profile, t);
  assert.deepEqual(first.m1.students().map(row => row.id), [student.id]);
  assert.equal(first.m1.history(student.id).length, 1);
  const newer = first.m1.createStudent({ ...spec, id: randomUUID(), alias: "虚构学生乙" });
  const backup = await native.publish(join(target, "Exports"), captureProtection(first.stores, "0.1.0", 2, 6));
  first.close();
  assert.equal(digest(sourceName), before);
  assert.equal(digest(result.legacyBackup.location), originalPackage);
  assert(openFive(profile, t).m1.students().some(row => row.id === newer.id));

  const restored = await native.restore(owner, await native.read(backup.location), true);
  const selection = { name: restored.profileName, digest: digest(backup.location) };
  const newPath = verifyActiveProfile(owner, selection, true, 2, 6);
  const reopened = openFive(newPath, t);
  assert(reopened.m1.students().some(row => row.id === newer.id));
  approveActiveProfile(newPath, selection.digest);
  saveActivation(owner, { version: 1, active: selection, pending: null });
  assert.equal(verifyActiveProfile(owner, readActivation(owner, true).active, false, 2, 6), newPath);
  assert.equal(validateProtection(await native.read(backup.location)).summary.students, 2);
});

test("ordinary admission keeps invalid or incomplete Primary on disk and does not create a missing store", async () => {
  const { database, source, target } = fixture();
  database.close();
  const result = await prepareLegacyMigration(target, source, native);
  await provisionPrimary(target, result.candidate.location, result.activationSha256, native);
  const { owner, profile } = requireProductionProfile(target);
  const stamp = join(owner, primaryMarker);
  writeFileSync(stamp, "{}");
  assert.throws(() => requireProductionProfile(target), proof("recovery"));
  writeFileSync(stamp, JSON.stringify({ version: "production-primary-v1", backupSha256: result.activationSha256 }));
  const activeStore = join(profile, "data", "worklog.sqlite3");
  renameSync(activeStore, join(owner, "worklog.fixture-held"));
  assert.throws(() => requireProductionProfile(target), proof("recovery"));
  assert(!existsSync(activeStore));
  unlinkSync(join(owner, "profile-selection.initialized"));
  unlinkSync(join(owner, "profile-selection-v1.json"));
  assert.throws(() => readActivation(owner, true), proof("recovery"));
  assert.throws(() => saveActivation(owner, { version: 1, active: null, pending: null }, true), proof("recovery"));
  assert(!existsSync(join(owner, "profile-selection-v1.json")));
});

test("missing operation descriptors stop further writes and verified recovery reflects only committed transactions", async t => {
  const { database, student, source, target } = fixture();
  database.close();
  const migration = await prepareLegacyMigration(target, source, native);
  await provisionPrimary(target, migration.candidate.location, migration.activationSha256, native);
  const { owner, profile } = requireProductionProfile(target);
  const f = openFive(profile, t);
  const request = () => ({
    command: "saveAttendancePlan", requestId: randomUUID(), id: randomUUID(), studentId: student.id,
    expectedRevision: 0, startAt: Math.ceil(Date.now() / 60000) * 60000 + 86400000,
    exception: { confirmed: true, reason: "合成核对" },
  });
  const journal = new OperationsPending(profile);
  const committed = request();
  journal.begin(committed);
  f.ops.saveAttendancePlan(committed);
  journal.acknowledge(committed.requestId, false, () => ({ revision: 1 }));
  const unknown = request();
  journal.begin(unknown);
  for (const name of ["operations-request.pending", "operations-request.json"]) unlinkSync(join(profile, name));
  const reopenedJournal = new OperationsPending(profile);
  assert.deepEqual(reopenedJournal.state(), { kind: "damaged" });
  assert.throws(() => reopenedJournal.begin(unknown), proof("recovery"));
  assert.throws(() => reopenedJournal.acknowledge(unknown.requestId, true, () => null), proof("recovery"));
  const backup = await native.publish(join(target, "Exports"), captureProtection(f.stores, "0.1.0", 2, 6));
  const review = await reviewOperationsBackup(backup.location, native);
  assert.equal(review.receipts.length, 1);
  assert.equal(review.receipts[0].request_id, committed.requestId);
  assert.equal(review.receipts[0].student_id, student.id);
  const recovered = await native.restore(owner, await native.read(backup.location), true);
  assert.deepEqual(new OperationsPending(recovered.location).state(), { kind: "empty" });
  const selected = openFive(recovered.location, t);
  const db = new DatabaseSync(join(recovered.location, "data", "operations.sqlite3"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM attendance_plans").get().n, 1);
    assert.equal(db.prepare("SELECT request_id FROM operation_requests").get().request_id, committed.requestId);
  } finally { db.close(); }
  const afterCommit = { ...request(), startAt: committed.startAt + 7 * 86400000 };
  const restoredJournal = new OperationsPending(recovered.location);
  restoredJournal.begin(afterCommit);
  selected.ops.saveAttendancePlan(afterCommit);
  for (const name of ["operations-request.pending", "operations-request.json"]) unlinkSync(join(recovered.location, name));
  assert.throws(() => new OperationsPending(recovered.location).begin(afterCommit), proof("recovery"));
  const next = await native.publish(join(target, "Exports"), captureProtection(selected.stores, "0.1.0", 2, 6));
  const reviewed = await reviewOperationsBackup(next.location, native);
  assert.deepEqual(new Set(reviewed.receipts.map(row => row.request_id)), new Set([committed.requestId, afterCommit.requestId]));
  assert.equal(new OperationsPending(profile).state().kind, "damaged");
});
