const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { closeStoresIndependently } = require("../build/database-lifecycle.js");
const { WorkLogDatabase } = require("../build/worklog.js");

function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function fixture(t) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "M2B 合成日志 "));
  const m1Path = join(root, "mvp.sqlite3");
  const m1 = WorkspaceDatabase.open(m1Path, join(root, "mvp.initialized"));
  const student = m1.createStudent({ id: randomUUID(), alias: "合成学生·小禾", grade: "七年级", subjects: "数学", goal: "", notes: "" });
  const workPath = join(root, "worklog.sqlite3"), marker = join(root, "worklog.initialized");
  let work = WorkLogDatabase.open(workPath, marker);
  t.after(() => {
    if (work) { const closing = work; work = null; closing.close(); }
    m1.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, m1, m1Path, student, workPath, marker, get work() { return work; },
    closeWork() { const closing = work; work = null; closing?.close(); },
    reopen() { if (work) work.close(); work = WorkLogDatabase.open(workPath, marker); } };
}
function input(studentId, id = randomUUID()) {
  return { id, title: "检查虚构学生的分数练习", workDate: "2026-11-18", studentId,
    startedAt: "2026-11-18T09:30", notes: "已核对练习册", nextStep: "明天复查错题" };
}

test("work log uses an independent database and supports the daily task loop across reopen", t => {
  const f = fixture(t); const before = hash(f.m1Path);
  const row = f.work.save(input(f.student.id), id => f.m1.students().some(s => s.id === id));
  assert.equal(row.status, "open"); assert.equal(row.completedAt, null);
  assert.deepEqual(f.work.list("2026-11-18").map(x => x.id), [row.id]);
  assert.equal(f.work.save(input(f.student.id, row.id), id => f.m1.students().some(s => s.id === id)).id, row.id);
  const completed = f.work.setStatus(row.id, "done");
  assert.equal(completed.status, "done"); assert.ok(completed.completedAt);
  assert.equal(f.work.setStatus(row.id, "done").completedAt, completed.completedAt);
  assert.equal(f.work.list("2026-11-18").length, 0);
  assert.equal(f.work.search("2026-11-01", "2026-11-30", "分数").length, 1);
  assert.equal(f.work.history(row.id).length, 2);
  const header = Buffer.alloc(72); readFileSync(f.workPath).copy(header);
  assert.equal(header.readUInt32BE(68), 0x53574231);
  f.reopen();
  assert.equal(f.work.search("2026-11-18", "2026-11-18")[0].completedAt, completed.completedAt);
  assert.equal(f.work.history(row.id).length, 2);
  assert.equal(hash(f.m1Path), before);
});

test("invalid student association and failed work-log initialization leave M1 unchanged", t => {
  const f = fixture(t); const before = hash(f.m1Path);
  assert.throws(() => f.work.save(input(randomUUID()), () => false), /学生档案不存在/);
  const badPath = join(f.root, "bad-worklog.sqlite3");
  const db = new DatabaseSync(badPath); db.exec("PRAGMA application_id=77; PRAGMA user_version=1; CREATE TABLE unrelated(x)"); db.close();
  assert.throws(() => WorkLogDatabase.open(badPath, join(f.root, "bad.initialized")), /身份或版本/);
  assert.equal(hash(f.m1Path), before);
  assert.equal(f.m1.students().length, 1);
});

test("uncompleted dated tasks stay visible as overdue and cancellation is recorded", t => {
  const f = fixture(t);
  const row = f.work.save({ ...input(null), workDate: "2026-11-17" }, () => false);
  assert.deepEqual(f.work.list("2026-11-18").map(x => x.id), [row.id]);
  const cancelled = f.work.setStatus(row.id, "cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.work.history(row.id).length, 2);
});

test("failed rollback permanently blocks subsequent writes until reopen", t => {
  const f = fixture(t);
  const existing = f.work.save(input(null), () => false);
  const triggerDb = new DatabaseSync(f.workPath);
  triggerDb.exec(`CREATE TRIGGER fail_work_item BEFORE INSERT ON work_items
    WHEN NEW.title='injected rollback failure' BEGIN SELECT RAISE(ABORT,'injected'); END`);
  triggerDb.close();

  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure before SQLite rollback");
    return originalExec.call(this, sql);
  };
  try {
    assert.throws(() => f.work.save({ ...input(null), title: "injected rollback failure" }, () => false),
      error => error.code === "unknown");
  } finally { DatabaseSync.prototype.exec = originalExec; }

  assert.throws(() => f.work.save(input(null), () => false), error => error.code === "unknown");
  assert.throws(() => f.work.setStatus(existing.id, "done"), error => error.code === "unknown");
  assert.equal(f.work.history(existing.id).length, 1);
  assert.equal(f.work.search("2026-11-18", "2026-11-18")[0].status, "open");
  assert.throws(() => f.closeWork(), error => error.code === "unknown");
  f.reopen();
  assert.equal(f.work.search("2026-11-18", "2026-11-18")[0].status, "open");
  assert.equal(f.work.save(input(null), () => false).status, "open");
});

test("successful work-log close failure does not prevent attempting M1 close", () => {
  const attempted = [];
  const errors = closeStoresIndependently(
    () => { attempted.push("worklog"); throw new Error("worklog close failed"); },
    () => { attempted.push("m1"); },
  );
  assert.deepEqual(attempted, ["worklog", "m1"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /worklog close failed/);
});

test("COMMIT succeeds then throws: retry is reported unknown and does not duplicate history", t => {
  const f = fixture(t);
  const originalExec = DatabaseSync.prototype.exec;
  let inject = true;
  DatabaseSync.prototype.exec = function(sql) {
    const result = originalExec.call(this, sql);
    if (sql === "COMMIT" && inject) { inject = false; throw new Error("injected post-commit error"); }
    return result;
  };
  try {
    assert.throws(() => f.work.save(input(null), () => false), error => error.code === "unknown");
  } finally { DatabaseSync.prototype.exec = originalExec; }
  const rowId = f.work.search("2026-11-18", "2026-11-18")[0].id;
  assert.equal(f.work.history(rowId).length, 1);
  f.work.save(input(null, rowId), () => false);
  assert.equal(f.work.history(rowId).length, 1);
});
