const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { OperationsDatabase } = require("../build/operations.js");
const { listScheduleWeek, readSchedulePlan, saveSchedulePlan } = require("../build/schedule-api.js");
const { attendanceCounts, isLateArrival, mondayOf, openingHours, shanghaiMinute, shanghaiParts, shiftDate, weekRange } = require("../build/schedule-calendar.js");
const { enrollmentStatus } = require("../build/student-records.js");

const isCode = code => error => error.code === code;
const future = (() => {
  const week = mondayOf(shanghaiParts(Date.now()).date);
  return shiftDate(week, 7);
})();
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "sw-weekly-"));
  const m1 = WorkspaceDatabase.open(join(dir, "mvp.sqlite3"), join(dir, "mvp.initialized"));
  const students = () => m1.students();
  const ids = ["SYNTH-T01", "SYNTH-T02"].map(alias => m1.createStudent({
    id: randomUUID(), alias, grade: "G7", subjects: "Math", goal: "", notes: "",
  }).id);
  let db = OperationsDatabase.open(dir, m1, true);
  t.after(() => { try { db.close(); } finally { m1.close(); } });
  return {
    ids,
    save: request => saveSchedulePlan(db, students, request),
    get: id => readSchedulePlan(db, students, id),
    list: query => listScheduleWeek(db, students, query),
    connection: () => db.protectionConnection(),
    reopen: (close = () => db.close()) => { close(); db = OperationsDatabase.open(dir, m1); },
    close: () => db.close(),
  };
}
function input(studentId, date = shiftDate(future, 1), start = "16:00", end = "18:00", other = {}) {
  return { id: randomUUID(), requestId: randomUUID(), studentId, expectedRevision: 0, kind: "regular",
    startAt: shanghaiMinute(date, start), endAt: shanghaiMinute(date, end), ...other };
}

test("shared attendance summary counts distinct students separately from visits", t => {
  const f = fixture(t);
  const first = f.save(input(f.ids[0]));
  f.save(input(f.ids[0], shiftDate(future, 1), "18:00", "20:00"));
  f.save(input(f.ids[1]));
  assert.deepEqual(attendanceCounts(f.list({ monday: future })), { students: 2, visits: 3 });
  assert.deepEqual(attendanceCounts(f.list({ monday: future, studentId: f.ids[0] })), { students: 1, visits: 2 });
  assert.equal(isLateArrival(first), false);
  assert.equal(isLateArrival({ ...first, checkInAt: first.startAt + 59_999 }), false);
  assert.equal(isLateArrival({ ...first, checkInAt: first.startAt + 60_000 }), true);
});

test("renewed enrollment records keep their own period as Shanghai crosses midnight", () => {
  const older = { startsOn: "2026-11-01", endsOn: "2026-11-24", status: "有效" };
  const renewal = { startsOn: "2026-11-25", endsOn: "2026-12-24", status: "有效" };
  const midnight = shanghaiMinute("2026-11-25", "00:00");
  const last = shanghaiParts(midnight - 1).date, next = shanghaiParts(midnight).date;
  assert.equal(enrollmentStatus(older, last), "今日到期");
  assert.equal(enrollmentStatus(renewal, last), "尚未生效");
  assert.equal(enrollmentStatus(older, next), "已到期");
  assert.equal(enrollmentStatus(renewal, next), "有效期内");
  assert.equal(enrollmentStatus(renewal, "2026-12-10"), "还有 14 天到期");
  assert.equal(enrollmentStatus({ ...renewal, status: "已取消" }, "2026-12-10"), "已取消");
});

test("Shanghai week boundaries are independent of system timezone and include real calendar dates only", t => {
  const tz = process.env.TZ;
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  process.env.TZ = "America/Los_Angeles";
  const boundary = weekRange("2027-01-04");
  assert.equal(boundary.startAt, Date.UTC(2027, 0, 3, 16));
  assert.deepEqual(shanghaiParts(boundary.startAt - 60_000), { date: "2027-01-03", time: "23:59" });
  assert.deepEqual(shanghaiParts(boundary.startAt), { date: "2027-01-04", time: "00:00" });
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
  assert.equal(weekRange("2027-01-03"), null);
  assert.equal(shanghaiMinute("2027-02-29", "08:00"), null);
  assert.equal(shanghaiMinute("2028-02-29", "24:00"), null);
  assert.equal(shanghaiMinute("2028-02-29", "08:00"), Date.UTC(2028, 1, 29, 0));
  assert.deepEqual(openingHours("2027-01-05"), { start: "16:00", end: "21:00" });
  assert.deepEqual(openingHours("2027-01-09"), { start: "08:00", end: "18:00" });
  assert.equal(openingHours("2027-01-04"), null);
});

