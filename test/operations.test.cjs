const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { OperationsDatabase, operationsProtection, verifyOperationsStudentLinks } = require("../build/operations.js");

const hour = 3_600_000, day = 24 * hour;
const nextSaturday = () => {
  const from = new Date(Date.now() + 8 * hour);
  return Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() +
    ((6 - from.getUTCDay() + 7) % 7 || 7), 1);
};
const failure = code => error => error.code === code;
const input = (studentId, id = randomUUID(), expectedRevision = 0) => ({
  id, studentId, expectedRevision, requestId: randomUUID(),
});
const change = row => input(row.studentId, row.id, row.revision);
const task = (content, category = "synchronous") => ({ id: randomUUID(), content, category });
function directory() { return mkdtempSync(join(realpathSync.native(tmpdir()), "sw-operations-")); }

function fixture(t) {
  const dir = directory();
  const m1File = join(dir, "mvp.sqlite3"), m1Marker = join(dir, "mvp.initialized");
  let m1 = WorkspaceDatabase.open(m1File, m1Marker);
  const ids = ["DEMO-A", "DEMO-B", "DEMO-C"].map(alias => m1.createStudent({
    id: randomUUID(), alias, grade: "G7", subjects: "Math", goal: "", notes: "",
  }).id);
  m1.close();
  m1 = WorkspaceDatabase.open(m1File, m1Marker);
  let store;
  t.after(() => {
    try { if (store) store.close(); } finally { m1.close(); }
  });
  return {
    dir, ids, m1, m1File, m1Marker, file: join(dir, "operations.sqlite3"), marker: join(dir, "operations.initialized"),
    get store() { return store ??= OperationsDatabase.open(dir, m1, true); },
    close() {
      const current = store;
      store = undefined;
      if (current) current.close();
    },
  };
}

