const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { test } = require("node:test");
const { exportFixture } = require("./export-fixture.cjs");
const { WorkspaceDatabase } = require("../build/database.js");
const { OperationsDatabase } = require("../build/operations.js");
const { captureProtection, prepareProtectionRestore, ProtectionFiles, validateProtection } = require("../build/offline-protection.js");
const { businessExportDocument } = require("../build/business-export.js");
const { shanghaiMinute } = require("../build/schedule-calendar.js");

function rule(studentId, slots, extra = {}) {
  return { action: "rule", requestId: randomUUID(), id: randomUUID(), studentId, expectedRevision: 0,
    definition: { kind: "long_term", startsOn: "2030-01-01", endsOn: null, paused: false, slots, ...extra } };
}
const createSlot = (day, start, end) => ({ id: randomUUID(), day, start, end });
const generate = (operations, from, to, studentId) => operations.changeCycleSchedule({ action: "generate", from, to, studentId }).result;

test("20 students can share slots; two daily sessions are independent and repeated generation stays idempotent after recovery", async t => {
  const f = exportFixture(t, 20, 9);
  const students = f.m1.students();
  for (const student of students) {
    const request = rule(student.id, [createSlot(2, "09:00", "11:00"), createSlot(2, "16:20", "18:20")]);
    const original = f.operations.changeCycleSchedule(request).rule;
    assert.deepEqual(f.operations.changeCycleSchedule(request).rule, original);
  }
  assert.throws(() => f.operations.changeCycleSchedule(rule(students[0].id, [createSlot(2, "09:30", "10:00")])), /重叠/);
  assert.throws(() => f.operations.changeCycleSchedule(rule(students[0].id, [createSlot(3, "09:30", "10:00"), createSlot(3, "09:45", "10:45")])), /重叠/);
  assert.throws(() => generate(f.operations, "2030-01-01", "2030-02-01"), /31/);
  assert.deepEqual(generate(f.operations, "2030-01-01", "2030-01-01"), { created: 40, existing: 0, inactive: 0, conflicts: 0, elapsed: 0 });
  const plans = f.operations.listAttendancePlans(shanghaiMinute("2030-01-01", "00:00"), shanghaiMinute("2030-01-02", "00:00"));
  assert.equal(plans.length, 40);
  assert(plans.every(plan => plan.cycleKind === "long_term" && plan.cycleOrigin.date === "2030-01-01" && plan.checkInAt === null));
  assert.equal(generate(f.operations, "2030-01-01", "2030-01-01").existing, 40);
  const snapshot = f.capture();
  const io = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
  const restored = await io.restore(f.dir, snapshot, true);
  const data = join(restored.location, "data");
  const m1 = WorkspaceDatabase.open(join(data, "mvp.sqlite3"), join(data, "mvp.initialized"), 9);
  const operations = OperationsDatabase.open(data, m1);
  t.after(() => { operations.close(); m1.close(); });
  assert.equal(generate(operations, "2030-01-01", "2030-01-01").existing, 40);
  assert.deepEqual(operations.attendancePlan(plans[0].id), plans[0]);
  const document = businessExportDocument(snapshot, false);
  assert.equal(document.tables.length, 28);
  assert.equal(document.tables.find(row => row.table === "schedule_origins").exportedRows, 40);
  assert.equal(document.tables.find(row => row.table === "schedule_rule_revisions").exportedRows, 20);
});

