const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { test } = require("node:test");
const { exportFixture } = require("./export-fixture.cjs");
const { WorkspaceDatabase } = require("../build/database.js");
const { captureProtection, prepareProtectionRestore, ProtectionFiles, validateProtection } = require("../build/offline-protection.js");
const { businessExportDocument } = require("../build/business-export.js");
const { StudentWriteRecovery } = require("../build/student-write-recovery.js");

test("an older backup upgrades on a copy; pause, archive and restore preserve all associated records", async t => {
  const previous = exportFixture(t, 20, 7);
  const original = previous.capture();
  const restore = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
  const migrated = prepareProtectionRestore(original, 2, 8);
  const pre = validateProtection(original);
  const post = validateProtection(migrated);
  assert.deepEqual(post.images.slice(1), pre.images.slice(1));
  const active = await restore.restore(previous.dir, migrated, true);
  const dir = join(active.location, "data");
  const db = WorkspaceDatabase.open(join(dir, "mvp.sqlite3"), join(dir, "mvp.initialized"), 8);
  t.after(() => db.close());
  const studentId = previous.studentId;
  assert.equal(db.students().length, 20);
  assert(db.students().every(student => student.lifecycleStatus === "active"));
  assert.deepEqual(db.studentLifecycle(studentId), { studentId, status: "active", revision: 0, history: [] });
  const next = (status, expectedRevision, reason = "合成跟进记录") =>
    ({ studentId, requestId: randomUUID(), expectedRevision, status, reason });
  assert.throws(() => db.saveStudentLifecycle(next("paused", 0, " ")), /原因/);
  assert.throws(() => db.saveStudentLifecycle(next("active", 0)), /不同/);
  assert.throws(() => db.saveStudentLifecycle(next("archived", 3)), /更新/);
  const pending = new StudentWriteRecovery(active.location);
  const input = next("paused", 0);
  const command = db.studentWriteCommand("lifecycle", input);
  const first = pending.run(db, command, () => db.saveStudentLifecycle(command.input));
  assert.equal(new StudentWriteRecovery(active.location).state(db).outcome, "saved");
  assert.deepEqual(db.saveStudentLifecycle(input), first);
  assert.throws(() => db.saveStudentLifecycle({ ...input, reason: "合成不同原因" }), /请求编号/);
  pending.resolve(db, "confirm", input.requestId);
  const archive = db.saveStudentLifecycle(next("archived", 1));
  assert.equal(db.students().find(row => row.id === studentId).lifecycleStatus, "archived");
  const restoredStatus = db.saveStudentLifecycle(next("active", 2));
  assert.deepEqual(db.studentLifecycle(studentId).history, [restoredStatus, archive, first]);
  assert.equal(db.students().find(row => row.id === studentId).lifecycleStatus, "active");

  const bytes = captureProtection([db, ...previous.stores.slice(1)], "0.2.3", 2, 8);
  assert.throws(() => prepareProtectionRestore(bytes, 2, 7), /不能降级/);
  assert.throws(() => prepareProtectionRestore(bytes, 2, 6), /不能降级/);
  const baseline = businessExportDocument(original, false);
  const updated = businessExportDocument(bytes, false);
  for (const table of baseline.tables) assert.deepEqual(updated.tables.find(item => item.table === table.table), table);
  const history = updated.tables.find(table => table.table === "student_lifecycle");
  assert.equal(history.exportedRows, 3);
  assert.equal(history.historicalRows, 3);
  assert(history.rows.every(row => row.student_id === studentId));
  assert.deepEqual(new Set(history.rows.map(row => row.status)), new Set(["active", "paused", "archived"]));
  const backup = await restore.restore(previous.dir, bytes);
  assert.equal((await restore.inspect(previous.dir, backup.profileName, 2, 8)).summary.students, 20);
  assert.equal(previous.m1.students()[0].lifecycleStatus, undefined);
});

test("a foreign student or altered lifecycle chain cannot pass full backup validation", t => {
  const f = exportFixture(t, 1, 8);
  assert.throws(() => f.m1.saveStudentLifecycle({ studentId: randomUUID(), requestId: randomUUID(),
    expectedRevision: 0, status: "paused", reason: "合成" }), /找不到/);
  f.m1.protectionConnection().prepare("INSERT INTO student_lifecycle VALUES (?,?,2,'active','paused','合成断链',?)")
    .run(randomUUID(), f.studentId, Date.now());
  assert.throws(() => f.capture(), /不连续/);
});
