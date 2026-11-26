const {randomUUID}=require('node:crypto');
const {mkdtempSync,readFileSync,realpathSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {WorkspaceDatabase}=require('../build/database.js');
const {WorkLogDatabase}=require('../build/worklog.js');
const {GrowthProfileDatabase}=require('../build/growth-profile.js');
const {IntakeStore,StudentIntakeService}=require('../build/student-intake.js');
const {OperationsDatabase}=require('../build/operations.js');
const {applyLearningChange}=require('../build/learning-api.js');
const {saveSchedulePlan}=require('../build/schedule-api.js');
const {captureProtection}=require('../build/offline-protection.js');

// Entirely constructed data. Never reads an installed application or private profile.
function exportFixture(t,count=1,version=6){
 const dir=mkdtempSync(join(realpathSync.native(tmpdir()),'sw-export-synthetic-'));
 const m1=WorkspaceDatabase.open(join(dir,'mvp.sqlite3'),join(dir,'mvp.initialized'),version);
 const work=WorkLogDatabase.open(join(dir,'worklog.sqlite3'),join(dir,'worklog.initialized'));
 const growth=GrowthProfileDatabase.open(join(dir,'growth.sqlite3'),join(dir,'growth.initialized'));
 const intake=IntakeStore.open(join(dir,'student-intake.sqlite3'),join(dir,'student-intake.initialized'));
 const operations=OperationsDatabase.open(dir,m1,true);const stores=[m1,work,growth,intake,operations];
 t.after(()=>{for(const store of [...stores].reverse())store.close();});
 const capture=()=>captureProtection(stores,'0.2.1',2,version);
 if(!count)return{dir,m1,work,growth,intake,operations,stores,capture};
 const service=new StudentIntakeService(intake,m1,growth);
 const file=service.register('synthetic',readFileSync(join(__dirname,'fixtures/synthetic-intake-001.json'),'utf8'));
 const prepared=service.prepare(file.token,{kind:'new'});
 const imported=service.confirm({token:file.token,target:prepared.target,expectedRevision:prepared.revision,student:file.source.student,fields:prepared.proposed,reviewed:true,pendingId:prepared.pendingId});
 if(imported.state!=='saved')throw Error('Synthetic intake not completed');
 for(let i=1;i<count;i++)m1.createStudent({id:randomUUID(),alias:'SYNTH-EXPORT-'+i,grade:'测试年级',subjects:'数学',goal:'合成学习目标',notes:''});
 const student=m1.students()[0],studentId=student.id;
 m1.addLesson({id:randomUUID(),studentId,date:'2026-11-26',subject:'数学',task:'合成章节',completion:'已完成',assessment:'合成观察',nextStep:'合成跟进'});
 const edit={studentId,requestId:randomUUID(),expectedRevision:0,fields:{alias:student.alias,grade:student.grade,subjects:student.subjects,goal:'合成调整目标',notes:'中文\n第二行'}};
 m1.saveStudentEdit(edit);m1.finishStudentEdit(edit);
 const concern=m1.createParentConcern({requestId:randomUUID(),studentId,reportedOn:'2026-11-26',role:'mother',category:'academic',concern:'合成家长诉求',nextOn:''});
 m1.appendParentFollowUp({requestId:randomUUID(),studentId,concernId:concern.requestId,expectedRevision:0,followedOn:'2026-11-26',status:'in_progress',note:'合成跟进',nextOn:''});
 const save=(kind,fields,id=randomUUID(),expectedRevision=0)=>m1.saveStudentRecord({kind,fields,id,studentId,expectedRevision,requestId:randomUUID()});
 save('enrollment',{course:'合成课程',registeredOn:'2026-01-01',startsOn:'2026-01-01',endsOn:'2026-12-31',status:'有效',notes:''});
 const scoreFields={assessment:'合成考试',subject:'数学',takenOn:'2026-11-26',category:'日常测验',score:'90.25',maximum:'150.50',notes:''};
 const score=save('score',scoreFields);save('score',{...scoreFields,score:'91.25'},score.id,1);
 const plan=save('improvement',{title:'合成方案',subject:'数学',startsOn:'2026-01-01',targetOn:'2026-12-31',baseline:'合成依据',target:'合成目标',practice:'合成训练',status:'执行中'});
 save('training',{activity:'合成训练',planId:plan.id,planRevision:'1',trainedOn:'2026-11-26',sequence:'过程',score:'40.50',maximum:'50',result:'合成观察',nextStep:''});
 const item=work.save({id:randomUUID(),studentId,title:'合成工作事项',workDate:'2026-11-26',startedAt:'',notes:'',nextStep:''},()=>true);work.setStatus(item.id,'done');
 const before=growth.load(studentId);
 growth.save({requestId:randomUUID(),studentId,expectedRevision:before.revision,learningCharacteristics:'合成特点',communicationPreferences:'合成沟通',currentSituation:'合成现状',strengths:'合成优势',weakAreas:'合成薄弱点',goals:[{id:randomUUID(),subject:'数学',targetScore:85,deadline:'2026-12-31',strategy:'合成措施',status:'active'}],observations:[{id:randomUUID(),observedOn:'2026-11-26',content:'合成观察'}]},()=>true);
 const original=Date.now;const at=time=>Date.parse('2026-12-05T'+time+':00+08:00');let clock=at('07:50');Date.now=()=>clock;
 try{
  const students=()=>m1.students();
  let attendance=saveSchedulePlan(operations,students,{id:randomUUID(),studentId,requestId:randomUUID(),expectedRevision:0,startAt:at('08:00'),endAt:at('10:00'),kind:'regular'});
  const change=(row,fields)=>applyLearningChange(operations,students,{id:row.id,studentId,attendanceId:attendance.id,expectedRevision:row.revision,requestId:randomUUID(),...fields});
  let block=change({id:randomUUID(),revision:0},{command:'saveLearningBlock',plannedStart:at('08:00'),plannedEnd:at('09:00'),notes:'合成学习块'});
  const taskId=randomUUID();block=change(block,{command:'saveLearningTasks',tasks:[{id:taskId,category:'home_school',subject:'数学',content:'合成任务'}]});
  clock=at('08:01');attendance=change(attendance,{command:'recordAttendance',action:'checkIn'});
  block=change(block,{command:'recordLearningOutcome',action:'start'});block=change(block,{command:'recordTaskOutcome',taskId,status:'in_progress'});
  clock=at('08:25');block=change(block,{command:'recordTaskOutcome',taskId,status:'done',resultNotes:'合成完成'});
  clock=at('08:30');block=change(block,{command:'recordLearningOutcome',action:'finish'});attendance=change(attendance,{command:'recordAttendance',action:'checkOut'});
 }finally{Date.now=original;}
 return{dir,m1,work,growth,intake,operations,stores,capture,studentId,scoreId:score.id};
}
module.exports={exportFixture};
