const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { writeFile, readFile } = require("node:fs/promises");
const Excel = require("exceljs");
const { fakeSigninTemplate } = require("../test/signin-template-fixture.cjs");
const { mondayOf, shanghaiMinute } = require("../build/schedule-calendar.js");

module.exports = async function verifyBatch3({ main, ui, api, ok, wait, click, profileShot, E, output, reopen }) {
  const clock = shanghaiMinute("2030-01-01", "08:30");
  async function setClock(at) {
    await main("Date.now=()=>" + at + ";true");
    await ui("Date.now=()=>" + at + ";true");
  }
  await setClock(clock);
  assert.equal(await main(E + ".app.getVersion()"), "0.3.0");
  assert.equal(ok(await api("studentRecordVersion")), 10);
  const id = () => randomUUID();
  const students = [];
  for (let index = 1; index <= 20; index++) {
    students.push(ok(await api("createStudent", {id:id(), alias:"合成排课" + String(index).padStart(2, "0"),
      grade:"七年级", subjects:"数学", goal:"", notes:""})));
  }
  const days = [2, 6, 0], applies = "2030-01-01";
  const slot = (day, start, end) => ({id:id(), day, start, end});
  async function rule(student, kind, slots) {
    return ok(await api("changeCycleSchedule", {action:"rule", id:id(), requestId:id(), studentId:student.id,
      expectedRevision:0, definition:{kind, startsOn:applies, endsOn:null, paused:false, slots}}));
  }
  for (const student of students) {
    await rule(student, "long_term", days.flatMap(day => [slot(day,"09:00","10:00"), slot(day,day === 2 ? "16:00" : "14:00",day === 2 ? "17:00" : "16:00")]));
  }
  const duplicate = await api("changeCycleSchedule", {action:"rule", id:id(), requestId:id(), studentId:students[0].id, expectedRevision:0,
    definition:{kind:"fixed", startsOn:applies, endsOn:null, paused:false, slots:[slot(2,"09:15","09:45")]}});
  assert.equal(duplicate.code, "conflict");
  await rule(students[0], "flex", [slot(3,"16:00","21:00")]);
  const span = {action:"generate", from: "2030-01-01", to: "2030-01-06"};
  assert.equal(ok(await api("changeCycleSchedule", span)).result.created, 120);
  assert.equal(ok(await api("changeCycleSchedule", span)).result.existing, 120);
  const week = mondayOf("2030-01-01"), monday = {monday: week};
  const plans = ok(await api("scheduleWeek", monday));
  assert.equal(plans.length, 120);
  assert.equal(ok(await api("scheduleWeek", {...monday, studentId: students[0].id})).length, 6);
  assert.equal(ok(await api("scheduleFlexWeek", monday)).length, 1);

  await reopen(); await setClock(clock);
  await click("全局总课表", "nav button");
  await click("日视图");
  await ui(`(()=>{const field=document.querySelector(".schedule-period input[type=date]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,"2030-01-01");field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await wait(() => ui('document.querySelector(".schedule-counts")?.textContent.includes("预计 20 人 · 40 次")'), "40 day positions in packaged schedule");
  await profileShot("fixed-schedule.png");

  const expected = ok(await api("attendanceBoard"));
  assert.equal(expected.entries.length, 40);
  await setClock(shanghaiMinute("2030-01-01", "09:01"));
  const visit = expected.entries.find(row => row.plan.studentId === students[0].id && row.plan.startAt === shanghaiMinute("2030-01-01","09:00")).plan;
  async function record(action, expectedRevision) {
    const requestId = id();
    const result = ok(await api("applyLearningChange", {command:"recordAttendance", action, requestId, expectedRevision,
      id:visit.id, attendanceId:visit.id, studentId:visit.studentId}));
    ok(await api("acknowledgeOperation", requestId, false));
    return result;
  }
  await record("checkIn", 1);
  await setClock(shanghaiMinute("2030-01-01", "10:11"));
  await record("checkOut", 2);
  await click("今日到校看板", "nav button");
  await click("刷新今日到校");
  await wait(() => ui('document.querySelector(".attendance-board")?.innerText.includes("70 分钟")'), "prior check-in/out surfaced");
  await click("实际名单", ".attendance-board button");
  assert.equal(await ui('document.querySelectorAll(".attendance-board-row").length'), 1);
  await profileShot("actual-attendance.png");

  await setClock(clock);
  await click("全局总课表", "nav button");
  await click("生成签到表");
  const variants = [["weekday", "2030-01-01"], ["saturday", "2030-03"], ["sunday", "2030-02"]];
  const samples = [];
  for (const [kind, period] of variants) {
    const slots = kind === "weekday" ? [] : [{start:"08:00",end:"10:00"}, {start:"10:00",end:"12:00"},
      {start:"14:00",end:"16:00"}, {start:"16:00",end:"18:00"}];
    const template = join(output, "合成空模板-" + kind + ".xlsx"), destination = join(output, "合成签到表-" + kind + ".xlsx");
    await writeFile(template, await fakeSigninTemplate(kind), {flag:"wx"});
    await main(`(()=>{const d=${E}.dialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(template)}]});d.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(destination)}});return true})()`);
    const input = {kind, period, slots};
    const {preview, key} = ok(await api("previewSignin", input));
    assert.equal(preview.dates.length, kind === "saturday" ? 5 : 4);
    assert.equal(preview.groups[0].members.length, 20);
    let saved;
    if (kind === "weekday") {
      await ui(`(()=>{const field=document.querySelector(".signin-panel input[type=date]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,${JSON.stringify(period)});field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
      await click("预览预计签到名单");
      await wait(() => ui('document.querySelectorAll(".signin-table tbody tr").length===20'), "render print roster");
      await profileShot("signin-roster-preview.png");
      await click("选择模板并导出 XLSX");
      await wait(() => ui('document.querySelector(".signin-panel [role=status]")?.textContent.includes("已保存 20 行名单")'), "renderer saved workbook");
    } else {
      saved = ok(await api("exportSignin", {input, key, changes:[]}));
      assert.equal(saved.names, 40);
    }
    const book = new Excel.Workbook();
    await book.xlsx.load(await readFile(destination));
    assert.equal(book.worksheets.length, preview.groups.length);
    assert.equal(book.worksheets[0].getCell("C5").value, null);
    assert.equal(book.worksheets[0].getCell("B5").value, students[0].alias);
    samples.push({kind, path:destination, dates:preview.dates.length, worksheets:book.worksheets.length});
  }
  await reopen(); await setClock(clock);
  const reloaded = ok(await api("scheduleWeek", monday));
  assert.equal(reloaded.length, 120);
  assert.equal(reloaded.find(row => row.id === visit.id).checkOutAt, shanghaiMinute("2030-01-01","10:11"));
  return { students:20, cycleAppointments:120, sameDayAppointments:40, isolatedPersonalAppointments:6,
    overlappingStudentRejected:true, duplicateGenerationCreatesNothing:true, actualOnsiteMinutes:70, samples, restarted:true };
};
