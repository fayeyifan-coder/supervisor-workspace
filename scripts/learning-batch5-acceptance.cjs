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
 const record=async(kind,id,fields,expectedRevision=0)=>{
  const requestId=randomUUID();
  ok(await api('saveStudentRecord',{studentId:student.id,kind,id,requestId,expectedRevision,fields}));
  ok(await api('resolveStudentWrite','confirm',requestId));
 };
 const planId=randomUUID(),trainingId=randomUUID();
 const planFields={title:'合成数学训练方案',subject:'数学',startsOn:day,targetOn:day,baseline:'合成起点',target:'合成目标',practice:'合成训练',status:'执行中'};
 await record('improvement',planId,planFields);
 await record('training',trainingId,{activity:'合成观察型训练',planId,planRevision:'1',trainedOn:day,sequence:'过程',score:'',maximum:'',result:'合成训练观察',nextStep:''});
 await record('improvement',planId,{...planFields,title:'合成修订方案',subject:'英语'},1);
 await click('学生档案','nav button');
 await choose(other);
 await choose(student);
 await click('单元与检测','.student-detail-nav button');
 await wait(()=>ui('document.querySelector("#student-section-learning-tracking")?.innerText.includes("待复测")'));
 await click('合成分式检测','.schedule-profile-link');
 await wait(()=>ui('Array.from(document.querySelectorAll("#student-section-learning-tracking option")).some(o=>o.textContent.includes("合成观察型训练")&&o.textContent.includes("提分方案第 1 版"))'));
 await profileShot('detection-fixed-training.png');
 await click('关闭修订','#student-section-learning-tracking button');
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
 const fixed={kind:'training',id:trainingId,revision:1};
 ok(await api('saveLearningTracking',{...detection,requestId:randomUUID(),expectedRevision:1,fields:{...detection.fields,result:fixed}}));
 await click('学生档案','nav button');
 await choose(other);
 await choose(student);
 await click('单元与检测','.student-detail-nav button');
 await wait(()=>ui('document.querySelector("#student-section-learning-tracking")?.innerText.includes("合成观察型训练 · 专项训练第 1 版 · 提分方案第 1 版")'));
 await profileShot('detection-fixed-training.png');
 await click('学习管理总览','nav button');
 const planEntry=(content)=>({id:randomUUID(),subject:'数学',month:'1月',week:'第1周',kind:'week',content,estimated:'',from:day,to:'',sources:[]});
 const entries=['合成详细流程结束','合成详细任务跳过'].map(planEntry);
 const {emptyPlan}=require('../build/study-plan-model.js');
 const fields={...emptyPlan(),title:'合成周执行口径',subjects:['数学'],entries};
 const studyPlanId=ok(await api('createManualPlan',{studentId:student.id,id:randomUUID(),fields}));
 ok(await api('savePlanVersion',{studentId:student.id,planId:studyPlanId,requestId:randomUUID(),expectedRevision:0,effectiveOn:day,startsOn:day,endsOn:'',state:'active',reason:'合成计划确认',fields}));
 await setClock('18:15');
 const apply=(id,expectedRevision,command,fields)=>save('applyLearningChange',{id,expectedRevision,command,studentId:student.id,attendanceId:slot2.id,...fields});
 let block=await apply(randomUUID(),0,'saveLearningBlock',{plannedStart:at('18:05'),plannedEnd:at('18:55')});
 const tasks=entries.map(row=>({id:randomUUID(),category:'foundation',subject:'数学',content:row.content}));
 block=await apply(block.id,block.revision,'saveLearningTasks',{tasks});
 for(const [index,task] of tasks.entries())ok(await api('linkPlanTask',{studentId:student.id,planId:studyPlanId,revision:1,entryId:entries[index].id,taskId:task.id}));
 block=await apply(block.id,block.revision,'recordLearningOutcome',{action:'start'});
 block=await apply(block.id,block.revision,'recordTaskOutcome',{taskId:tasks[0].id,status:'done',resultNotes:'合成详细流程观察'});
 await apply(block.id,block.revision,'recordTaskOutcome',{taskId:tasks[1].id,status:'skipped',resultNotes:'合成未执行观察'});
 const current=ok(await api('weeklyReview',student.id,range));
 assert.deepEqual(current.facts.plans.find(item=>item.entryId===entries[0].id).evidence,{executed:true,completed:false,unfinished:false,skipped:false});
 assert.deepEqual(current.facts.plans.find(item=>item.entryId===entries[1].id).evidence,{executed:false,completed:false,unfinished:true,skipped:true});
 assert(current.outdated);
 assert.deepEqual(current.history[0],review.history[0]);
 assert.deepEqual(current.facts.tracking.find(item=>item.id===testId).fields.result,fixed);
 await click('本周','.weekly-management button');
 await wait(()=>ui('document.querySelector(".weekly-management .study-board-rows")?.innerText.includes("有执行记录 1 项 · 有明确完成记录 0 项")'));
 await ui('Array.from(document.querySelectorAll(".weekly-management .study-board-rows > li")).find(row=>row.querySelector("h2").textContent.includes('+JSON.stringify(student.alias)+')).querySelectorAll("summary").forEach(summary=>{if(summary.textContent.startsWith("未完成或跳过"))summary.click();});true');
 assert((await ui('document.querySelector(".weekly-management .study-board-rows").innerText')).includes('合成详细任务跳过'));
 await profileShot('weekly-execution-closeout.png');
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
 for(const [name,count] of [['learning_record_details',21],['learning_unit_events',3],['learning_week_reviews',1]]){
  const table=doc.tables.find(row=>row.table===name);
  assert.equal(table.exportedRows,count);assert.equal(book.getWorksheet(table.sheet).rowCount,count+1);
 }
 return {version:'0.5.0',schema:16,studentCount:20,actualVisits:2,retainedDraft:true,detailSwitchIsolated:true,confirmedRevision:1,
   visitsWithoutCheckout:1,tableCount:36,backup:protect.location,export:exported.location,
   fixedTrainingPlanRevision:1,explicitCompletionSeparate:true,skippedInQueue:true,historicalReviewUnchanged:true,
   screenshots:['daily-quick.png','unit-detection.png','weekly-review.png','weekly-management.png','detection-fixed-training.png','weekly-execution-closeout.png']};
};
