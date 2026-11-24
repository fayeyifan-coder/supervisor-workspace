const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { WorkspaceDatabase } = require("../build/database.js");
const { StudentWriteRecovery } = require("../build/student-write-recovery.js");

const open = root => WorkspaceDatabase.open(join(root, "mvp.sqlite3"), join(root, "mvp.initialized"), 6);
const fields = { alias: "合成学生", grade: "七年级", subjects: "数学", goal: "", notes: "" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sw-write-recovery-"));
  const store = open(root);
  let students;
  try { students = [1, 2].map(n => store.createStudent({ ...fields, id: randomUUID(), alias: fields.alias + n })); }
  finally { store.close(); }
  return { root, students, journal: new StudentWriteRecovery(root) };
}
function request(studentId, kind = "enrollment") {
  const date = "2026-11-24";
  const data = {
    enrollment: { course: "合成报名", registeredOn: date, startsOn: date, endsOn: "2026-12-24", status: "有效", notes: "" },
    score: { assessment: "合成测验", subject: "数学", takenOn: date, category: "日常测验", score: "40", maximum: "50", notes: "" },
    improvement: { title: "合成方案", subject: "数学", startsOn: date, targetOn: "2026-12-24",
      baseline: "合成前测", target: "合成目标", practice: "合成练习", status: "执行中" },
  };
  return { kind, studentId, id: randomUUID(), requestId: randomUUID(), expectedRevision: 0, fields: data[kind] };
}
function crash(f, kind, draft, point) {
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, SW_SYNTHETIC_WRITE_CRASH: JSON.stringify({ root: f.root, kind, draft, point }) },
  });
  assert.equal(child.status, point === "before" ? 73 : 74, child.stderr?.toString());
}

if (process.env.SW_SYNTHETIC_WRITE_CRASH) {
  const { root, kind, draft, point } = JSON.parse(process.env.SW_SYNTHETIC_WRITE_CRASH);
  const store = open(root);
  const original = DatabaseSync.prototype.exec;
  let commits = 0;
  DatabaseSync.prototype.exec = function(sql) {
    const fault = sql === "COMMIT" && ++commits === (kind === "edit" ? 2 : 1);
    if (fault && point === "before") process.exit(73);
    const result = original.call(this, sql);
    if (fault && point === "after") process.exit(74);
    return result;
  };
  if (kind === "edit") store.saveStudentEdit(draft);
  else {
    const command = store.studentWriteCommand(kind, draft);
    new StudentWriteRecovery(root).run(store, command, () => kind === "record" ? store.saveStudentRecord(draft) : store.createParentConcern(draft));
  }
  process.exit(99);
}

const { test } = require("node:test");

for (const feature of ["enrollment", "score", "improvement"]) test("process exit before and after COMMIT retains the " + feature + " request", () => {
  for (const point of ["before", "after"]) {
    const f = fixture(), studentId = f.students[0].id, input = request(studentId, feature);
    crash(f, "record", input, point);
    const db = open(f.root), { journal } = f;
    try {
      const command = db.studentWriteCommand("record", input);
      assert.deepEqual(journal.state(db), { kind: "pending", command, outcome: point === "before" ? "notSaved" : "saved" });
      assert.equal(db.studentRecords(feature, studentId).records.length, point === "before" ? 0 : 1);
      assert.throws(() => journal.run(db, db.studentWriteCommand("record", request(studentId)),
        () => assert.fail("a new identity must not reach SQLite")), { code: "recovery" });
      assert.throws(() => journal.requireSettled(db), { code: "recovery" });
      if (point === "before") journal.resolve(db, "retry", input.requestId);
      else assert.throws(() => journal.resolve(db, "discard", input.requestId), { code: "unknown" });
      assert.equal(journal.state(db).outcome, "saved");
      assert.equal(db.studentRecords(feature, studentId).records.length, 1);
      journal.resolve(db, "confirm", input.requestId);
      assert.deepEqual(journal.state(db), { kind: "empty" });
      assert.equal(db.saveStudentRecord(input).requestId, input.requestId);
      assert.equal(db.studentRecords(feature, studentId).records.length, 1);
      assert.deepEqual(db.studentRecords(feature, f.students[1].id).records, []);
    } finally { db.close(); }
  }
});

test("loss of request identity refuses blind replay and preserves the remaining original artifact after review", () => {
  const f = fixture(), studentId = f.students[0].id, input = request(studentId);
  crash(f, "record", input, "after");
  const marker = join(f.root, "student-write.pending");
  const payload = join(f.root, "student-write.json");
  const original = readFileSync(payload);
  unlinkSync(marker);
  const store = open(f.root);
  try {
    assert.deepEqual(f.journal.state(store), { kind: "damaged" });
    assert.throws(() => f.journal.resolve(store, "retry", input.requestId), { code: "conflict" });
    assert.throws(() => f.journal.run(store, store.studentWriteCommand("record", request(studentId)),
      () => assert.fail("damaged identity must not enable another write")), { code: "recovery" });
    assert.equal(store.studentRecords("enrollment", studentId).records[0].requestId, input.requestId);
    f.journal.resolve(store, "archive", undefined);
    const evidence = readdirSync(f.root).find(name => name.startsWith("student-write-evidence-"));
    assert.deepEqual(readFileSync(join(f.root, evidence, "payload.json")), original);
    assert.deepEqual(f.journal.state(store), { kind: "empty" });
  } finally { store.close(); }
});

test("a killed parent request has a durable exact receipt; wrong inputs cannot acknowledge it", () => {
  const f = fixture(), studentId = f.students[0].id;
  const input = { studentId, requestId: randomUUID(), reportedOn: "2026-11-24",
    role: "guardian", category: "habits", concern: "合成诉求", nextOn: "" };
  crash(f, "concern", input, "after");
  const store = open(f.root);
  try {
    assert.equal(f.journal.state(store).outcome, "saved");
    assert.throws(() => f.journal.resolve(store, "confirm", randomUUID()), { code: "conflict" });
    assert.throws(() => store.studentWriteCommitted(store.studentWriteCommand("concern",
      { ...input, studentId: f.students[1].id })), { code: "conflict" });
    assert.throws(() => store.studentWriteCommitted(store.studentWriteCommand("concern",
      { ...input, concern: "另一合成诉求" })), { code: "conflict" });
    f.journal.resolve(store, "confirm", input.requestId);
    assert.equal(store.parentFollowUp(studentId).concerns.length, 1);
  } finally { store.close(); }
});

test("process exit around the second base-edit COMMIT preserves the v2 pending payload and one revision", () => {
  for (const point of ["before", "after"]) {
    const f = fixture(), studentId = f.students[0].id;
    const input = { studentId, requestId: randomUUID(), expectedRevision: 0, fields: { ...fields, alias: "合成修改后" } };
    crash(f, "edit", input, point);
    const store = open(f.root);
    try {
      const view = store.studentEditView(studentId);
      assert.deepEqual(view.pending, input);
      assert.equal(view.history.length, point === "before" ? 0 : 1);
      store.saveStudentEdit(input);
      store.finishStudentEdit(input);
      const recovered = store.studentEditView(studentId);
      assert.equal(recovered.history.length, 1);
      assert.equal(recovered.student.alias, "合成修改后");
      assert.equal(recovered.pending, null);
    } finally { store.close(); }
  }
});
