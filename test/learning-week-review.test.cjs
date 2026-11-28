const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {join}=require('node:path');
const {exportFixture}=require('./export-fixture.cjs');
const {periodOf,reviewRange,readReview}=require('../build/learning-week-review.js');
const {prepareProtectionRestore,validateProtection,ProtectionFiles}=require('../build/offline-protection.js');
const {businessExportDocument,businessExportPayload}=require('../build/business-export.js');
const draft=(studentId,change={})=>({id:randomUUID(),studentId,date:'2026-11-26',subject:'数学',content:'合成补录',completion:'partial',mastery:'unassessed',tags:['审题需提醒','作业待补'],problem:'合成问题',intervention:'合成干预',next:'合成后续',source:'other',attendanceId:null,taskId:null,priorTaskId:null,planning:null,...change});
const con=f=>({m1:f.m1.protectionConnection(),ops:f.operations.protectionConnection(),work:f.work.protectionConnection()});

test('weekly review dates use Shanghai natural or working week and fresh facts never overwrite saved versions',t=>{
 const f=exportFixture(t,2,16),s=con(f),studentId=f.studentId;
 assert.deepEqual(periodOf('2030-01-01',false),{from:'2029-12-31',to:'2030-01-06'});
 assert.deepEqual(periodOf('2030-01-01',true),{from:'2030-01-01',to:'2030-01-06'});
 assert.throws(()=>reviewRange({from:'2030-01-02',to:'2030-01-01'}),/日期/);
 const range={from:'2026-11-23',to:'2026-11-29'};
 let first=readReview(s,studentId,range);
 assert.equal(first.facts.visits.length,0);
 assert.equal(first.facts.onSiteMinutes,null);
 assert.equal(first.facts.scores.length,1);
 assert.equal(first.facts.scoreChanges.length,0);
 assert.equal(first.facts.contacts.length,2);
 assert(!Object.hasOwn(first.facts,'healthScore'));
 const save={studentId,range,requestId:randomUUID(),sourceDigest:first.sourceDigest,state:'confirmed',expectedRevision:0,
  notes:{evaluation:'合成人工判断',issues:'',next:'合成下周',parent:''}};
 const saved=f.m1.saveWeeklyReview(s.ops,s.work,save);
 assert.deepEqual(f.m1.saveWeeklyReview(s.ops,s.work,save),saved);
 f.m1.addQuickLesson(s.ops,draft(studentId));
 const next=readReview(s,studentId,range);
 assert(next.outdated);
 assert.deepEqual(JSON.parse(JSON.stringify(saved.facts)),next.history[0].facts);
 assert.equal(next.facts.facts.length,first.facts.facts.length+1);
 assert.throws(()=>f.m1.saveWeeklyReview(s.ops,s.work,{...save,expectedRevision:1,requestId:randomUUID()}),/事实来源或复盘版本已变化/);
 const refreshed=f.m1.saveWeeklyReview(s.ops,s.work,{...save,expectedRevision:1,requestId:randomUUID(),sourceDigest:next.sourceDigest});
 assert.equal(refreshed.revision,2);
 assert.equal(readReview(s,studentId,range).history.length,2);
 assert.equal(businessExportDocument(f.capture(),false).tables.find(row=>row.table==='learning_week_reviews').exportedRows,2);
});

test('linked quick and detailed records count once and actual institution time is independent',t=>{
 const f=exportFixture(t,1,16),s=con(f),date='2026-12-05',range={from:date,to:date};
 t.mock.method(Date,'now',()=>Date.parse('2026-12-06T09:00:00+08:00'));
 const before=readReview(s,f.studentId,range).facts;
 const source=before.facts.find(row=>row.source==='detail');
 assert.equal(before.visits.length,1);
 assert.equal(before.onSiteMinutes,29);
 assert(source);
 f.m1.addQuickLesson(s.ops,draft(f.studentId,{date,attendanceId:source.attendanceId,taskId:source.id,source:'attendance'}));
 const facts=readReview(s,f.studentId,range).facts;
 assert.equal(facts.facts.length,before.facts.length);
 assert.equal(facts.facts[0].source,'quick');
 assert.equal(facts.facts[0].completion,'partial');
 assert.equal(facts.onSiteMinutes,29);
});

