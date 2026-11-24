const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sw-parent-followup-"));
  const path = join(root, "mvp.sqlite3"), marker = join(root, "mvp.initialized");
  let db = WorkspaceDatabase.open(path, marker, 3);
  t.after(() => db.close());
  const fields = { alias: "合成学生", grade: "七年级", subjects: "数学", notes: "", goal: "" };
  const a = db.createStudent({ id: randomUUID(), ...fields });
  const b = db.createStudent({ id: randomUUID(), ...fields });
  const concern = { requestId: randomUUID(), studentId: a.id, reportedOn: "2026-11-24",
    role: "guardian", category: "habits", concern: "合成诉求：检查习惯", nextOn: "2026-11-26" };
  const followUp = { requestId: randomUUID(), studentId: a.id, concernId: concern.requestId, expectedRevision: 0,
    followedOn: "2026-11-25", status: "in_progress", note: "合成跟进：已核对记录", nextOn: "2026-11-27" };
  return { a, b, fields, concern, followUp, path, marker, get db() { return db; },
    reopen() { db.close(); db = WorkspaceDatabase.open(path, marker, 3); } };
}

test("parent concerns and ordered follow-ups remain separate from profile facts and bound to the student UUID", t => {
  const f = fixture(t);
  const opened = f.db.createParentConcern(f.concern);
  const follow = f.db.appendParentFollowUp(f.followUp);
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, studentId: f.b.id }), { code: "invalid" });
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, requestId: randomUUID(), expectedRevision: 1,
    followedOn: "2026-11-24" }), { code: "invalid" });
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, requestId: randomUUID(), expectedRevision: 1,
    followedOn: "2026-02-30" }), { code: "invalid" });
  assert.throws(() => f.db.createParentConcern({ ...f.concern, requestId: randomUUID(), studentId: randomUUID() }), { code: "invalid" });
  const next = f.db.appendParentFollowUp({ ...f.followUp, requestId: randomUUID(), expectedRevision: 1,
    status: "resolved", followedOn: "2026-11-26", note: "合成结案", nextOn: "" });
  const edit = { studentId: f.a.id, requestId: randomUUID(), expectedRevision: 0, fields: { ...f.fields, alias: "合成改名甲" } };
  f.db.saveStudentEdit(edit);
  f.db.finishStudentEdit(edit);
  f.reopen();
  assert.equal(f.db.studentEditView(f.a.id).student.alias, "合成改名甲");
  assert.deepEqual(f.db.parentFollowUp(f.a.id), { studentId: f.a.id, concerns: [{ ...opened, followUps: [next, follow] }] });
  assert.deepEqual(f.db.parentFollowUp(f.b.id), { studentId: f.b.id, concerns: [] });
  assert.deepEqual(f.db.history(f.a.id), []);
});

test("parent writes refuse stale versions and different replay payloads, including across request types", t => {
  const f = fixture(t);
  const original = f.db.createParentConcern(f.concern);
  const follow = f.db.appendParentFollowUp(f.followUp);
  f.reopen();
  assert.deepEqual(f.db.createParentConcern(f.concern), original);
  assert.deepEqual(f.db.appendParentFollowUp(f.followUp), follow);
  assert.throws(() => f.db.createParentConcern({ ...f.concern, concern: "不同原文" }), { code: "conflict" });
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, note: "不同跟进" }), { code: "conflict" });
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, requestId: f.concern.requestId, expectedRevision: 1 }), { code: "conflict" });
  assert.throws(() => f.db.createParentConcern({ ...f.concern, requestId: f.followUp.requestId }), { code: "conflict" });
  assert.throws(() => f.db.appendParentFollowUp({ ...f.followUp, requestId: randomUUID() }), { code: "conflict" });
  assert.equal(f.db.parentFollowUp(f.a.id).concerns[0].followUps.length, 1);
});

test("a committed follow-up with a lost receipt replays after reopen and v2 cannot open the database", t => {
  const f = fixture(t);
  f.db.createParentConcern(f.concern);
  const conn = f.db.protectionConnection(), exec = conn.exec.bind(conn);
  conn.exec = sql => { exec(sql); if (sql === "COMMIT") throw new Error("synthetic lost response"); };
  assert.throws(() => f.db.appendParentFollowUp(f.followUp), { code: "unknown" });
  f.reopen();
  const before = readFileSync(f.path), marker = readFileSync(f.marker);
  assert.throws(() => WorkspaceDatabase.open(f.path, f.marker, 2), { code: "recovery" });
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(readFileSync(f.marker), marker);
  const replay = f.db.appendParentFollowUp(f.followUp);
  assert.deepEqual(f.db.parentFollowUp(f.a.id).concerns[0].followUps, [replay]);
});