test("rule changes, pause, archive and hours keep previously generated identities and respect Shanghai dates", t => {
  const f = exportFixture(t, 1, 9), { studentId } = f;
  const request = rule(studentId, [createSlot(2, "09:00", "10:00")], { kind: "fixed", startsOn: "2030-01-01", endsOn: "2030-01-29" });
  const original = f.operations.changeCycleSchedule(request).rule;
  assert.equal(generate(f.operations, "2030-01-01", "2030-01-01").created, 1);
  const originalPlan = f.operations.listAttendancePlans(shanghaiMinute("2030-01-01", "00:00"), shanghaiMinute("2030-01-02", "00:00"))[0];
  let revision = original.revision;
  const update = fields => {
    const response = f.operations.changeCycleSchedule({ ...request, expectedRevision: revision, requestId: randomUUID(),
      definition: { ...request.definition, ...fields } }).rule;
    revision = response.revision;
  };
  update({ slots: [{ ...request.definition.slots[0], start: "10:00", end: "11:00" }] });
  assert.equal(generate(f.operations, "2030-01-01", "2030-01-01").existing, 1);
  assert.deepEqual(f.operations.attendancePlan(originalPlan.id), originalPlan);
  update({ paused: true });
  assert.equal(generate(f.operations, "2030-01-08", "2030-01-08").inactive, 1);
  update({ paused: false });
  f.m1.saveStudentLifecycle({ studentId, requestId: randomUUID(), expectedRevision: 0, status: "archived", reason: "合成归档" });
  assert.equal(generate(f.operations, "2030-01-08", "2030-01-08").inactive, 1);
  f.m1.saveStudentLifecycle({ studentId, requestId: randomUUID(), expectedRevision: 1, status: "active", reason: "合成恢复" });
  assert.equal(generate(f.operations, "2030-01-08", "2030-01-08").created, 1);
  const hours = f.operations.scheduleConfiguration().hours;
  assert.deepEqual(hours[1], []);
  assert.deepEqual(hours[2].map(window => window.start), ["09:00", "16:00"]);
  hours[2] = [];
  const setting = { action: "hours", requestId: randomUUID(), expectedRevision: 0, hours };
  assert.equal(f.operations.changeCycleSchedule(setting).revision, 1);
  assert.equal(f.operations.changeCycleSchedule(setting).revision, 1);
  assert.equal(generate(f.operations, "2030-01-15", "2030-01-15").conflicts, 1);
  assert.equal(generate(f.operations, "2030-02-05", "2030-02-05").created, 0);
  assert.equal(f.operations.scheduleConfiguration().rules.length, 4);
  assert.deepEqual(f.operations.attendancePlan(originalPlan.id), originalPlan);
});

test("SWBACK2 upgrades v8 to v9 as an independent copy and retains prior teach-and-attendance content", t => {
  const f = exportFixture(t, 1, 8);
  const original = f.capture();
  const upgraded = prepareProtectionRestore(original, 2, 9);
  const v8 = validateProtection(original), v9 = validateProtection(upgraded);
  assert.equal(v9.summary.m1Version, 9);
  assert.equal(v9.manifest.databases[4].schemaVersion, 2);
  assert.deepEqual(v9.images.slice(1, 4), v8.images.slice(1, 4));
  const previous = businessExportDocument(original, false), output = businessExportDocument(upgraded, false);
  assert.deepEqual(output.tables.filter(row => previous.tables.some(item => item.table === row.table)), previous.tables);
  assert(output.tables.filter(row => row.table.startsWith("schedule_")).every(row => row.sourceRows === 0));
  assert.throws(() => prepareProtectionRestore(upgraded, 2, 8), /不能降级/);
});

test("abrupt termination between generated appointments retries exactly the missing plan", async t => {
  const f = exportFixture(t, 1, 9);
  f.operations.changeCycleSchedule(rule(f.studentId, [createSlot(2, "09:00", "10:00"), createSlot(2, "16:00", "17:00")]));
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const child = spawn(process.execPath, ["-e", `
    const { join } = require("node:path");
    const { WorkspaceDatabase } = require("./build/database.js");
    const { OperationsDatabase } = require("./build/operations.js");
    const dir = process.argv[1];
    const students = WorkspaceDatabase.open(join(dir, "mvp.sqlite3"), join(dir, "mvp.initialized"), 9);
    const ops = OperationsDatabase.open(dir, students);
    const db = ops.protectionConnection(), exec = db.exec.bind(db);
    let commits = 0;
    db.exec = sql => {
      if (sql === "COMMIT" && ++commits === 2) {
        require("node:fs").writeSync(1, "before second commit");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      }
      return exec(sql);
    };
    ops.changeCycleSchedule({action:"generate",from:"2030-01-01",to:"2030-01-01"});
  `, f.dir], { cwd: join(__dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  child.stderr.resume();
  try {
    const result = await Promise.race([once(child.stdout, "data").then(([chunk]) => chunk.toString()),
      exited.then(() => "exited"), new Promise(resolve => setTimeout(() => resolve("timeout"), 9000).unref())]);
    assert.equal(result, "before second commit");
  } finally {
    child.kill();
    await exited;
  }
  assert.deepEqual(generate(f.operations, "2030-01-01", "2030-01-01"),
    { created: 1, existing: 1, inactive: 0, conflicts: 0, elapsed: 0 });
});
