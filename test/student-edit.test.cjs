const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "sw-student-edit-"));
  const path = join(dir, "mvp.sqlite3"), marker = join(dir, "mvp.initialized");
  let db = WorkspaceDatabase.open(path, marker, 2);
  t.after(() => db.close());
  const fields = { alias: "虚构甲", grade: "七年级", subjects: "数学", goal: "", notes: "" };
  const student = db.createStudent({ id: randomUUID(), ...fields });
  const command = { requestId: randomUUID(), studentId: student.id, expectedRevision: 0, fields: { ...fields, alias: "虚构甲一" } };
  return { path, marker, student, fields, command, get db() { return db; },
    reopen() { db.close(); db = WorkspaceDatabase.open(path, marker, 2); } };
}

test("student edits keep UUID, creation receipt, learning ownership, revisions and history across reopen", t => {
  const f = fixture(t), { student, command, fields } = f;
  const another = f.db.createStudent({ id: randomUUID(), ...fields });
  const lesson = f.db.addLesson({ id: randomUUID(), studentId: student.id, date: "2026-11-24", subject: "数学",
    task: "合成练习", completion: "已完成", assessment: "", nextStep: "" });
  assert.throws(() => f.db.saveStudentEdit({ ...command, fields: { ...command.fields, id: another.id } }), { code: "invalid" });
  assert.throws(() => f.db.saveStudentEdit({ ...command, createdAt: 0 }), { code: "invalid" });
  const saved = f.db.saveStudentEdit(command);
  assert.deepEqual(saved.before, fields);
  assert.equal(saved.revision, 1);
  f.reopen();
  assert.deepEqual(f.db.studentEditView(student.id).pending, command);
  assert.deepEqual(f.db.saveStudentEdit(command), saved);
  assert.throws(() => f.db.saveStudentEdit({ ...command, studentId: another.id }), { code: "conflict" });
  assert.throws(() => f.db.saveStudentEdit({ ...command, fields: { ...fields, alias: "虚构乙" } }), { code: "conflict" });
  assert.throws(() => f.db.finishStudentEdit({ studentId: student.id, requestId: randomUUID() }), { code: "conflict" });
  f.db.finishStudentEdit(command);
  assert.throws(() => f.db.saveStudentEdit({ ...command, requestId: randomUUID(), fields }), { code: "conflict" });
  const next = { ...command, requestId: randomUUID(), expectedRevision: 1, fields: { ...command.fields, notes: "合成备注" } };
  const later = f.db.saveStudentEdit(next);
  f.db.finishStudentEdit(next);
  f.reopen();
  assert.deepEqual(f.db.studentEditView(student.id), { student: { ...student, ...next.fields }, revision: 2, history: [later, saved], pending: null });
  assert.deepEqual(f.db.createStudent({ id: student.id, ...fields }), student);
  assert.deepEqual(f.db.history(student.id), [lesson]);
  assert.deepEqual(f.db.studentEditView(another.id), { student: another, revision: 0, history: [], pending: null });
});

test("a lost post-COMMIT edit reply recovers from the original durable request without duplicate history", t => {
  const f = fixture(t), conn = f.db.protectionConnection();
  const exec = conn.exec.bind(conn);
  let commits = 0;
  conn.exec = sql => {
    exec(sql);
    if (sql === "COMMIT" && ++commits === 2) throw new Error("synthetic reply lost");
  };
  assert.throws(() => f.db.saveStudentEdit(f.command), { code: "unknown" });
  f.reopen();
  const view = f.db.studentEditView(f.student.id);
  assert.equal(view.revision, 1);
  assert.deepEqual(view.pending, f.command);
  assert.deepEqual(f.db.saveStudentEdit(view.pending), view.history[0]);
  assert.equal(f.db.studentEditView(f.student.id).history.length, 1);
  assert.throws(() => f.db.finishStudentEdit({ ...f.command, discard: true }), { code: "conflict" });
  f.db.finishStudentEdit(f.command);
  assert.equal(f.db.studentEditView(f.student.id).pending, null);
});

test("a failed edit COMMIT plus failed ROLLBACK blocks reads, writes and backup until reopen", t => {
  const f = fixture(t), conn = f.db.protectionConnection();
  const exec = conn.exec.bind(conn);
  let commits = 0;
  conn.exec = sql => {
    if ((sql === "COMMIT" && ++commits === 2) || sql === "ROLLBACK") throw new Error("synthetic write fault");
    exec(sql);
  };
  assert.throws(() => f.db.saveStudentEdit(f.command), { code: "unknown" });
  assert.throws(() => f.db.studentEditView(f.student.id), { code: "busy" });
  assert.throws(() => f.db.students(), { code: "busy" });
  assert.throws(() => f.db.saveStudentEdit(f.command), { code: "recovery" });
  f.reopen();
  const view = f.db.studentEditView(f.student.id);
  assert.equal(view.revision, 0);
  assert.deepEqual(view.student, f.student);
  assert.deepEqual(view.pending, f.command);
  assert.throws(() => f.db.finishStudentEdit(f.command), { code: "unknown" });
  f.db.finishStudentEdit({ ...f.command, discard: true });
  assert.equal(f.db.studentEditView(f.student.id).pending, null);
});

test("old M1 refuses v2 before opening writable SQLite and keeps the database and marker", t => {
  const f = fixture(t);
  const file = readFileSync(f.path), mark = readFileSync(f.marker);
  assert.throws(() => WorkspaceDatabase.open(f.path, f.marker), { code: "recovery" });
  assert.deepEqual(readFileSync(f.path), file);
  assert.deepEqual(readFileSync(f.marker), mark);
});
