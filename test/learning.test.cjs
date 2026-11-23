const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { OperationsDatabase } = require("../build/operations.js");
const { applyLearningChange, readLearningDay, readScheduleReceipt } = require("../build/learning-api.js");
const { saveSchedulePlan } = require("../build/schedule-api.js");
const { mondayOf, shanghaiMinute, shanghaiParts, shiftDate } = require("../build/schedule-calendar.js");

const isCode = code => error => error.code === code;
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "sw-learning-"));
  const m1 = WorkspaceDatabase.open(join(dir, "mvp.sqlite3"), join(dir, "mvp.initialized"));
  const students = () => m1.students();
  const ids = ["SYNTH-01", "SYNTH-02"].map(alias => m1.createStudent({
    id: randomUUID(), alias, grade: "G7", subjects: "Math", goal: "", notes: "",
  }).id);
  let db = OperationsDatabase.open(dir, m1, true);
  t.after(() => { try { db.close(); } finally { m1.close(); } });
  const now = Date.now();
  const date = shiftDate(mondayOf(shanghaiParts(now).date), 12);
  const clock = t.mock.method(Date, "now", () => now);
  const at = time => shanghaiMinute(date, time);
  const save = request => saveSchedulePlan(db, students, request);
  const plan = (studentId, start = "08:00", span = "18:00") => save({
    id: randomUUID(), requestId: randomUUID(), studentId, expectedRevision: 0, kind: "whole_day",
    startAt: at(start), endAt: at(span),
  });
  const setClock = when => clock.mock.mockImplementation(() => when);
  return {
    ids, at, plan, setClock, save,
    apply: request => applyLearningChange(db, students, request),
    receipt: request => readScheduleReceipt(db, students, request),
    read: plan => readLearningDay(db, students, { attendanceId: plan.id, studentId: plan.studentId }),
    connection: () => db.protectionConnection(),
    reopen: (blocked = false) => {
      if (blocked) assert.throws(() => db.close(), isCode("unknown"));
      else db.close();
      db = OperationsDatabase.open(dir, m1);
    },
  };
}
function command(plan, row, fields) {
  return { attendanceId: plan.id, studentId: row.studentId, id: row.id, expectedRevision: row.revision,
    requestId: randomUUID(), ...fields };
}
function block(f, plan, start = "08:00", end = "09:30") {
  return command(plan, { id: randomUUID(), studentId: plan.studentId, revision: 0 }, {
    command: "saveLearningBlock", plannedStart: f.at(start), plannedEnd: f.at(end), notes: "合成学习块",
  });
}

test("learning IPC constrains each write and read to the selected attendance and M1 UUID", t => {
  const f = fixture(t);
  const a = f.plan(f.ids[0], "08:00", "17:00"), b = f.plan(f.ids[1]);
  const a2 = f.plan(f.ids[0], "17:00", "18:00");
  assert.throws(() => f.read({ ...a, studentId: b.studentId }), isCode("invalid"));
  assert.throws(() => f.read({ ...a, studentId: randomUUID() }), isCode("invalid"));
  const created = f.apply(block(f, a));
  assert.throws(() => f.apply(command(b, { ...created, studentId: b.studentId }, { command: "saveLearningTasks", tasks: [] })), isCode("invalid"));
  assert.throws(() => f.apply(command(a2, created, { command: "saveLearningTasks", tasks: [] })), isCode("invalid"));
  assert.throws(() => f.apply(command(b, a, { command: "recordAttendance", action: "checkIn" })), isCode("invalid"));
  assert.deepEqual(f.read(b).blocks, []);
  assert.equal(f.read(a).blocks.length, 1);
});