test("weekly queries cover local Sunday through Monday without double-counting and filter a real M1 UUID", t => {
  const f = fixture(t);
  const sunday = f.save(input(f.ids[0], shiftDate(future, 6), "16:00", "18:00"));
  const monday = f.save(input(f.ids[1], shiftDate(future, 7), "00:00", "02:00",
    { exception: { confirmed: true, reason: "合成边界例外" } }));
  assert.equal(new Date(monday.startAt).getUTCDay(), 0);
  assert.deepEqual(f.list({ monday: future }).map(row => row.id), [sunday.id]);
  assert.deepEqual(f.list({ monday: shiftDate(future, 7) }).map(row => row.id), [monday.id]);
  assert.equal(f.list({ monday: future, studentId: f.ids[1] }).length, 0);
  assert.throws(() => f.list({ monday: future, studentId: randomUUID() }), isCode("invalid"));
  assert.throws(() => f.list({ monday: shiftDate(future, 1) }), isCode("invalid"));
  assert.throws(() => f.get("bad"), isCode("invalid"));
});

test("schedule IPC validation refuses malformed saves, forged student IDs and incomplete exceptions", t => {
  const f = fixture(t), request = input(f.ids[0]);
  const attempts = [null, [], { ...request, id: "G7" }, { ...request, requestId: null },
    { ...request, expectedRevision: -1 }, { ...request, expectedRevision: "0" }, { ...request, kind: "remote" },
    { ...request, studentId: randomUUID() }, { ...request, startAt: request.startAt + 1 },
    { ...request, endAt: request.startAt }, { ...request, endAt: request.endAt + 86_400_000 },
    { ...request, exception: { confirmed: false, reason: "不允许" } },
    { ...request, exception: { confirmed: true, reason: " ".repeat(501) } },
    input(f.ids[0], future, "17:00", "19:00")];
  for (const candidate of attempts) assert.throws(() => f.save(candidate), isCode("invalid"));
  assert.deepEqual(f.list({ monday: future }), []);
});

test("weekly create and edit keep shared slots, revisions and idempotent receipts across reopen", t => {
  const f = fixture(t), request = input(f.ids[0]);
  const plan = f.save(request);
  assert.deepEqual(f.save(request), plan);
  assert.equal(f.save(input(f.ids[1])).startAt, request.startAt);
  assert.throws(() => f.save(input(f.ids[0])), isCode("conflict"));
  const changed = { ...request, requestId: randomUUID(), expectedRevision: plan.revision,
    endAt: request.endAt + 60 * 60_000 };
  assert.equal(f.save(changed).revision, 2);
  assert.throws(() => f.save({ ...changed, requestId: randomUUID() }), isCode("conflict"));
  assert.throws(() => f.save({ ...changed, kind: "whole_day" }), isCode("conflict"));
  f.reopen();
  assert.equal(f.get(plan.id).revision, 2);
  assert.equal(f.save(request).revision, 1);
  assert.equal(f.save(changed).revision, 2);
  assert.equal(f.list({ monday: future }).length, 2);
});

test("schedule IPC reads do not show uncommitted rows after a failed rollback", t => {
  const f = fixture(t), candidate = input(f.ids[0]);
  const db = f.connection(), exec = db.exec.bind(db);
  t.mock.method(db, "exec", sql => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("synthetic transaction failure");
    return exec(sql);
  });
  assert.throws(() => f.save(candidate), isCode("unknown"));
  assert.equal(db.isTransaction, true);
  assert.throws(() => f.list({ monday: future }), isCode("busy"));
  assert.throws(() => f.get(candidate.id), isCode("busy"));
  f.reopen(() => assert.throws(f.close, isCode("unknown")));
  assert.equal(f.get(candidate.id), null);
  assert.deepEqual(f.list({ monday: future }), []);
});
