const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {exportFixture}=require('./export-fixture.cjs');
const {readWeeklyManagement}=require('../build/learning-week-overview.js');
const {readReview}=require('../build/learning-week-review.js');
test('weekly management filters 20 students and takes no actions merely by reading queues',t=>{
 const f=exportFixture(t,20,16);
 const stores={m1:f.m1.protectionConnection(),ops:f.operations.protectionConnection(),work:f.work.protectionConnection()};
 const query={range:{from:'2026-11-30',to:'2026-12-06'},subject:'',lifecycle:'active',status:'all'};
 let view=readWeeklyManagement(stores,f.m1.students(),query);
 assert.equal(view.rows.length,20);
 assert.equal(view.attendanceStudents,1);
 assert.equal(view.visits,1);
 const row=view.rows.find(row=>row.studentId===f.studentId);
 assert.equal(row.visits,1);assert.equal(row.recordedVisits,1);assert.equal(row.review.state,'missing');
 assert.equal(readWeeklyManagement(stores,f.m1.students(),{...query,status:'missing'}).rows.length,0);
 const paused=f.m1.students().find(row=>row.id!==f.studentId);
 f.m1.saveStudentLifecycle({studentId:paused.id,requestId:randomUUID(),expectedRevision:0,status:'paused',reason:'合成暂停'});
 assert.equal(readWeeklyManagement(stores,f.m1.students(),query).rows.length,19);
 assert.equal(readWeeklyManagement(stores,f.m1.students(),{...query,lifecycle:'paused'}).rows[0].studentId,paused.id);
 const daily={id:randomUUID(),studentId:f.studentId,date:'2026-11-27',subject:'英语',content:'合成英语记录',completion:'partial',
  mastery:'unassessed',tags:[],problem:'',intervention:'',next:'合成跟进',source:'other',attendanceId:null,taskId:null,priorTaskId:null,planning:null};
 f.m1.addQuickLesson(stores.ops,daily);
 const earlier={range:{from:'2026-11-23',to:'2026-11-29'},subject:'英语',lifecycle:'active',status:'unfinished'};
 const targeted=readWeeklyManagement(stores,f.m1.students(),earlier).rows;
 assert.equal(targeted.length,1);assert.equal(targeted[0].unfinished[0].id,daily.id);
 const facts=readReview(stores,f.studentId,earlier.range);
 f.m1.saveWeeklyReview(stores.ops,stores.work,{studentId:f.studentId,range:earlier.range,requestId:randomUUID(),
  expectedRevision:0,sourceDigest:facts.sourceDigest,state:'confirmed',notes:{evaluation:'',issues:'',next:'',parent:''}});
 assert.equal(readWeeklyManagement(stores,f.m1.students(),{...earlier,status:'all'}).rows[0].review.state,'confirmed');
 f.m1.addQuickLesson(stores.ops,{...daily,id:randomUUID(),completion:'incomplete',content:'合成新证据'});
 assert.equal(readWeeklyManagement(stores,f.m1.students(),{...earlier,status:'review'}).rows[0].review.outdated,true);
 assert.equal(stores.m1.prepare('SELECT count(*) AS n FROM learning_week_reviews').get().n,1);
});
