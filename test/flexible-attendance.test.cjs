const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { exportFixture } = require("./export-fixture.cjs");
const { shanghaiMinute } = require("../build/schedule-calendar.js");
const { readAttendanceBoard } = require("../build/learning-api.js");
const { businessExportDocument } = require("../build/business-export.js");
const { prepareProtectionRestore, validateProtection } = require("../build/offline-protection.js");
const at = (date, time) => shanghaiMinute(date, time);

function addFlex(operations, studentId) {
 const rule = { action:"rule", id:randomUUID(), studentId, requestId:randomUUID(), expectedRevision:0,
   definition:{kind:"flex", startsOn:"2030-01-01", endsOn:"2030-02-01", paused:false,
    slots:[{id:randomUUID(),day:2,start:"16:00",end:"21:00"}]} };
 return operations.changeCycleSchedule(rule).rule;
}

test("unconfirmed windows are not attendance records; confirmation uses a chosen time and actual arrival uses the actual instant", t => {
 const f = exportFixture(t, 1, 10), { operations, studentId } = f;
 const clock = Date.now; let now = at("2030-01-01", "17:08"); Date.now = () => now; t.after(() => { Date.now = clock; });
 const rule = addFlex(operations, studentId);
 assert.equal(rule.durationMinutes, 120);
 assert.equal(operations.changeCycleSchedule({action:"generate",from:"2030-01-01",to:"2030-01-08"}).result.created,0);
 assert.equal(readAttendanceBoard(operations, () => f.m1.students(), now).entries.length, 0);
 const [today, future] = operations.flexWindows("2030-01-01","2030-01-08");
 assert.equal(today.start,"16:00");
 assert.throws(() => operations.changeCycleSchedule({action:"confirmFlex",window:future,start:"20:00"}), /窗口/);
 const confirmation = {action:"confirmFlex",window:future,start:"17:30"};
 const scheduled = operations.changeCycleSchedule(confirmation).plan;
 assert.equal(scheduled.status,"confirmed");
 assert.equal(scheduled.startAt,at("2030-01-08","17:30"));
 assert.equal(scheduled.checkInAt,null);
 assert.equal(operations.changeCycleSchedule(confirmation).plan.id,scheduled.id);
 assert.throws(() => operations.changeCycleSchedule({...confirmation,start:"17:00"}),/已有/);
 const command = {action:"arriveFlex",window:today};
 const visit = operations.changeCycleSchedule(command).plan;
 assert.equal(visit.status,"attended"); assert.equal(visit.actualOnly,true);
 assert.equal(visit.startAt,now); assert.equal(visit.checkInAt,now);
 assert.equal(readAttendanceBoard(operations, () => f.m1.students(), now).entries[0].status,"checked_in");
 assert.equal(operations.changeCycleSchedule(command).plan.id,visit.id);
 assert.equal(operations.flexWindows("2030-01-01","2030-01-08").length,0);
 const walkIn = {action:"walkIn",studentId,requestId:randomUUID(),durationMinutes:60};
 assert.throws(() => operations.changeCycleSchedule(walkIn), /已有/);
 now += 30 * 60000;
 operations.recordAttendance({id:visit.id,studentId,requestId:randomUUID(),expectedRevision:1,action:"checkOut"});
 now += 120 * 60000;
 const temporary = operations.changeCycleSchedule(walkIn).plan;
 assert.equal(temporary.actualOnly,true);
 assert.equal(operations.changeCycleSchedule(walkIn).plan.id,temporary.id);
 const table = businessExportDocument(f.capture(),false).tables.find(row => row.table === "attendance_exceptions");
 assert.deepEqual(table.rows.map(x=>x.action),["walk_in","walk_in"]);
});

test("single-occurrence rescheduling and leave preserve the rule, history and future origin", t => {
 const f = exportFixture(t, 1, 10), { operations, studentId } = f;
 const rule = addFlex(operations, studentId);
 const [origin] = operations.flexWindows("2030-01-08","2030-01-08");
 const initial = operations.changeCycleSchedule({action:"confirmFlex",window:origin,start:"16:30"}).plan;
 const adjusted = operations.saveAttendancePlan({id:initial.id,studentId,requestId:randomUUID(),expectedRevision:1,
  startAt:at("2030-01-08","18:00"),endAt:at("2030-01-08","20:00"),changeReason:"合成调课"});
 assert.equal(adjusted.dayException.action,"rescheduled");
 assert.deepEqual(adjusted.cycleOrigin,initial.cycleOrigin);
 const leave = operations.recordAttendance({id:initial.id,studentId,requestId:randomUUID(),expectedRevision:2,action:"leave",reason:"合成请假"});
 assert.equal(leave.status,"cancelled");
 assert.equal(leave.dayException.action,"leave");
 assert.equal(operations.flexWindows("2030-01-08","2030-01-08").length,0);
 assert.equal(operations.flexWindows("2030-01-15","2030-01-15").length,1);
 assert.deepEqual(operations.scheduleConfiguration().rules,[rule]);
 const previous = exportFixture(t,1,9).capture();
 const upgraded = prepareProtectionRestore(previous,2,10);
 assert.equal(validateProtection(upgraded).manifest.databases[4].schemaVersion,3);
 assert.equal(businessExportDocument(upgraded,false).tables.find(row=>row.table==="attendance_exceptions").exportedRows,0);
});