test('complete v13 archive restores into independent v16 with three empty tables and matching business data',async t=>{
 const f=exportFixture(t,2,13), db=f.m1.protectionConnection();
 const {studyPlanDocx}=require('./study-plan-docx-fixture.cjs');
 const {parseStudyPlan}=require('../build/study-plan-docx.js');
 const {digestDocument,addStudyPlan}=require('../build/study-plans.js');
 const {savePlanVersion}=require('../build/study-plan-versions.js');
 const originalWord=await studyPlanDocx();
 const parsed=parseStudyPlan(originalWord);
 const plan=addStudyPlan(db,f.studentId,parsed.fields,{filename:'合成学习规划.docx',bytes:originalWord,cells:parsed.cells,sha256:digestDocument(originalWord)});
 const current={...parsed.fields,entries:parsed.fields.entries.map(entry=>({...entry,subject:entry.subject||'数学'}))};
 savePlanVersion(db,{studentId:f.studentId,planId:plan.id,requestId:randomUUID(),expectedRevision:0,effectiveOn:'2030-01-01',startsOn:'2030-01-01',endsOn:'',state:'active',reason:'合成执行确认',fields:current},true,Date.parse('2029-12-30'));
 const original=f.capture();
 const target=prepareProtectionRestore(original,2,16), after=validateProtection(target);
 const io=new ProtectionFiles(join(__dirname,'../build/recovery-io.exe'));
 const staged=await io.restore(f.dir,target);
 const verified=await io.inspect(f.dir,staged.profileName,2,16);
 assert(verified.bytes.equals(target));
 const {DatabaseSync}=require("node:sqlite");
 const copied=new DatabaseSync(":memory:");copied.deserialize(after.images[0]);
 const source=copied.prepare("SELECT document_bytes,sha256 FROM study_plan_sources").get();
 assert(Buffer.from(source.document_bytes).equals(originalWord));
 assert.equal(source.sha256,digestDocument(originalWord));
 copied.close();
 assert.deepEqual(after.images.slice(1),validateProtection(original).images.slice(1));
 const old=businessExportDocument(original,false), next=businessExportDocument(verified.bytes,false);
 assert.equal(next.tables.length,36);
 assert.deepEqual(old.tables,next.tables.filter(row=>old.tables.some(before=>before.table===row.table)));
 assert(next.tables.filter(row=>!old.tables.some(before=>before.table===row.table)).every(row=>row.sourceRows===0));
 assert.throws(()=>prepareProtectionRestore(target,2,13),/不能降级/);
 const payload=await businessExportPayload(next);
 assert(payload.files.some(file=>file.name==='business-data.xlsx'));
 assert.equal(JSON.parse(payload.files.find(file=>file.name==='business-data.json').bytes).m1Version,16);
});

