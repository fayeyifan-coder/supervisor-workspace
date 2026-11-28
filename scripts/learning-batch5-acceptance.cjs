const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {readFile}=require('node:fs/promises');
const {join}=require('node:path');
const {Workbook}=require('exceljs');
const {shanghaiMinute}=require('../build/schedule-calendar.js');
const {validateProtection}=require('../build/offline-protection.js');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const setter=(ui,selector,value)=>ui('(()=>{const x=document.querySelector('+JSON.stringify(selector)+');const proto=x.tagName==="SELECT"?HTMLSelectElement.prototype:x.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(x,'+JSON.stringify(value)+');x.dispatchEvent(new Event(x.tagName==="SELECT"?"change":"input",{bubbles:true}));if(x.tagName==="INPUT")x.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');

module.exports=async function acceptLearning({main,ui,api,ok,wait,click,profileShot,E,output,reopen}){
 assert.equal(await main(E+'.app.getVersion()'),'0.5.0');
 assert.equal(ok(await api('studentRecordVersion')),16);
 const students=[];
 for(let n=1;n<=20;n++)students.push(ok(await api('createStudent',{id:randomUUID(),alias:'合成督学学生'+String(n).padStart(2,'0'),grade:'七年级',subjects:'数学、英语',goal:'',notes:''})));
 await reopen();
 const [student,other]=students,day='2030-01-02', range={from:'2029-12-31',to:'2030-01-06'};
 const at=time=>shanghaiMinute(day,time);
 async function setClock(time){
  await main('Date.now=()=>'+at(time)+';true');await ui('Date.now=()=>'+at(time)+';true');
 }
 await setClock('15:00');
 async function save(command,params){
  const requestId=randomUUID();
  const result=ok(await api(command,{...params,requestId}));
  ok(await api('acknowledgeOperation',requestId,false));
  return result;
 }
 async function slot(start,end){
  return save('saveSchedulePlan',{studentId:student.id,id:randomUUID(),expectedRevision:0,startAt:at(start),endAt:at(end),kind:'regular'});
 }
 async function check(visit,action,clock){
  await setClock(clock);
  return save('applyLearningChange',{command:'recordAttendance',studentId:student.id,id:visit.id,expectedRevision:visit.revision,attendanceId:visit.id,action});
 }
 const slot1=await slot('16:00','17:00'),slot2=await slot('18:00','19:00');
 const first=await check(slot1,'checkIn','16:03');
 await check(first,'checkOut','16:56');
 await check(slot2,'checkIn','18:03');
 await click('今日到校看板','nav button');
 await click('刷新今日到校','.attendance-board button');
 await wait(()=>ui('document.querySelectorAll(".attendance-board-row .schedule-learning-entry").length===2'),'two same-day actual visits');
 await click('快速登记','.attendance-board button');
 await wait(()=>ui('Boolean(document.querySelector(".quick-learning textarea")&&!document.querySelector(".quick-learning fieldset").disabled)'),'fast editor loaded');
 await setter(ui,'.quick-learning input[maxlength="40"]','数学');
 await setter(ui,'.quick-learning textarea','合成分式作业');
 await setter(ui,'.quick-learning fieldset:first-of-type label:nth-last-child(2) select','partial');
 await profileShot('daily-quick.png');
 await ui('window.confirm=()=>true;true');
 await click('关闭登记','.quick-learning button');
 await reopen();
 await setClock('18:03');
 await click('今日到校看板','nav button');
 await click('刷新今日到校','.attendance-board button');
 await wait(()=>ui('document.querySelectorAll(".attendance-board-row .schedule-learning-entry").length===2'));
 await click('快速登记','.attendance-board button');
 await wait(()=>ui('document.querySelector(".quick-learning textarea")?.value==="合成分式作业"'),'retained local draft after reopening');
 await click('保存快速登记','.quick-learning button');
 await wait(()=>ui('!document.querySelector(".quick-learning")'),'saved quick UI');
 const row=ok(await api('history',student.id)).find(item=>item.task==='合成分式作业');
 assert.equal(row.completion,'部分完成');
 for(const [i,person] of students.entries()){
  const quick={id:randomUUID(),studentId:person.id,date:day,subject:i%2?'英语':'数学',content:'合成家庭学习 '+i,
   completion:i%2?'incomplete':'complete',mastery:'unassessed',tags:[],problem:'',intervention:'',next:'',source:'other',
   attendanceId:null,taskId:null,priorTaskId:null,planning:null};
  assert.deepEqual(ok(await api('addQuickLesson',quick)),ok(await api('addQuickLesson',quick)));
 }
 const unit={id:randomUUID(),studentId:student.id,requestId:randomUUID(),date:day,expectedRevision:0,
  fields:{kind:'unit',subject:'数学',title:'合成分式单元',state:'learned',basis:'合成已结束课程',planning:null}};
 ok(await api('saveLearningTracking',unit));
 const testId=randomUUID(), scoreId=randomUUID(),scoreRequest=randomUUID();
 ok(await api('saveStudentRecord',{studentId:student.id,id:scoreId,requestId:scoreRequest,expectedRevision:0,kind:'score',
  fields:{assessment:'合成检测',subject:'数学',takenOn:day,category:'日常测验',score:'82',maximum:'100',notes:''}}));
 ok(await api('resolveStudentWrite','confirm',scoreRequest));
 const detection={...unit,id:testId,requestId:randomUUID(),fields:{kind:'check',unitId:unit.id,scope:'合成分式检测',due:day,state:'retest',
  result:{kind:'score',id:scoreId,revision:1},next:'合成巩固后复测',reminderId:null}};
 ok(await api('saveLearningTracking',detection));
 await click('学生档案','nav button');
 const choose=person=>ui('Array.from(document.querySelectorAll("aside .student-list button")).find(b=>b.textContent.includes('+JSON.stringify(person.alias)+')).click();true');
 await choose(student);
 await click('单元与检测','.student-detail-nav button');
 await wait(()=>ui('document.querySelector("#student-section-learning-tracking")?.innerText.includes("待复测")'));
 await profileShot('unit-detection.png');
 await choose(other);
 await click('单元与检测','.student-detail-nav button');
 await wait(()=>ui('document.querySelector("#student-section-learning-tracking")?.innerText.includes("尚未建立学科单元")'));
 assert(!await ui('document.querySelector("#student-section-learning-tracking").innerText.includes("合成分式单元")'));
 await click('学习管理总览','nav button');
 await click('本周','.weekly-management button');
 await wait(()=>ui('document.querySelectorAll(".weekly-management .study-board-rows > li").length===20'),'20 students in actual management view');
 const command={range,subject:'',lifecycle:'active',status:'all'};
 const overview=ok(await api('weeklyLearningManagement',command));
 assert.equal(overview.rows.length,20);assert.equal(overview.attendanceStudents,1);assert.equal(overview.visits,2);
 assert.equal(overview.rows.find(x=>x.studentId===student.id).missing.length,1);
 assert.equal(overview.rows.find(x=>x.studentId===student.id).checks.length,1);
 await profileShot('weekly-management.png');
 await ui('Array.from(document.querySelectorAll(".weekly-management .study-board-rows > li")).find(row=>row.querySelector("h2").textContent.includes('+JSON.stringify(student.alias)+')).querySelector(".schedule-buttons button").click();true');
 await wait(()=>ui('document.querySelector(".weekly-management-editor")?.innerText.includes("合成分式作业")'));
 await click('开始本周复盘','.weekly-management-editor button');
 await setter(ui,'.weekly-management-editor textarea','合成人工周评价');
 await click('确认并保存快照','.weekly-management-editor button');
 await wait(()=>ui('document.querySelector(".weekly-management-editor")?.innerText.includes("最新第 1 版")'));
 await profileShot('weekly-review.png');
 const review=ok(await api('weeklyReview',student.id,range));
 assert.equal(review.history[0].state,'confirmed');assert.equal(review.history[0].notes.evaluation,'合成人工周评价');
 assert.equal(review.facts.onSiteMinutes,53);assert.equal(review.facts.visitsWithoutCheckout,1);
 assert.equal(review.facts.facts.find(x=>x.content==='合成分式作业').completion,'partial');
 assert(!Object.hasOwn(review.facts,'healthScore'));
 const selector='(()=>{'+E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(output)+']});return true;})()';
 await main(selector);
 const protect=ok(await api('exportProtection')),backup=validateProtection(await readFile(protect.location));
 assert.equal(backup.summary.m1Version,16);
 const preview=ok(await api('prepareBusinessExport',{includeSourceText:false}));
 assert.equal(preview.tables.length,36);
 const exported=ok(await api('writeBusinessExport',preview.token));
 for(const file of exported.files)assert.equal(sha(await readFile(join(exported.location,file.name))),file.sha256);
 const doc=JSON.parse(await readFile(join(exported.location,'business-data.json'),'utf8')), book=new Workbook();
 await book.xlsx.readFile(join(exported.location,'business-data.xlsx'));
 for(const [name,count] of [['learning_record_details',21],['learning_unit_events',2],['learning_week_reviews',1]]){
  const table=doc.tables.find(row=>row.table===name);
  assert.equal(table.exportedRows,count);assert.equal(book.getWorksheet(table.sheet).rowCount,count+1);
 }
 return {version:'0.5.0',schema:16,studentCount:20,actualVisits:2,retainedDraft:true,detailSwitchIsolated:true,confirmedRevision:1,
   visitsWithoutCheckout:1,tableCount:36,backup:protect.location,export:exported.location,
   screenshots:['daily-quick.png','unit-detection.png','weekly-review.png','weekly-management.png']};
};
