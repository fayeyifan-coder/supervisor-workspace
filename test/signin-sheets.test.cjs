const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const Excel = require("exceljs");
const { defaultSigninSlots, signinDates } = require("../build/signin-calendar.js");
const { shanghaiMinute } = require("../build/schedule-calendar.js");
const { readSigninPlan, adjustSigninPlan, signinWorkbook, loadSigninTemplate, writeSigninFile } = require("../build/signin-sheets.js");
const { fakeSigninTemplate } = require("./signin-template-fixture.cjs");

test("Shanghai weekday and four/five weekend calendar dates include cross-year weeks", () => {
  assert.deepEqual(signinDates("weekday", "2025-01-01"), ["2024-12-31", "2025-01-01", "2025-01-02", "2025-01-03"]);
  assert.equal(signinDates("saturday", "2027-01").length, 5);
  assert.equal(signinDates("sunday", "2027-01").length, 5);
  assert.equal(signinDates("saturday", "2027-02").length, 4);
  assert.equal(signinDates("sunday", "2027-02").length, 4);
  assert.deepEqual(signinDates("sunday", "2027-19"), []);
});

test("three synthetic templates produce locally readable A4 sheets with correct days and entirely blank signatures", async () => {
  const students = [{id: randomUUID(), alias: "=合成中文学生"}, {id: randomUUID(), alias: "合成可调整"}];
  for (const [kind, period] of [["weekday", "2025-01-01"], ["saturday", "2027-01"], ["sunday", "2027-02"], ["sunday", "2027-01"]]) {
    const dates = signinDates(kind, period), date = dates[0];
    const visit = (student, time) => ({studentId: students[student].id, startAt: shanghaiMinute(date, time), source: "appointment"});
    const preview = readSigninPlan({plannedSigninVisits: () => ({visits: [visit(0, "08:05"), visit(0, "08:06")], conflicts: [visit(1, "09:30")]})},
      students, {kind, period, slots: kind === "weekday" ? [] : defaultSigninSlots(), includePendingFlex: false});
    assert.equal(preview.groups[0].members[0].days.length, 1);
    assert.equal(preview.warnings.length, 1);
    adjustSigninPlan(preview, students, [{group: 0, studentId: students[1].id, date: dates.at(-1), include: true}]);
    const template = await fakeSigninTemplate(kind), result = await signinWorkbook(template, preview);
    const check = new Excel.Workbook();
    await check.xlsx.load(result);
    const first = check.worksheets[0];
    assert.equal(check.worksheets.length, kind === "weekday" ? 1 : 4);
    assert.equal(first.pageSetup.paperSize, 9);
    assert.equal(first.pageSetup.orientation, "portrait");
    assert.equal(first.pageSetup.printTitlesRow, "1:4");
    assert.equal(first.getCell(4, 2 + dates.length).value, dates.at(-1).slice(5).replace("-", "/"));
    assert.equal(first.getCell("B5").value, students[0].alias);
    assert.equal(first.getCell("B6").value, students[1].alias);
    for (const sheet of check.worksheets) {
      assert.doesNotMatch(JSON.stringify({values: sheet.getSheetValues(), header: sheet.headerFooter}), /must not be copied/);
      for (let row = 5; row <= 30; row++) {
        for (let column = 3; column <= (kind === "weekday" ? 6 : 2 + dates.length); column++) assert.equal(sheet.getCell(row, column).value, null);
      }
    }
  }
});

test("real local output never overwrites and identical synthetic template cannot be selected as output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sw-signin-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const output = join(directory, "合成签到表.xlsx");
  const template = await fakeSigninTemplate("weekday");
  const preview = {groups: [], input: {kind:"weekday"}};
  assert.equal((await writeSigninFile(output, template, preview, [])).location, output);
  assert.deepEqual(await loadSigninTemplate(output), template);
  await assert.rejects(() => writeSigninFile(output, Buffer.from("different"), preview, []), {code: "conflict"});
  assert.deepEqual(await readFile(output), template);
  await assert.rejects(() => signinWorkbook(Buffer.alloc(40), preview), {code: "invalid"});
});