test("operations creates its own Schema 1 and marker, then reopens without changing M1", t => {
  const f = fixture(t);
  const original = readFileSync(f.m1File);
  const reference = f.store.protectionConnection();
  assert.equal(reference.prepare("PRAGMA application_id").get().application_id, operationsProtection.applicationId);
  assert.equal(reference.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(reference.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(readFileSync(f.marker, "utf8"), operationsProtection.marker);
  const plan = f.store.saveAttendancePlan({ ...input(f.ids[0]), startAt: nextSaturday() });
  const blocks = f.store.learningBlocksForAttendance(plan.id);
  assert.equal(blocks.length, 0);
  assert.equal(plan.endAt - plan.startAt, 2 * hour);
  f.close();
  assert.deepEqual(f.store.attendancePlan(plan.id), plan);
  assert(readFileSync(f.m1File).equals(original));
  assert.equal(readFileSync(f.m1Marker, "utf8"), "mvp-v1\n");
});

test("the Shanghai calendar permits shared slots, rejects same-student overlap, and preserves one-off reasons", t => {
  const f = fixture(t), { store } = f, saturday = nextSaturday();
  const plans = f.ids.map(studentId => store.saveAttendancePlan({ ...input(studentId), startAt: saturday }));
  assert.equal(store.listAttendancePlans(saturday, saturday + hour).length, 3);
  assert.equal(store.listAttendancePlans(saturday, saturday + hour, f.ids[0]).length, 1);
  assert.throws(() => store.saveAttendancePlan({ ...input(f.ids[0]), startAt: saturday + hour }), failure("conflict"));
  store.saveAttendancePlan({ ...input(f.ids[0]), startAt: saturday + 2 * hour });
  const monday = saturday + 2 * day + 7 * hour;
  const tuesdayBeforeOpen = saturday + 3 * day + 6 * hour;
  assert.throws(() => store.saveAttendancePlan({ ...input(f.ids[0]), startAt: monday }), failure("invalid"));
  assert.throws(() => store.saveAttendancePlan({ ...input(f.ids[0]), startAt: tuesdayBeforeOpen }), failure("invalid"));
  assert.throws(() => store.saveAttendancePlan({
    ...input(f.ids[0]), startAt: monday, exception: { confirmed: true, reason: " " },
  }), failure("invalid"));
  const allowed = store.saveAttendancePlan({
    ...input(f.ids[0]), startAt: monday, exception: { confirmed: true, reason: "Synthetic one-off" },
  });
  store.saveAttendancePlan({ ...input(f.ids[0]), startAt: tuesdayBeforeOpen + hour });
  store.recordAttendance({ ...change(plans[0]), action: "cancel" });
  store.saveAttendancePlan({ ...input(f.ids[0]), startAt: saturday });
  f.close();
  assert.equal(f.store.attendancePlan(allowed.id).exceptionReason, "Synthetic one-off");
});

test("an arrival window, multiple learning blocks, and task outcomes persist independently", t => {
  const f = fixture(t), { store } = f, morning = nextSaturday() - hour;
  const plan = store.saveAttendancePlan({ ...input(f.ids[0]), startAt: morning, endAt: morning + 10 * hour, kind: "whole_day" });
  const blockInput = { ...input(f.ids[0]), attendancePlanId: plan.id, plannedStart: morning + hour, plannedEnd: morning + 3 * hour };
  const first = store.saveLearningBlock(blockInput);
  const second = store.saveLearningBlock({
    ...input(f.ids[0]), attendancePlanId: plan.id, plannedStart: morning + 6 * hour, plannedEnd: morning + 8 * hour,
  });
  const draft = store.saveLearningTasks({ ...change(first),
    tasks: [task("A"), task("B"), task("C", "home_school")] });
  assert.deepEqual(draft.tasks.map(item => item.position), [1, 2, 3]);
  assert(draft.tasks.every(item => item.status === "planned"));
  assert.throws(() => store.saveLearningTasks({ ...change(draft), tasks: [...draft.tasks, task("D")] }), failure("invalid"));
  assert.throws(() => store.protectionConnection().prepare(`INSERT INTO learning_tasks
    (id,block_id,position,category,content,status) VALUES(?,?,4,'foundation','D','planned')`).run(randomUUID(), first.id),
  /CHECK/);
  let now = morning;
  t.mock.method(Date, "now", () => now);
  const arrival = store.recordAttendance({ ...change(plan), action: "checkIn", at: morning });
  now = morning + hour;
  const started = store.recordLearningOutcome({ ...change(draft), action: "start", at: morning + hour });
  assert.throws(() => store.saveLearningTasks({ ...change(started), tasks: [] }), failure("conflict"));
  now = morning + 3 * hour;
  const withResult = store.recordTaskOutcome({ ...change(started), taskId: draft.tasks[0].id, status: "done", resultNotes: "Observed" });
  const finished = store.recordLearningOutcome({ ...change(withResult), action: "finish" });
  now = morning + 6 * hour;
  const later = store.recordLearningOutcome({ ...change(second), action: "start", at: morning + 6 * hour });
  now = morning + 8 * hour;
  const laterDone = store.recordLearningOutcome({ ...change(later), action: "finish", at: morning + 8 * hour });
  now = morning + 10 * hour;
  const left = store.recordAttendance({ ...change(arrival), action: "checkOut", at: now });
  assert.throws(() => store.saveAttendancePlan({ ...change(left), startAt: morning + 7 * day }), failure("conflict"));
  f.close();
  assert.equal(left.checkOutAt - left.checkInAt, 10 * hour);
  assert.equal(finished.actualEnd - finished.actualStart + laterDone.actualEnd - laterDone.actualStart, 4 * hour);
  assert.equal(f.store.learningBlocksForAttendance(plan.id).length, 2);
  assert.deepEqual(f.store.learningBlock(first.id), finished);
  assert.deepEqual(f.store.learningBlock(second.id), laterDone);
  assert.deepEqual(finished.tasks.map(item => [item.status, item.resultNotes]), [["done", "Observed"], ["planned", null], ["planned", null]]);
});

test("a student must exist in M1 and links never switch to another student", t => {
  const f = fixture(t), { store } = f, start = nextSaturday();
  assert.throws(() => store.saveAttendancePlan({ ...input(randomUUID()), startAt: start }), failure("invalid"));
  const plan = store.saveAttendancePlan({ ...input(f.ids[0]), startAt: start });
  assert.throws(() => store.saveAttendancePlan({ ...input(f.ids[1], plan.id, plan.revision), startAt: start }),
    failure("conflict"));
  assert.throws(() => store.saveLearningBlock({
    ...input(f.ids[1]), attendancePlanId: plan.id, plannedStart: start, plannedEnd: start + hour,
  }), failure("invalid"));
  const raw = store.protectionConnection();
  assert.throws(() => raw.prepare(`INSERT INTO learning_blocks
    (id,student_id,attendance_plan_id,planned_start,planned_end,status,notes,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,'planned','',1,0,0)`).run(randomUUID(),f.ids[1],plan.id,start,start+hour), /FOREIGN KEY/);
  assert.doesNotThrow(() => verifyOperationsStudentLinks(raw, new Set(f.ids)));
  assert.throws(() => verifyOperationsStudentLinks(raw, new Set([f.ids[1]])), failure("recovery"));
});

test("actual learning protects an appointment even before its scheduled start", t => {
  const f = fixture(t), { store } = f, start = nextSaturday();
  const plan = store.saveAttendancePlan({ ...input(f.ids[0]), startAt: start, endAt: start + 3 * hour });
  const block = store.saveLearningBlock({
    ...input(f.ids[0]), attendancePlanId: plan.id, plannedStart: start + hour, plannedEnd: start + 2 * hour,
  });
  let now = start - 5 * 60_000;
  t.mock.method(Date, "now", () => now);
  store.recordLearningOutcome({ ...change(block), action: "start" });
  assert.throws(() => store.saveAttendancePlan({ ...change(plan), startAt: start + hour }), failure("conflict"));
  now = start;
  assert.throws(() => store.recordAttendance({ ...change(plan), action: "absent" }), failure("conflict"));
  assert.deepEqual(store.attendancePlan(plan.id), plan);
});

test("request replay survives a lost COMMIT reply and a newer revision", t => {
  const f = fixture(t), request = { ...input(f.ids[0]), startAt: nextSaturday() };
  const db = f.store.protectionConnection(), exec = db.exec.bind(db);
  let once = true;
  t.mock.method(db, "exec", sql => {
    exec(sql);
    if (sql === "COMMIT" && once) { once = false; throw new Error(" lost reply"); }
  });
  assert.throws(() => f.store.saveAttendancePlan(request), failure("unknown"));
  assert.throws(() => f.store.saveAttendancePlan(request), failure("recovery"));
  assert.throws(() => f.store.protectionConnection(), failure("busy"));
  assert.throws(() => f.close(), failure("unknown"));
  const stored = f.store.attendancePlan(request.id);
  const newer = f.store.saveAttendancePlan({ ...change(stored), startAt: request.startAt + hour });
  assert.equal(newer.revision, 2);
  assert.deepEqual(f.store.saveAttendancePlan(request), stored);
  assert.equal(f.store.attendancePlan(stored.id).revision, 2);
  assert.throws(() => f.store.saveAttendancePlan({ ...request, startAt: request.startAt + hour }), failure("conflict"));
  assert.throws(() => f.store.saveAttendancePlan({ ...change(stored), startAt: request.startAt + 2 * hour }), failure("conflict"));
  assert.equal(f.store.protectionConnection().prepare("SELECT count(*) AS n FROM operation_changes").get().n, 2);
});

test("failed task saves roll back edits, request receipts and history together", t => {
  const f = fixture(t), { store } = f, start = nextSaturday();
  const block = store.saveLearningBlock({ ...input(f.ids[0]), plannedStart: start, plannedEnd: start + hour });
  const original = store.saveLearningTasks({ ...change(block), tasks: [task("Original")] });
  const request = { ...change(original), tasks: [task("New 1"), task("New 2")] };
  const db = store.protectionConnection(), exec = db.exec.bind(db);
  let once = true;
  t.mock.method(db, "exec", sql => {
    if (sql === "COMMIT" && once) { once = false; throw new Error("forced pre-commit failure"); }
    exec(sql);
  });
  assert.throws(() => store.saveLearningTasks(request), failure("unknown"));
  assert.deepEqual(store.learningBlock(block.id), original);
  assert.equal(db.prepare("SELECT count(*) AS n FROM operation_changes").get().n, 2);
  assert.equal(db.prepare("SELECT 1 FROM operation_requests WHERE request_id=?").get(request.requestId), undefined);
  assert.deepEqual(store.saveLearningTasks(request).tasks.map(row => row.content), ["New 1", "New 2"]);
});

test("rollback failure blocks later writes and backup connections until reopen", t => {
  const f = fixture(t), { store } = f, req = { ...input(f.ids[0]), startAt: nextSaturday() };
  const raw = store.protectionConnection(), exec = raw.exec.bind(raw);
  t.mock.method(raw, "exec", sql => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("write failure");
    exec(sql);
  });
  assert.throws(() => store.saveAttendancePlan(req), failure("unknown"));
  assert.throws(() => store.saveAttendancePlan(req), failure("recovery"));
  assert.throws(() => store.protectionConnection(), failure("busy"));
  assert.throws(() => f.close(), failure("unknown"));
  assert.equal(f.store.attendancePlan(req.id), undefined);
  assert.equal(f.store.saveAttendancePlan(req).revision, 1);
});

test("process interruption preserves only the committed appointment and its receipt", t => {
  const f = fixture(t);
  void f.store;
  f.close();
  for (const stage of ["before", "after"]) {
    const req = { ...input(f.ids[0]), startAt: nextSaturday() };
    const child = spawnSync(process.execPath, ["-e", `
      const { join } = require("node:path");
      const [, , modulePath] = process.argv;
      const { OperationsDatabase } = require(modulePath);
      const { WorkspaceDatabase } = require(process.argv[1]);
      const { dir, req, stage } = JSON.parse(process.argv[3]);
      const m1 = WorkspaceDatabase.open(join(dir, "mvp.sqlite3"), join(dir, "mvp.initialized"));
      const store = OperationsDatabase.open(dir, m1);
      const db = store.protectionConnection(), exec = db.exec.bind(db);
      db.exec = sql => {
        if (sql === "COMMIT" && stage === "before") process.exit(71);
        exec(sql);
        if (sql === "COMMIT" && stage === "after") process.exit(72);
      };
      store.saveAttendancePlan(req);
    `, require.resolve("../build/database.js"), require.resolve("../build/operations.js"), JSON.stringify({ dir: f.dir, req, stage })],
    { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(child.status, stage === "before" ? 71 : 72, child.stderr);
    const row = f.store.attendancePlan(req.id);
    if (stage === "before") {
      assert.equal(row, undefined);
      assert.equal(f.store.protectionConnection().prepare("SELECT 1 FROM operation_requests WHERE request_id=?").get(req.requestId), undefined);
    } else {
      assert.equal(row.revision, 1);
      assert.deepEqual(f.store.saveAttendancePlan(req), row);
    }
    f.close();
  }
});

test("an interrupted initialization and missing or incorrect markers preserve the suspect library", t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const { OperationsDatabase } = require(process.argv[1]);
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql.startsWith("PRAGMA application_id=")) process.exit(73);
      return exec.call(this, sql);
    };
    OperationsDatabase.open(process.argv[2], { students: () => [] }, true);
  `, require.resolve("../build/operations.js"), f.dir], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  assert(existsSync(f.file));
  assert(!existsSync(f.marker));
  const interrupted = readFileSync(f.file);
  assert.throws(() => OperationsDatabase.open(f.dir, f.m1), failure("recovery"));
  assert(readFileSync(f.file).equals(interrupted));

  const healthy = fixture(t);
  void healthy.store;
  healthy.close();
  const clean = readFileSync(healthy.file);
  writeFileSync(healthy.marker, "bad-marker!\n");
  assert.throws(() => OperationsDatabase.open(healthy.dir, healthy.m1), failure("recovery"));
  assert(readFileSync(healthy.file).equals(clean));
  renameSync(healthy.marker, join(healthy.dir, "kept.marker"));
  assert.throws(() => OperationsDatabase.open(healthy.dir, healthy.m1), failure("recovery"));
  assert(readFileSync(healthy.file).equals(clean));
});

test("opening an existing operations profile never recreates a missing database and marker", t => {
  const f = fixture(t);
  assert.throws(() => OperationsDatabase.open(f.dir, f.m1), failure("recovery"));
  assert.equal(existsSync(join(f.dir, "operations.sqlite3")), false);
  assert.equal(existsSync(join(f.dir, "operations.initialized")), false);
});
