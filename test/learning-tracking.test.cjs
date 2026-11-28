const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {exportFixture}=require('./export-fixture.cjs');
const {readTracking,verifyTracking}=require('../build/learning-tracking.js');
const {businessExportDocument}=require('../build/business-export.js');
test('learning completion, detection, retest and reminders keep immutable source identities', t=>{
 const f=exportFixture(t,2,15),db=f.m1.protectionConnection(),work=f.work.protectionConnection(),id=f.studentId;
 const save=(request)=>f.m1.saveLearningTracking(work,request);
 const unit={id:randomUUID(),studentId:id,expectedRevision:0,requestId:randomUUID(),date:'2026-11-26',
  fields:{kind:'unit',subject:'数学',title:'合成方程',state:'learned',basis:'合成课程完成',planning:null}};
 assert.equal(save(unit).fields.state,'learned');
 const task=f.work.save({id:randomUUID(),studentId:id,title:'合成待检测',workDate:'2026-11-28',startedAt:'',notes:'',nextStep:''},()=>true);
 const check={...unit,id:randomUUID(),requestId:randomUUID(),fields:{kind:'check',unitId:unit.id,scope:'合成方程检测',due:'2026-11-28',state:'pending',result:null,next:'',reminderId:task.id}};
 const created=save(check);assert.deepEqual(save(check),created);
 assert.throws(()=>save({...check,id:randomUUID(),requestId:randomUUID()}),/已关联另一项/);
 const result={kind:'score',id:f.scoreId,revision:1};
 const tested={...check,requestId:randomUUID(),expectedRevision:1,fields:{...check.fields,state:'tested',result}};
 assert.throws(()=>save({...tested,fields:{...tested.fields,result:null}}),/真实检测结果/);
 assert.equal(save(tested).fields.result.revision,1);
 assert.throws(()=>save({...tested,requestId:randomUUID()}),/版本已变化/);
 const retest=save({...tested,requestId:randomUUID(),expectedRevision:2,fields:{...tested.fields,state:'retest',next:'合成复测'}});
 assert.equal(retest.fields.state,'retest');
 assert.equal(readTracking(db,work,id).history.length,4);
 assert.equal(readTracking(db,work,id).results.find(row=>row.id===f.scoreId).revision,2);
 verifyTracking(db,work);
 const exported=businessExportDocument(f.capture(),false);
 assert.equal(exported.tables.find(row=>row.table==='learning_unit_events').rows.length,4);
 assert(!JSON.stringify(retest.fields).includes('90.25'));
});

test('detection resolves a score or observation-only training through its exact saved plan revision',async t=>{
 const {join}=require('node:path');
 const {ProtectionFiles,validateProtection}=require('../build/offline-protection.js');
 const {DatabaseSync}=require('node:sqlite');
 const {resolveDetectionSource}=require('../build/student-records.js');
 const f=exportFixture(t,2,16),db=f.m1.protectionConnection(),work=f.work.protectionConnection(),id=f.studentId;
 const other=f.m1.students().find(s=>s.id!==id).id;
 const record=(kind,studentId,fields,entityId=randomUUID(),expectedRevision=0)=>f.m1.saveStudentRecord({
  kind,studentId,id:entityId,expectedRevision,requestId:randomUUID(),fields
 });
 const fields={title:'合成数学训练计划',subject:'数学',startsOn:'2026-11-01',targetOn:'2026-12-01',
  baseline:'合成起点',target:'合成目标',practice:'合成训练',status:'执行中'};
 const plan=record('improvement',id,fields);
 const observed={activity:'合成无分值训练',planId:plan.id,planRevision:'1',trainedOn:'2026-11-26',sequence:'过程',score:'',maximum:'',result:'合成真实训练观察',nextStep:''};
 const trained=record('training',id,observed);
 record('improvement',id,{...fields,subject:'英语',title:'合成修订后的学科'},plan.id,1);
 const unit={id:randomUUID(),studentId:id,expectedRevision:0,requestId:randomUUID(),date:'2026-11-26',
  fields:{kind:'unit',subject:'数学',title:'合成检测单元',state:'learned',basis:'合成课堂记录',planning:null}};
 f.m1.saveLearningTracking(work,unit);
 const check={...unit,id:randomUUID(),requestId:randomUUID(),fields:{kind:'check',unitId:unit.id,
  scope:'合成观察检测',due:'',state:'tested',result:{kind:'training',id:trained.id,revision:1},next:'',reminderId:null}};
 const previous=(kind,sourceId,revision)=>resolveDetectionSource(db,id,{kind,id:sourceId,revision});
 assert.equal(previous('score',f.scoreId,1).subject,'数学');
 assert.equal(previous('training',trained.id,1).subject,'数学');
 assert.equal(previous('training',trained.id,1).plan.revision,1);
 assert.equal(previous('training',trained.id,1).plan.title,fields.title);
 assert.throws(()=>f.m1.saveLearningTracking(work,{...check,fields:{...check.fields,result:{...check.fields.result,revision:97}}}),/同学科/);
 const wrongUnit={...unit,id:randomUUID(),requestId:randomUUID(),fields:{...unit.fields,subject:'英语'}};
 f.m1.saveLearningTracking(work,wrongUnit);
 assert.throws(()=>f.m1.saveLearningTracking(work,{...check,fields:{...check.fields,unitId:wrongUnit.id}}),/同学科/);
 const otherUnit={...unit,id:randomUUID(),studentId:other,requestId:randomUUID()};
 f.m1.saveLearningTracking(work,otherUnit);
 assert.throws(()=>f.m1.saveLearningTracking(work,{...check,studentId:other,fields:{...check.fields,unitId:otherUnit.id}}),/同学科/);
 assert.equal(f.m1.saveLearningTracking(work,check).fields.result.id,trained.id);
 record('training',id,{...observed,result:'合成修订训练观察'},trained.id,1);
 const view=readTracking(db,work,id);
 const legacy=view.results.find(r=>r.id===trained.id&&r.revision===1);
 assert.equal(legacy.plan.revision,1);
 assert(!Object.hasOwn(legacy,'score'));
 assert(view.results.some(r=>r.kind==='training'&&r.revision===2));
 verifyTracking(db,work);
 const bytes=f.capture(),io=new ProtectionFiles(join(__dirname,'../build/recovery-io.exe'));
 const restored=await io.restore(f.dir,bytes),copy=await io.inspect(f.dir,restored.profileName,2,16);
 const images=validateProtection(copy.bytes).images;
 const ro=images.slice(0,2).map(image=>{const store=new DatabaseSync(':memory:');store.deserialize(image);return store;});
 try{assert.deepEqual(readTracking(...ro,id).results.find(r=>r.id===trained.id&&r.revision===1),legacy);}
 finally{ro.forEach(store=>store.close());}
});