test("v8 synthetic backup restores natively to v10 and a new v10 backup preserves all legacy and new schedule rows", async t => {
  const { exportFixture } = require("./export-fixture.cjs");
  const { ProtectionFiles, prepareProtectionRestore, validateProtection } = require("../build/offline-protection.js");
  const { businessExportDocument, businessExportPayload } = require("../build/business-export.js");
  const { WorkspaceDatabase } = require("../build/database.js");
  const { OperationsDatabase } = require("../build/operations.js");
  const f = exportFixture(t, 2, 8);
  const before = f.capture();
  const legacy = businessExportDocument(before, false);
  const upgraded = prepareProtectionRestore(before, 2, 10);
  const native = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
  const isolated = await native.restore(f.dir, upgraded);
  assert.equal((await native.inspect(f.dir, isolated.profileName, 2, 10)).summary.students, 2);
  assert.equal(validateProtection(upgraded).manifest.databases[4].schemaVersion, 3);
  assert.throws(() => prepareProtectionRestore(upgraded, 2, 8), /不能降级/);
  const current = businessExportDocument(upgraded, false);
  assert.equal(current.tables.length, 29);
  assert.equal(current.tables.filter(table => table.role !== "internal").length, 26);
  for (const prior of legacy.tables) assert.deepEqual(current.tables.find(table => table.table === prior.table), prior);
  const { verifyActiveProfile } = require("../build/profile-activation.js");
  const inspected = await native.inspect(f.dir, isolated.profileName, 2, 10);
  const activated = await native.restore(f.dir, inspected.bytes, true);
  const profile = verifyActiveProfile(f.dir, {name: activated.profileName, digest: inspected.digest}, true, 2, 10);
  const directory = join(profile, "data");
  const { WorkLogDatabase } = require("../build/worklog.js");
  const { GrowthProfileDatabase } = require("../build/growth-profile.js");
  const { IntakeStore } = require("../build/student-intake.js");
  const students = WorkspaceDatabase.open(join(directory, "mvp.sqlite3"), join(directory, "mvp.initialized"), 10);
  const work = WorkLogDatabase.open(join(directory, "worklog.sqlite3"), join(directory, "worklog.initialized"));
  const growth = GrowthProfileDatabase.open(join(directory, "growth.sqlite3"), join(directory, "growth.initialized"));
  const intake = IntakeStore.open(join(directory, "student-intake.sqlite3"), join(directory, "student-intake.initialized"));
  const store = OperationsDatabase.open(directory, students);
  try {
    const slot = {id: randomUUID(), day: 2, start: "09:00", end: "10:00"};
    const studentId = f.studentId;
    store.changeCycleSchedule({action: "rule", id: randomUUID(), requestId: randomUUID(), studentId, expectedRevision: 0,
      definition: {kind: "fixed", startsOn: "2030-01-01", endsOn: null, paused: false, slots: [slot]}});
    const query = {kind: "weekday", period: "2030-01-01", slots: []};
    assert.equal(readSigninPlan(store, students.students(), query).groups[0].members[0].studentId, studentId);
    assert.equal(store.listAttendancePlans(shanghaiMinute("2030-01-01", "00:00"), shanghaiMinute("2030-01-02", "00:00")).length, 0);
    store.changeCycleSchedule({action: "generate", from: "2030-01-01", to: "2030-01-01"});
    const [plan] = store.listAttendancePlans(shanghaiMinute("2030-01-01", "00:00"), shanghaiMinute("2030-01-02", "00:00"));
    store.recordAttendance({id: plan.id, studentId, requestId: randomUUID(), expectedRevision: 1, action: "leave", reason: "合成请假"});
    assert.equal(readSigninPlan(store, students.students(), query).groups[0].members.length, 0);
    const { captureProtection } = require("../build/offline-protection.js");
    const created = captureProtection([students, work, growth, intake, store], "0.3.0", 2, 10);
    const restored = await native.restore(f.dir, created);
    assert.equal((await native.inspect(f.dir, restored.profileName, 2, 10)).summary.attendancePlans, 2);
    const data = businessExportDocument(created, false);
    for (const key of ["schedule_rule_revisions", "schedule_origins", "attendance_exceptions"]) {
      assert.equal(data.tables.find(table => table.table === key).sourceRows, 1);
    }
    const payload = await businessExportPayload(data);
    const json = JSON.parse(payload.files.find(file => file.name === "business-data.json").bytes.toString("utf8"));
    assert.equal(json.m1Version, 10);
    assert.equal(json.tables.find(table => table.table === "attendance_exceptions").rows[0].plan_id, plan.id);
    const excel = new Excel.Workbook();
    await excel.xlsx.load(payload.files.find(file => file.name === "business-data.xlsx").bytes);
    assert(excel.getWorksheet(data.tables.find(table => table.table === "attendance_exceptions").sheet));
  } finally { for (const database of [store, intake, growth, work, students]) database.close(); }
  assert.deepEqual(businessExportDocument(f.capture(), false).tables, legacy.tables);
});