test('weekly and management evidence separate execution, teaching completion, skipped and invalid sources',t=>{
 const {emptyPlan}=require('../build/study-plan-model.js');
 const {addManualStudyPlan,savePlanVersion}=require('../build/study-plan-versions.js');
 const {linkPlanTask}=require('../build/study-plan-links.js');
 const {readWeeklyManagement}=require('../build/learning-week-overview.js');
 const {fingerprint}=require('../build/learning-week-review.js');
 const f=exportFixture(t,1,16),s=con(f),id=f.studentId,date='2026-12-05';
 const range={from:date,to:date};
 let clock=Date.parse(date+'T08:15:00+08:00');t.mock.method(Date,'now',()=>++clock);
 const change=(key,revision)=>({id:key,studentId:id,requestId:randomUUID(),expectedRevision:revision});
 const make=(text)=>({id:randomUUID(),subject:'数学',month:'12月',week:'第1周',kind:'week',content:text,estimated:'',from:date,to:'',sources:[]});
 const entries=['合成流程结束','合成跳过','合成进行中','合成失效'].map(make);
 const fields={...emptyPlan(),title:'合成每周执行口径',subjects:['数学'],entries};
 const plan=addManualStudyPlan(s.m1,id,randomUUID(),fields);
 savePlanVersion(s.m1,{studentId:id,planId:plan,requestId:randomUUID(),expectedRevision:0,effectiveOn:date,startsOn:date,endsOn:'',state:'active',reason:'合成执行',fields},true,Date.now());
 function create(items){
  const block=f.operations.saveLearningBlock({...change(randomUUID(),0),plannedStart:Date.parse(date+'T08:00:00+08:00'),
   plannedEnd:Date.parse(date+'T09:00:00+08:00')});
  const tasks=items.map(entry=>({id:randomUUID(),category:'foundation',subject:'数学',content:entry.content}));
  const ready=f.operations.saveLearningTasks({...change(block.id,block.revision),tasks});
  items.forEach((entry,i)=>linkPlanTask(s.m1,s.ops,{studentId:id,planId:plan,revision:1,entryId:entry.id,taskId:tasks[i].id}));
  return {ready,tasks};
 }
 const start=block=>f.operations.recordLearningOutcome({...change(block.id,block.revision),action:'start'});
 const outcome=(block,task,status,notes)=>f.operations.recordTaskOutcome({...change(block.id,block.revision),taskId:task.id,status,resultNotes:notes});
 const stable=create(entries.slice(0,3)), stale=create(entries.slice(3));
 let live=start(stable.ready);
 live=outcome(live,stable.tasks[0],'done','合成详细任务过程观察');
 live=outcome(live,stable.tasks[1],'skipped','合成未执行观察');
 outcome(live,stable.tasks[2],'in_progress','合成开始时观察');
 const mutated=f.operations.saveLearningTasks({...change(stale.ready.id,stale.ready.revision),tasks:stale.tasks.map(row=>({...row,content:'合成改写后的任务'}))});
 outcome(start(mutated),stale.tasks[0],'done','合成失效任务观察');
 const before=readReview(s,id,range),fact=(view,task)=>view.facts.facts.find(row=>row.taskId===task.id);
 assert.deepEqual(fact(before,stable.tasks[0]).evidence,{executed:true,teaching:'unassessed',skipped:false});
 assert.deepEqual(fact(before,stable.tasks[1]).evidence,{executed:false,teaching:'unassessed',skipped:true});
 assert.deepEqual(fact(before,stable.tasks[2]).evidence,{executed:true,teaching:'unassessed',skipped:false});
 assert.equal(fact(before,stale.tasks[0]).planningNeedsReview,true);
 assert.equal(fact(before,stale.tasks[0]).planning,undefined);
 const evidence=(view,entry)=>view.facts.plans.find(row=>row.entryId===entry.id).evidence;
 assert.deepEqual(evidence(before,entries[0]),{executed:true,completed:false,unfinished:false,skipped:false});
 assert.deepEqual(evidence(before,entries[1]),{executed:false,completed:false,unfinished:true,skipped:true});
 assert.deepEqual(evidence(before,entries[3]),{executed:false,completed:false,unfinished:false,skipped:false});
 const legacy=JSON.parse(JSON.stringify(before.facts));
 for(const row of legacy.facts){delete row.evidence;delete row.detailOrigin;}
 for(const row of legacy.plans){delete row.evidence;if(row.execution==='executed')row.execution='unrecorded';}
 const original=JSON.stringify(legacy), legacyHash=fingerprint(legacy);
 s.m1.prepare('INSERT INTO learning_week_reviews VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,date,date,1,randomUUID(),Date.now(),'confirmed',legacyHash,original,
  JSON.stringify({evaluation:'已确认的合成旧评价',issues:'',next:'',parent:''}));
 const partial=draft(id,{date,taskId:stable.tasks[0].id,content:'合成补充登记',problem:'合成补充观察',completion:'partial'});
 f.m1.addQuickLesson(s.ops,partial);
 const after=readReview(s,id,range);
 assert.equal(after.facts.facts.length,before.facts.facts.length);
 assert.equal(fact(after,stable.tasks[0]).id,partial.id);
 assert.deepEqual(fact(after,stable.tasks[0]).evidence,{executed:true,teaching:'partial',skipped:false});
 assert.equal(fact(after,stable.tasks[0]).detailOrigin.observation,'合成详细任务过程观察');
 assert.equal(fact(after,stable.tasks[0]).problem,'合成补充观察');
 assert.equal(evidence(after,entries[0]).unfinished,true);
 const management=readWeeklyManagement(s,f.m1.students(),{range,subject:'',lifecycle:'active',status:'unfinished'}).rows[0];
 assert.equal(management.executed,2);
 assert.equal(management.completed,0);
 assert.deepEqual(new Set(management.unfinished.map(r=>r.id)),new Set([stable.tasks[0].id,stable.tasks[1].id]));
 assert(management.sources.some(r=>r.id===stale.tasks[0].id));
 assert(after.outdated);
 assert.equal(JSON.stringify(after.history[0].facts),original);
 assert.equal(s.m1.prepare('SELECT source_digest FROM learning_week_reviews').get().source_digest,legacyHash);
 assert.doesNotThrow(()=>validateProtection(f.capture()));
});
