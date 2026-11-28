const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {exportFixture}=require('./export-fixture.cjs');
const {emptyPlan}=require('../build/study-plan-model.js');
const {addManualStudyPlan,savePlanVersion,studentPlanViews,currentPlan}=require('../build/study-plan-versions.js');
const {businessExportDocument}=require('../build/business-export.js');
const id=()=>randomUUID();

function draft(title,subjects){return {...emptyPlan(),title,subjects,entries:[]};}
test('personal multiple-subject and historical plans require explicit non-overlapping activation',t=>{
 const f=exportFixture(t,2,12),db=f.m1.protectionConnection(),[student,other]=f.m1.students();
 const day='2030-01-01',now=Date.parse(day+'T10:00:00+08:00');
 const [math,english,otherMath]=[draft('合成数学',['数学']),draft('合成英语',['英语']),draft('另一份合成数学',['数学'])];
 const [a,b,c]=[math,english,otherMath].map(fields=>addManualStudyPlan(db,student.id,id(),fields));
 assert.equal(addManualStudyPlan(db,student.id,a,math),a);
 assert.equal(studentPlanViews(db,other.id).length,0);
 const activate=(plan,fields)=>({studentId:student.id,planId:plan,requestId:id(),expectedRevision:0,
  effectiveOn:day,startsOn:day,endsOn:'',reason:'合成明确启用',state:'active',fields});
 const first=activate(a,math);
 assert.equal(savePlanVersion(db,first,false,now).revision,1);
 assert.equal(savePlanVersion(db,first,false,now).revision,1);
 assert.equal(savePlanVersion(db,activate(b,english),false,now).state,'active');
 assert.throws(()=>savePlanVersion(db,activate(c,otherMath),false,now),/期间重叠/);
 assert.throws(()=>savePlanVersion(db,{...activate(c,otherMath),studentId:other.id},false,now),/不属于/);
 const retire={...first,requestId:id(),expectedRevision:1,state:'history',reason:'转为历史'};
 savePlanVersion(db,retire,false,now);
 assert.equal(savePlanVersion(db,activate(c,otherMath),false,now).state,'active');
 const views=studentPlanViews(db,student.id);
 assert.equal(views.length,3);
 assert.equal(currentPlan(views.find(plan=>plan.id===a).versions,day),undefined);
 assert.deepEqual(views.find(plan=>plan.id===a).initial,math);
 const exported=businessExportDocument(f.capture(),false);
 assert.equal(exported.tables.find(x=>x.table==='study_plan_versions').sourceRows,4);
});
