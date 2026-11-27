const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { exportFixture } = require("./export-fixture.cjs");
const { shanghaiMinute } = require("../build/schedule-calendar.js");
const { readSigninPlan } = require("../build/signin-sheets.js");

const at = (date, time = "00:00") => shanghaiMinute(date, time);
const tue = (start, end) => ({id:randomUUID(), day:2, start, end});
function save(ops, studentId, kind, startsOn, slots, previous, paused = false, endsOn = null) {
  const result = ops.changeCycleSchedule({action:"rule", id:previous?.id ?? randomUUID(), requestId:randomUUID(), studentId,
    expectedRevision:previous?.revision ?? 0, definition:{kind, startsOn, endsOn, paused, slots}});
  return result.rule;
}
const planned = (store, from, to) => store.listAttendancePlans(at(from), at(to));
const generate = (store, from, to) => store.changeCycleSchedule({action:"generate", from, to}).result;
const print = (f, period) => readSigninPlan(f.operations, f.m1.students(), {kind:"weekday", period, slots:[], includePendingFlex:false}, at("2029-12-30"));

test("future revision keeps the old rule for dates before it in all three read/write paths", async t => {
  const f = exportFixture(t, 2, 10), {operations:ops, studentId} = f;
  const flexId = f.m1.students().find(student => student.id !== studentId).id;
  const fixed = save(ops, studentId, "fixed", "2030-01-01", [tue("09:00","10:00")]);
  save(ops, studentId, "fixed", "2030-01-15", [tue("10:00","11:00")], fixed);
  const flex = save(ops, flexId, "flex", "2030-01-01", [tue("16:00","20:00")]);
  save(ops, flexId, "flex", "2030-01-15", [tue("17:00","21:00")], flex);
  await t.test("sign-in projection keeps the old date before any attendance is generated", () => {
    const old = print(f,"2030-01-01");
    assert.equal(old.groups[0].members[0]?.studentId,studentId);
  });
  await t.test("generation uses old and new date boundaries", () => {
    assert.equal(generate(ops, "2030-01-01", "2030-01-15").created, 3);
    assert.deepEqual(planned(ops, "2030-01-01","2030-01-16").map(row => [row.startAt,row.cycleOrigin.revision]),
      [[at("2030-01-01","09:00"),1],[at("2030-01-08","09:00"),1],[at("2030-01-15","10:00"),2]]);
  });
  await t.test("flex windows keep their selected revision and confirmation accepts the older origin", () => {
    const windows = ops.flexWindows("2030-01-01","2030-01-15");
    assert.deepEqual(windows.map(row=>[row.date,row.start,row.revision]), [["2030-01-01","16:00",1],
      ["2030-01-08","16:00",1],["2030-01-15","17:00",2]]);
    const {plan} = ops.changeCycleSchedule({action:"confirmFlex", window:windows[1], start:"16:30"});
    assert.equal(plan.cycleOrigin.revision,1);
  });
});

test("pause and resume apply on their start dates; rule edits cannot replace a generated rule/date", t => {
  const {operations:ops,studentId} = exportFixture(t, 1, 10);
  const initial = save(ops, studentId, "fixed", "2030-01-01", [tue("09:00","10:00")]);
  assert.equal(generate(ops,"2030-01-15","2030-01-15").created, 1);
  const already = planned(ops,"2030-01-15","2030-01-16")[0];
  const pause = save(ops, studentId, "fixed", "2030-01-15", [tue("10:00","11:00")], initial, true);
  save(ops, studentId, "fixed", "2030-01-29", [tue("11:00","12:00")], pause, false, "2030-02-01");
  assert.deepEqual(generate(ops,"2030-01-08","2030-02-05"), {created:2, existing:1, inactive:1, conflicts:0, elapsed:0});
  assert.deepEqual(generate(ops,"2030-01-08","2030-02-05"), {created:0, existing:3, inactive:1, conflicts:0, elapsed:0});
  assert.deepEqual(planned(ops,"2030-01-15","2030-01-16"),[already]);
  assert.deepEqual(planned(ops,"2030-01-08","2030-02-06").map(row=>row.cycleOrigin.revision),[1,1,3]);
  const flex = save(ops, studentId, "flex", "2030-01-01", [tue("16:00","20:00")]);
  const suspended = save(ops, studentId, "flex", "2030-01-15", flex.slots, flex, true);
  save(ops, studentId, "flex", "2030-01-29", [tue("17:00","21:00")], suspended);
  assert.deepEqual(ops.flexWindows("2030-01-08","2030-01-29").map(row=>[row.date,row.revision]),
    [["2030-01-08",1],["2030-01-29",3]]);
});

test("overlap checks use the effective previous interval instead of only the latest scheduled revision", t => {
  const {operations:ops,studentId} = exportFixture(t, 1, 10);
  const initial = save(ops, studentId, "fixed", "2030-01-01", [tue("09:00","11:00")]);
  save(ops, studentId, "fixed", "2030-01-15", [tue("11:00","12:00")], initial);
  assert.throws(() => save(ops, studentId, "fixed", "2030-01-08", [tue("10:00","11:00")],
    undefined, false, "2030-01-14"), /重叠/);
  assert.doesNotThrow(() => save(ops, studentId, "fixed", "2030-01-15", [tue("10:00","11:00")]));
});