test("weekday preview defaults to unconfirmed flexible candidates, combines sources and keeps one slot per student and date", async t => {
  const { exportFixture } = require("./export-fixture.cjs");
  const { operations, m1 } = exportFixture(t, 3, 10);
  const [combined, flexOnly, manual] = m1.students();
  const date = "2030-01-01", now = shanghaiMinute("2029-12-30", "09:00");
  for (const [student,kind,start,end] of [[combined,"fixed","09:00","10:00"],[combined,"flex","16:00","20:00"],
      [flexOnly,"flex","16:00","20:00"]]) {
    operations.changeCycleSchedule({action:"rule", id:randomUUID(), studentId:student.id, requestId:randomUUID(),
      expectedRevision:0, definition:{kind, startsOn:date, endsOn:null, paused:false,
        slots:[{id:randomUUID(), day:2,start,end}]}});
  }
  const input = {kind:"weekday", period:date, slots:[]};
  const before = operations.listAttendancePlans(shanghaiMinute(date,"00:00"),shanghaiMinute("2030-01-02","00:00"));
  const preview = readSigninPlan(operations,m1.students(),input,now);
  const byStudent = id => preview.groups[0].members.find(member => member.studentId === id);
  assert.equal(preview.input.includePendingFlex,true);
  assert.deepEqual(byStudent(combined.id).days,[{date,sources:["rule","flex"]}]);
  assert.deepEqual(byStudent(flexOnly.id).days,[{date,sources:["flex"]}]);
  assert.deepEqual(readSigninPlan(operations,m1.students(),{...input,includePendingFlex:false},now).groups[0].members
    .map(member=>[member.studentId,member.days]),[[combined.id,[{date,sources:["rule"]}]]]);
  adjustSigninPlan(preview,m1.students(),[{group:0,studentId:manual.id,date,include:true}]);
  assert.deepEqual(byStudent(manual.id).days,[{date,sources:["manual"]}]);
  const workbook = new Excel.Workbook();
  await workbook.xlsx.load(await signinWorkbook(await fakeSigninTemplate("weekday"),preview));
  const sheet = workbook.worksheets[0];
  for (const [student, code] of [[combined,"规"],[flexOnly,"候"],[manual,"补"]]) {
    const item = preview.groups[0].members.findIndex(row=>row.studentId===student.id) + 5;
    assert.equal(sheet.getCell(item,7).value.split(" ")[0],code);
    for (const column of [3,4,5,6]) assert.equal(sheet.getCell(item,column).value,null);
  }
  assert.deepEqual(operations.listAttendancePlans(shanghaiMinute(date,"00:00"),shanghaiMinute("2030-01-02","00:00")),before);
  assert.equal(operations.flexWindows(date,date).length,2);
});

test("both weekend grouping options cover exact boundaries and month ends with blank signatures", async () => {
  const student = {id:randomUUID(),alias:"合成长时段"};
  const row = (date,start,end) => ({studentId:student.id, source:"appointment", startAt:shanghaiMinute(date,start),endAt:shanghaiMinute(date,end)});
  const store = {plannedSigninVisits:()=>({visits:[row("2026-12-26","08:00","12:00"),row("2027-01-02","08:00","12:00"),
    row("2027-01-30","10:00","12:00"),row("2027-02-06","08:00","12:00")], conflicts:[]})};
  for (const [month, dates] of [["2026-12",["2026-12-26"]],["2027-01",["2027-01-02","2027-01-30"]]]) {
    for (const grouping of ["start","coverage"]) {
      const preview=readSigninPlan(store,[student],{kind:"saturday",period:month,slots:defaultSigninSlots(),weekendGrouping:grouping});
      assert.deepEqual(preview.groups[0].members.flatMap(member=>member.days.map(day=>day.date)),dates.slice(0,1));
      assert.deepEqual(preview.groups[1].members.flatMap(member=>member.days.map(day=>day.date)),grouping==="coverage" ? dates : dates.slice(1));
      assert.equal(preview.groups[2].members.length,0);
      const workbook=new Excel.Workbook();
      await workbook.xlsx.load(await signinWorkbook(await fakeSigninTemplate("saturday"),preview));
      assert.equal(workbook.worksheets[0].getCell("B5").value,student.alias);
      for (const sheet of workbook.worksheets) {
        for (let col=3;col<3+preview.dates.length;col++) assert.equal(sheet.getCell(5,col).value,null);
      }
    }
  }
});