test("attendance, parallel learning blocks and three task results persist and reject illegal updates", t => {
  const f = fixture(t);
  let a = f.plan(f.ids[0]), b = f.plan(f.ids[1]);
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "checkOut" })), isCode("conflict"));
  const original = a;
  const checkIn = command(a, a, { command: "recordAttendance", action: "checkIn" });
  f.setClock(f.at("08:01"));
  a = f.apply(checkIn);
  b = f.apply(command(b, b, { command: "recordAttendance", action: "checkIn" }));
  assert.deepEqual(f.apply(checkIn), a);
  assert.equal(a.checkInAt, b.checkInAt);
  assert.throws(() => f.apply(command(a, original, { command: "recordAttendance", action: "checkIn" })), isCode("conflict"));
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "cancel" })), isCode("conflict"));

  let first = f.apply(block(f, a));
  const next = f.apply(block(f, a, "10:00", "11:00"));
  let other = f.apply(block(f, b));
  const tasks = ["foundation", "synchronous", "targeted_test"].map(category => ({
    id: randomUUID(), category, content: "有理数练习", subject: "数学", knowledgePoints: "符号", plannedTarget: "能说明步骤",
  }));
  const saveTasks = command(a, first, { command: "saveLearningTasks", tasks });
  assert.throws(() => f.apply({ ...saveTasks, tasks: [...tasks, tasks[0]] }), isCode("invalid"));
  assert.throws(() => f.apply({ ...saveTasks, tasks: [{ ...tasks[0], category: "unsupported" }] }), isCode("invalid"));
  first = f.apply(saveTasks);
  other = f.apply(command(b, other, { command: "saveLearningTasks", tasks: [{
    id: randomUUID(), category: "home_school", content: "订正作业",
  }] }));
  assert.equal(other.tasks[0].category, "home_school");
  assert.deepEqual(f.apply(saveTasks), first);
  assert.throws(() => f.apply({ ...saveTasks, tasks: [] }), isCode("conflict"));
  assert.throws(() => f.apply(command(a, first, { command: "recordTaskOutcome", taskId: tasks[0].id, status: "done" })), isCode("conflict"));
  f.setClock(f.at("08:04"));
  first = f.apply(command(a, first, { command: "recordLearningOutcome", action: "start" }));
  f.apply(command(b, other, { command: "recordLearningOutcome", action: "start" }));
  assert.throws(() => f.apply(command(a, first, { command: "recordLearningOutcome", action: "finish" })), isCode("conflict"));
  first = f.apply(command(a, first, { command: "recordTaskOutcome", taskId: tasks[0].id, status: "in_progress" }));
  f.setClock(f.at("08:20"));
  const finishTask = command(a, first, { command: "recordTaskOutcome", taskId: tasks[0].id, status: "done", resultNotes: "独立完成两题" });
  first = f.apply(finishTask);
  first = f.apply(command(a, first, { command: "recordTaskOutcome", taskId: tasks[1].id, status: "skipped", resultNotes: "下次继续" }));
  assert.throws(() => f.apply(command(a, first, { command: "saveLearningTasks", tasks: [] })), isCode("conflict"));
  assert.throws(() => f.apply(command(a, first, { command: "recordTaskOutcome", taskId: tasks[0].id, status: "skipped" })), isCode("conflict"));
  first = f.apply(command(a, first, { command: "recordLearningOutcome", action: "finish" }));
  f.apply(command(a, next, { command: "recordLearningOutcome", action: "cancel" }));
  a = f.apply(command(a, a, { command: "recordAttendance", action: "checkOut" }));
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "checkOut" })), isCode("conflict"));

  f.reopen();
  const day = f.read(a);
  assert.equal(day.attendance.checkOutAt, f.at("08:20"));
  assert.equal(day.blocks[0].actualEnd, f.at("08:20"));
  assert.equal(day.blocks[0].tasks[0].resultNotes, "独立完成两题");
  assert.equal(day.blocks[0].tasks[1].status, "skipped");
  assert.equal(day.blocks[1].status, "cancelled");
  assert.equal(f.read(b).blocks[0].status, "in_progress");
  assert.equal(f.receipt(finishTask).revision, finishTask.expectedRevision + 1);
});

test("absent and cancellation obey timing and existing learning blocks", t => {
  const f = fixture(t);
  const a = f.plan(f.ids[0]), b = f.plan(f.ids[1]);
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "absent" })), isCode("conflict"));
  const cancelled = f.apply(command(b, b, { command: "recordAttendance", action: "cancel" }));
  assert.equal(cancelled.status, "cancelled");
  assert.throws(() => f.apply(command(b, cancelled, { command: "recordAttendance", action: "checkIn" })), isCode("conflict"));
  const planned = f.apply(block(f, a));
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "cancel" })), isCode("conflict"));
  f.setClock(f.at("08:10"));
  f.apply(command(a, planned, { command: "recordLearningOutcome", action: "start" }));
  assert.throws(() => f.apply(command(a, a, { command: "recordAttendance", action: "absent" })), isCode("conflict"));
  const c = f.plan(f.ids[1], "09:00", "10:00");
  f.setClock(f.at("09:01"));
  assert.equal(f.apply(command(c, c, { command: "recordAttendance", action: "absent" })).status, "absent");
});

test("a committed reply lost at the course deadline can be read and retried by the original request", t => {
  const f = fixture(t), plan = f.plan(f.ids[0]);
  const request = { ...plan, command: "saveAttendancePlan", expectedRevision: 1, requestId: randomUUID(), endAt: f.at("17:00") };
  const db = f.connection(), exec = db.exec.bind(db);
  t.mock.method(db, "exec", sql => {
    exec(sql);
    if (sql === "COMMIT") throw new Error("synthetic reply failure after commit");
  });
  assert.throws(() => f.save(request), isCode("unknown"));
  f.setClock(f.at("08:30"));
  assert.equal(f.receipt(request).revision, 2);
  assert.throws(() => f.receipt({ ...request, studentId: f.ids[1] }), isCode("conflict"));
  assert.throws(() => f.receipt({ ...request, expectedRevision: 2 }), isCode("conflict"));
  f.reopen(true);
  assert.equal(f.save(request).revision, 2);
  assert.equal(f.receipt(request).revision, 2);
  assert.equal(f.read(plan).attendance.revision, 2);
});

test("receipt lookup never exposes an uncommitted arrival after rollback failure", t => {
  const f = fixture(t), plan = f.plan(f.ids[0]);
  const arrival = command(plan, plan, { command: "recordAttendance", action: "checkIn" });
  const db = f.connection(), exec = db.exec.bind(db);
  t.mock.method(db, "exec", sql => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("synthetic uncommitted transaction");
    exec(sql);
  });
  assert.throws(() => f.apply(arrival), isCode("unknown"));
  assert.throws(() => f.receipt(arrival), isCode("busy"));
  f.reopen(true);
  assert.equal(f.receipt(arrival), null);
  assert.equal(f.read(plan).attendance.checkInAt, null);
  assert.equal(f.apply(arrival).revision, 2);
  assert.equal(f.receipt(arrival).revision, 2);
});
