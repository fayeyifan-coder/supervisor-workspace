const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { shanghaiParts, shanghaiMinute, shiftDate, weekday } = require("../build/schedule-calendar.js");

module.exports = async function verifyStudentManagement({ main, ui, api, ok, wait, click, choose, profileShot, E, reopen }) {
  const id = () => randomUUID();
  const students = [];
  for (let i = 1; i <= 20; i++) {
    students.push(ok(await api("createStudent", { id: id(), alias: "虚构督学" + String(i).padStart(2, "0"), grade: "七年级",
      subjects: "数学", goal: "合成阶段学习目标", notes: "" })));
  }
  const [a, b] = students;
  const owner = { studentId: a.id };
  const today = shanghaiParts(Date.now()).date;
  const concern = ok(await api("createParentConcern", { ...owner, requestId: id(), reportedOn: today, role: "mother",
    category: "habits", concern: "合成甲：每周核对独立审题和验算", nextOn: shiftDate(today, 3) }));
  ok(await api("resolveStudentWrite", "confirm", concern.requestId));
  const other = ok(await api("createParentConcern", { studentId: b.id, requestId: id(), reportedOn: today, role: "father",
    category: "homework", concern: "合成乙：确认作业完成口径", nextOn: "" }));
  ok(await api("resolveStudentWrite", "confirm", other.requestId));
  const lesson = ok(await api("addLesson", { ...owner, id: id(), date: today, subject: "数学", task: "合成章节",
    completion: "已记录", assessment: "", nextStep: "合成甲：下次复核应用题草稿" }));
  ok(await api("saveGrowthProfile", { ...owner, requestId: id(), expectedRevision: 0, learningCharacteristics: "",
    communicationPreferences: "", currentSituation: "合成甲：已完成分数运算初测，保留学习记录供复盘。",
    strengths: "", weakAreas: "", goals: [{ id: id(), subject: "数学", targetScore: 90,
      deadline: shiftDate(today, 14), strategy: "合成任务", status: "active" }], observations: [] }));
  const score = async (offset, name, value, fields) => {
    const saved = ok(await api("saveStudentRecord", { ...owner, requestId: id(), id: id(), expectedRevision: 0,
      kind: "score", fields: { assessment: name, subject: "数学", takenOn: shiftDate(today, offset),
        category: "日常测验", score: value, maximum: "100", notes: "", ...fields } }));
    ok(await api("resolveStudentWrite", "confirm", saved.requestId));
    return saved;
  };
  await score(-2, "虚构单元测验甲", "86", { classRank: "4", classSize: "42" });
  await score(-1, "虚构单元测验乙", "88", { gradeSize: "180" });
  const latest = await score(0, "虚构阶段测验", "92", { classRank: "1", classSize: "42", gradeRank: "7", gradeSize: "180" });

  let visitDay = shiftDate(today, 1);
  while (weekday(visitDay) !== 6) visitDay = shiftDate(visitDay, 1);
  const startAt = shanghaiMinute(visitDay, "08:00");
  const scheduleRequest = id();
  const plan = ok(await api("saveSchedulePlan", { ...owner, requestId: scheduleRequest, id: id(), expectedRevision: 0,
    startAt, endAt: startAt + 120 * 60_000, kind: "regular" }));
  ok(await api("acknowledgeOperation", scheduleRequest, false));
  const common = { ...owner, attendanceId: plan.id, id: id() };
  const blockRequest = id();
  const block = ok(await api("applyLearningChange", { ...common, requestId: blockRequest, expectedRevision: 0,
    command: "saveLearningBlock", plannedStart: startAt, plannedEnd: startAt + 60 * 60_000, notes: "合成学习块" }));
  ok(await api("acknowledgeOperation", blockRequest, false));
  const taskId = id(), taskRequest = id();
  ok(await api("applyLearningChange", { ...common, requestId: taskRequest, expectedRevision: block.revision, command: "saveLearningTasks",
    tasks: [{ id: taskId, category: "home_school", subject: "数学", content: "合成甲：验算练习" }] }));
  ok(await api("acknowledgeOperation", taskRequest, false));

  await reopen();
  const selected = () => ui('document.querySelector(".student-detail-nav button[aria-pressed=true]")?.textContent');
  const summary = '.student-summary-grid';
  const hasOverviewText = value => ui('document.querySelector(' + JSON.stringify(summary) + ')?.innerText.includes(' + JSON.stringify(value) + ')');
  const equalTab = async label => assert.equal(await selected(), label);
  const clickSummary = text => click(text, ".student-summary-grid button");
  await click("学生档案", "nav button");
  assert.equal(await ui('document.querySelectorAll("aside.roster .student-list li").length'), 20);
  await choose(a.alias);
  await wait(() => hasOverviewText("合成甲：每周核对独立审题和验算"), "overview loaded");
  await equalTab("综合概览");
  for (const text of ["虚构阶段测验", "第 1 名", "第 7 名", "合成甲：验算练习", "合成甲：下次复核应用题草稿", "阶段目标与当前学情"]) {
    assert(await hasOverviewText(text), text);
  }
  await profileShot("student-overview.png");
  await clickSummary("合成甲：每周核对独立审题和验算");
  await equalTab("家长诉求");
  await wait(() => ui('document.activeElement.id===' + JSON.stringify("student-source-parent-" + concern.requestId)), "focus exact concern");
  await click("综合概览");
  await wait(() => hasOverviewText("虚构阶段测验"));
  await clickSummary("数学 · 虚构阶段测验");
  await equalTab("成绩趋势");
  await wait(() => ui('document.activeElement.id===' + JSON.stringify("student-source-score-" + latest.id)), "focus exact exam");
  const rank = async mode => {
    await ui('(()=>{const s=document.querySelectorAll(".score-trend select")[2];s.value=' + JSON.stringify(mode)
      + ';s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  };
  await rank("class");
  await wait(() => ui('document.querySelector(".score-trend canvas")?.dataset.pointCount==="2"'), "class rank omits missing exam");
  assert(await ui('document.querySelector(".score-trend").innerText.includes("第一名在顶部")'));
  await profileShot("class-rank-trend.png");
  await rank("grade");
  await wait(() => ui('document.querySelector(".score-trend canvas")?.dataset.pointCount==="1"'), "grade rank omits missing exams");

  await click("综合概览");
  await wait(() => hasOverviewText("合成甲：下次复核应用题草稿"));
  await clickSummary("合成甲：下次复核应用题草稿");
  await equalTab("学习历史");
  await wait(() => ui('document.activeElement.id===' + JSON.stringify("student-source-history-" + lesson.id)));
  await click("综合概览");
  await wait(() => hasOverviewText("合成甲：验算练习"));
  await clickSummary("数学 · 合成甲：验算练习");
  await wait(() => ui('document.activeElement.id===' + JSON.stringify("learning-task-" + taskId)), "focus exact learning task");
  await click("返回学生概览");
  await wait(() => hasOverviewText("合成甲：验算练习"));

  const set = async (selector, value) => ui('(()=>{const x=document.querySelector(' + JSON.stringify(selector)
    + ');const change=x.tagName==="SELECT";const proto=change?HTMLSelectElement.prototype:x.tagName==="INPUT"?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;'
    + 'Object.getOwnPropertyDescriptor(proto,"value").set.call(x,' + JSON.stringify(value)
    + ');x.dispatchEvent(new Event(change?"change":"input",{bubbles:true}));return true;})()');
  const changeStatus = async (value, reason, label) => {
    await set("#student-section-lifecycle select", value);
    await set("#student-section-lifecycle textarea", reason);
    await click("保存跟进状态", "#student-section-lifecycle button");
    await wait(() => ui('document.querySelector("#student-section-lifecycle").innerText.includes(' + JSON.stringify(label) + ')'
      + '&&document.querySelector("#student-section-lifecycle").innerText.includes("跟进状态已更新")'), "saved lifecycle");
  };
  await click("跟进状态", ".student-detail-nav button");
  await wait(() => ui('Boolean(document.querySelector("#student-section-lifecycle select"))'));
  await changeStatus("paused", "合成：临时暂停后确认恢复事宜", "正常跟进 → 暂停学习");
  assert.equal(await ui('document.querySelectorAll("aside.roster .student-list li").length'), 19);
  await set(".student-roster-filter select", "paused");
  assert.equal(await ui('document.querySelectorAll("aside.roster .student-list li").length'), 1);
  await changeStatus("archived", "合成：本阶段已结项", "暂停学习 → 已归档");
  await set(".student-roster-filter select", "archived");
  await profileShot("archived-student.png");
  const archived = ok(await api("studentOverview", a.id));
  assert.equal(archived.attendance[0].id, plan.id);
  assert.equal(archived.tasks[0].id, taskId);
  await changeStatus("active", "合成：确认重新开始跟进", "已归档 → 正常跟进");
  await set(".student-roster-filter select", "active");

  await click("家长诉求", ".student-detail-nav button");
  await click("登记诉求");
  await set("#student-section-parent form textarea", "合成未保存概览测试草稿");
  await click("综合概览");
  await click("家长诉求", ".student-detail-nav button");
  assert.equal(await ui('document.querySelector("#student-section-parent form textarea").value'), "合成未保存概览测试草稿");
  await ui('globalThis.confirmDraftDiscard=window.confirm;window.confirm=()=>true;true');
  await click("取消", "#student-section-parent form button");
  await ui('window.confirm=globalThis.confirmDraftDiscard;delete globalThis.confirmDraftDiscard;true');

  await main('(()=>{const ipc=' + E + '.ipcMain;const c="mvp:student-overview";const original=ipc._invokeHandlers.get(c);'
    + 'ipc.removeHandler(c);ipc.handle(c,async(event,id)=>{if(id===' + JSON.stringify(a.id)
    + ')await new Promise(resolve=>{globalThis.releaseOverview=resolve});return original(event,id)});return true;})()');
  await choose(b.alias);
  await wait(() => hasOverviewText("合成乙：确认作业完成口径"));
  await choose(a.alias);
  await wait(() => main('Boolean(globalThis.releaseOverview)'), "held overview query");
  await choose(b.alias);
  await wait(() => hasOverviewText("合成乙：确认作业完成口径"));
  await main('globalThis.releaseOverview();true');
  assert(!await hasOverviewText("合成甲：每周核对独立审题和验算"));
  await equalTab("综合概览");
  const empty = ok(await api("studentOverview", students[19].id));
  assert.equal(empty.recentScore, undefined);
  assert.equal(empty.attendance.length, 0);
  return { students: students.length, rankSeriesIndependent: true, sameStudentSourceLinks: true,
    lifecycleHistory: ok(await api("studentLifecycle", a.id)).history.length, activitiesPreserved: true,
    lateResponseIsolated: true, draftsPreservedOnTabNavigation: true, emptyOverview: true };
};
