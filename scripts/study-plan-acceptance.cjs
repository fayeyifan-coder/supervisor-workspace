const assert=require('node:assert/strict');
const { createHash, randomUUID }=require('node:crypto');
const { DatabaseSync }=require('node:sqlite');
const { Workbook }=require('exceljs');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const { join }=require('node:path');
const { writeFile,readFile }=require('node:fs/promises');
const { studyPlanDocx }=require('../test/study-plan-docx-fixture.cjs');
const { shanghaiMinute }=require('../build/schedule-calendar.js');
const { validateProtection }=require('../build/offline-protection.js');
const input=(ui,selector,value)=>ui('(()=>{const x=document.querySelector('+JSON.stringify(selector)+');const s=x.tagName==="SELECT";Object.getOwnPropertyDescriptor(s?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(x,'+JSON.stringify(value)+');x.dispatchEvent(new Event(s?"change":"input",{bubbles:true}));if(!s)x.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');

module.exports=async function verifyStudyPlanning({main,ui,api,ok,wait,click,profileShot,E,output,reopen}){
 const version=await main(E+'.app.getVersion()');
 assert.equal(version,'0.4.0');
 assert.equal(ok(await api('studentRecordVersion')),13);
 const students=[];
 for(let n=1;n<=20;n++)students.push(ok(await api('createStudent',{id:randomUUID(),alias:'合成规划学生'+String(n).padStart(2,'0'),
  grade:'七年级',subjects:'数学、英语',goal:'',notes:''})));
 const sources=[];
 for(let n=1;n<=20;n++){
  const path=join(output,'合成Word-'+String(n).padStart(2,'0')+'.docx');
  await writeFile(path,await studyPlanDocx(n,n===1),{flag:'wx'});sources.push(path);
 }
 let bad=join(output,'合成损坏.docx');await writeFile(bad,Buffer.from('synthetic invalid document'),{flag:'wx'});
 const filePicker=choices=>main('(()=>{'+E+'.dialog.showOpenDialog=async()=>('+JSON.stringify({canceled:!choices.length,filePaths:choices})+');return true})()');
 await reopen();
 await filePicker([]);
 assert.deepEqual(ok(await api('pickStudyPlans')),[]);
 await filePicker([...sources,bad]);
 assert.equal((await api('pickStudyPlans')).code,'invalid');
 await filePicker([bad,sources[0]]);
 const mixed=ok(await api('pickStudyPlans'));
 assert(mixed[0].issue&&mixed[1].review);
 await filePicker(sources);
 const reviews=ok(await api('pickStudyPlans'));
 assert.equal(reviews.length,20);assert(reviews.every(row=>row.review));
 assert(reviews[0].review.warnings.some(w=>w.includes('姓名不一致')));
 for(const [n,row] of reviews.entries()){
  const data={token:row.review.token,studentId:students[n].id,confirmed:true,fields:row.review.fields};
  assert.equal((await api('saveStudyPlan',{...data,confirmed:false})).code,'invalid');
  const saved=ok(await api('saveStudyPlan',data));
  assert.equal(saved.duplicate,false);
  assert.equal(ok(await api('saveStudyPlan',data)).id,saved.id);
 }
 await click('导入 Word 规划','nav button');
 await click('选择 Word 文件');
 await wait(()=>ui('document.querySelectorAll(".study-plan-file-list li").length===20'),'renderer 20 previews');
 assert.equal(await ui('window.profileSwitchReady(false)'),false);
 await profileShot('word-import.png');
 await ui('window.confirm=()=>true;true');
 await click('关闭导入');
 const [student,other]=students;
 const [plan]=ok(await api('studyPlans',student.id));
 assert.equal((await api('studyPlanSource',other.id,plan.id)).code,'invalid');
 const captured=ok(await api('studyPlanSource',student.id,plan.id));
 assert.equal(captured.metadata.sha256,reviews[0].review.sha256);
 const day='2030-01-01', t=shanghaiMinute(day,'08:30');
 await main('Date.now=()=>'+t+';true');await ui('Date.now=()=>'+t+';true');
 const newFields={...plan.initial,entries:plan.initial.entries.map((item,index)=>({...item,subject:item.subject||'数学',
  from:index===0?day:'',to:''}))};
 const change={planId:plan.id,studentId:student.id,requestId:randomUUID(),expectedRevision:0,effectiveOn:day,startsOn:day,endsOn:'',
  state:'active',reason:'合成首次执行',fields:newFields};
 const v1=ok(await api('savePlanVersion',change));
 assert.equal(v1.revision,1);
 const from=shanghaiMinute(day,'16:00');
 const requestId=randomUUID(), attendance=ok(await api('saveSchedulePlan',{id:randomUUID(),studentId:student.id,
  requestId,expectedRevision:0,startAt:from,endAt:from+120*60000,kind:'regular'}));
 ok(await api('acknowledgeOperation',requestId,false));
 const blockRequest=randomUUID(), block=ok(await api('applyLearningChange',{command:'saveLearningBlock',studentId:student.id,
  attendanceId:attendance.id,id:randomUUID(),requestId:blockRequest,expectedRevision:0,plannedStart:from,plannedEnd:from+60*60000}));
 ok(await api('acknowledgeOperation',blockRequest,false));
 const taskId=randomUUID(), taskRequest=randomUUID();
 ok(await api('applyLearningChange',{command:'saveLearningTasks',studentId:student.id,attendanceId:attendance.id,id:block.id,
  requestId:taskRequest,expectedRevision:block.revision,tasks:[{id:taskId,category:'foundation',subject:'数学',content:'合成保留实际任务'}]}));
 ok(await api('acknowledgeOperation',taskRequest,false));
 const link=ok(await api('linkPlanTask',{studentId:student.id,planId:plan.id,taskId,revision:1,entryId:newFields.entries[0].id}));
 assert.equal(link.revision,1);
 ok(await api('savePlanVersion',{...change,requestId:randomUUID(),expectedRevision:1,effectiveOn:'2030-01-04',
  reason:'合成未来修订',fields:{...newFields,notes:'合成计划修订只影响未来'}}));
 const notes=ok(await api('studyPlans',student.id))[0];
 assert.equal(notes.initial.notes,plan.initial.notes);
 assert.equal(notes.versions.length,2);
 const board=ok(await api('studyPlanBoard',day));
 assert.equal(board.rows.length,20);
 assert.equal(board.rows.find(row=>row.studentId===student.id).week[0].actual[0].id,taskId);
 await click('学习规划总览','nav button');
 await input(ui,'.study-plan-board input[type=date]',day);
 await wait(()=>ui('document.querySelectorAll(".study-board-rows > li").length===20'),'read synthetic roster');
 await input(ui,'.study-plan-board label:nth-child(3) select',student.id);
 await wait(()=>ui('document.querySelector(".study-plan-board")?.innerText.includes("合成保留实际任务")'));
 await profileShot('planning-overview.png');
 await click(student.alias,'.study-board-rows h2 button');
 await wait(()=>ui('document.querySelector(".student-detail-nav [aria-pressed=true]")?.textContent==="学习规划"'),'global drill-through');
 await click('查看原文与来源');
 await wait(()=>ui('document.querySelector("#student-section-study-plan .study-plan-original")?.innerText.includes("合成未知备注")'));
 await profileShot('student-study-plan.png');
 await click('手工新建规划','#student-section-study-plan button');
 assert.equal(await ui('window.profileSwitchReady(false)'),false);
 const chooseOther=()=>ui('Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes('+JSON.stringify(other.alias)+')).click();true');
 await ui('window.confirm=()=>false;true');
 await chooseOther();
 assert(await ui('document.querySelector("#student-section-study-plan")?.innerText.includes("合成半年学习规划 1")'));
 assert(await ui('Boolean(document.querySelector("#student-section-study-plan form"))'));
 await ui('window.confirm=()=>true;true');
 await chooseOther();
 await click('学习规划','.student-detail-nav button');
 await wait(()=>ui('document.querySelector("#student-section-study-plan")?.innerText.includes("合成半年学习规划 2")'),'other student planning');
 assert.equal(await ui('Boolean(document.querySelector("#student-section-study-plan .study-plan-original"))'),false);
 await reopen();
 const reopened=ok(await api('studyPlans',student.id))[0];
 assert.equal(reopened.versions.length,2);
 assert.equal(ok(await api('planTasks',student.id)).find(row=>row.id===taskId).link.revision,1);
 await filePicker([output]);
 const backup=ok(await api('exportProtection'));
 const checked=validateProtection(await readFile(backup.location));
 assert.equal(checked.summary.m1Version,13);
 const image=new DatabaseSync(':memory:');
 try{
  image.deserialize(Buffer.from(checked.images[0]));
  const originals=image.prepare('SELECT sha256,document_bytes FROM study_plan_sources').all();
  assert.equal(originals.length,20);
  assert.deepEqual(originals.map(row=>row.sha256).sort(),reviews.map(row=>row.review.sha256).sort());
  for (const row of originals) assert.equal(digest(row.document_bytes),row.sha256);
 }finally{image.close();}
 const exportPreview=ok(await api('prepareBusinessExport',{includeSourceText:false}));
 assert.equal(exportPreview.tables.length,33);
 const metadata=exportPreview.tables.find(row=>row.table==='study_plan_sources');
 assert(metadata.excludedColumns.includes('document_bytes'));
 const published=ok(await api('writeBusinessExport',exportPreview.token));
 for(const file of published.files) assert.equal(digest(await readFile(join(published.location,file.name))),file.sha256);
 const json=JSON.parse(await readFile(join(published.location,'business-data.json'),'utf8'));
 const workbook=new Workbook();
 await workbook.xlsx.readFile(join(published.location,'business-data.xlsx'));
 assert.equal(json.m1Version,13);
 for(const [table,expected] of [['study_plan_sources',20],['study_plans',20],['study_plan_versions',2],['study_plan_links',1]]){
  const mapping=json.tables.find(row=>row.table===table);
  assert.equal(mapping.rows.length,expected);
  assert.equal(workbook.getWorksheet(mapping.sheet).rowCount,expected+1);
 }
 const originalRows=json.tables.find(row=>row.table==='study_plan_sources').rows;
 assert.deepEqual(originalRows.map(row=>row.sha256).sort(),reviews.map(row=>row.review.sha256).sort());
 assert(originalRows.every(row=>!('document_bytes' in row)&&!('cells_json' in row)));
 return {version,schema:13,students:20,files:20,pickerCancel:true,limitEnforced:true,partialFailure:true,duplicateRetry:true,
   studentSwitchDraftGuard:true,historicalTaskVersion:1,activePlans:1,backup:backup.location,backupWordDigests:20,tableCount:33,
   businessExport:published.location,businessExportFiles:published.files,screenshots:['word-import.png','planning-overview.png','student-study-plan.png']};
};
