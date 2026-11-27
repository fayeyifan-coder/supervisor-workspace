const assert = require("node:assert/strict");
const test = require("node:test");
const { attendanceSummary, isLateArrival, minute, shanghaiMinute } = require("../build/schedule-calendar.js");
const { readAttendanceBoard } = require("../build/learning-api.js");

test("expected roster, actual people, arrivals and on-site minutes use independent sources", () => {
  const base = { studentId: "one", status: "attended", checkInAt: 0, checkOutAt: 120 * minute };
  const rows = [base, { ...base, checkInAt: 100 * minute, checkOutAt: 160 * minute },
    { ...base, status: "absent", studentId: "absent", checkInAt: null, checkOutAt: null },
    { ...base, status: "cancelled", studentId: "leave", checkInAt: null, checkOutAt: null },
    { ...base, actualOnly: true, studentId: "walk-in", checkOutAt: 31 * minute },
    { ...base, studentId: "ongoing", checkOutAt: null }];
  assert.deepEqual(attendanceSummary(rows), { expected: { students: 3, visits: 4 },
    actual: { students: 3, visits: 4 }, open: 1, onsiteMinutes: 191, effectiveLearningMinutes: null });
  assert.equal(isLateArrival({ actualOnly: true, startAt: 0, checkInAt: minute }), false);
  assert.equal(isLateArrival({ startAt: 0, checkInAt: minute }), true);
});

test("Shanghai daily board keeps leave and unconfirmed windows separate from recorded absence", () => {
  const now = shanghaiMinute("2031-01-02", "10:00"), plan = { studentId: "one", startAt: now };
  const flex = [{ id: "pending", studentId: "one" }];
  const board = readAttendanceBoard({ flexibilityEnabled: true, protectionConnection() {}, listAttendancePlans(from, to) {
    assert.equal(from, shanghaiMinute("2031-01-02", "00:00"));
    assert.equal(to, shanghaiMinute("2031-01-03", "00:00"));
    return [{ ...plan, status: "cancelled", dayException: { action: "leave" } }, { ...plan, status: "absent" }];
  }, flexWindows() { return flex; } }, () => [{ id: "one" }], now);
  assert.equal(board.date, "2031-01-02");
  assert.deepEqual(board.flexWindows, flex);
  assert.deepEqual(board.entries.map(row => row.status), ["leave", "absent"]);
  assert.equal(readAttendanceBoard({ protectionConnection() {}, listAttendancePlans: () => [] }, () => [], now).flexWindows, undefined);
});
