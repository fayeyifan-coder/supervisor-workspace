const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {exportFixture}=require('./export-fixture.cjs');
const {getDailyContext,verifyDailyRecords}=require('../build/learning-daily.js');
const {prepareProtectionRestore,validateProtection}=require('../build/offline-protection.js');
const {businessExportDocument}=require('../build/business-export.js');
const form=(studentId,fields={})=>({id:randomUUID(),studentId,date:'2026-11-23',subject:'数学',content:'合成学习内容',completion:'partial',mastery:'unassessed',tags:['草稿清晰'],problem:'合成问题',intervention:'合成干预',next:'合成下次',source:'other',attendanceId:null,taskId:null,priorTaskId:null,planning:null,...fields});

test('daily retrospective entries retain one canonical lesson, stable retries and distinct date fields for 20 students',t=>{
 const f=exportFixture(t,20,14), ops=f.operations.protectionConnection();
 const students=f.m1.students(), before=f.m1.history(students[0].id).length;
 for(const [i,student] of students.entries()){
  const input=form(student.id,{content:'合成学习内容 '+i});
  const saved=f.m1.addQuickLesson(ops,input);
  assert.deepEqual(f.m1.addQuickLesson(ops,input),saved);
  assert.equal(saved.date,input.date);
  assert.equal(saved.completion,'部分完成');
  assert(saved.createdAt>Date.parse(input.date));
  assert.throws(()=>f.m1.addQuickLesson(ops,{...input,content:'合成冲突'}),/已用于其他/);
 }
 assert.equal(f.m1.history(students[0].id).length,before+1);
 f.m1.addQuickLesson(ops,form(students[0].id,{subject:'英语'}));
 const checked=businessExportDocument(f.capture(),false);
 assert.equal(checked.tables.length,34);
 assert.equal(checked.tables.find(row=>row.table==='learning_record_details').rows.length,21);
 verifyDailyRecords(f.m1.protectionConnection(),ops);
});
test('quick registration anchors a detailed fact once and validates each same-day attendance scope',t=>{
 const f=exportFixture(t,2,14), ops=f.operations.protectionConnection();
 t.mock.method(Date,'now',()=>Date.parse('2026-12-06T09:00:00+08:00'));
 const ctx=getDailyContext(f.m1.protectionConnection(),ops,f.studentId,'2026-12-05');
 const visit=ctx.visits[0],task=ctx.tasks[0];
 assert(visit&&task);
 const record=form(f.studentId,{date:'2026-12-05',content:task.content,source:'attendance',attendanceId:visit.id});
 assert.throws(()=>f.m1.addQuickLesson(ops,record),/已有详细任务/);
 assert.throws(()=>f.m1.addQuickLesson(ops,{...record,taskId:task.id,subject:'英语'}),/不一致/);
 const saved=f.m1.addQuickLesson(ops,{...record,taskId:task.id});
 assert.equal(saved.id,record.id);
 assert.throws(()=>f.m1.addQuickLesson(ops,{...record,id:randomUUID(),taskId:task.id}),/已有快速登记/);
 const other=f.m1.students().find(s=>s.id!==f.studentId);
 assert.throws(()=>f.m1.addQuickLesson(ops,{...record,id:randomUUID(),studentId:other.id,taskId:task.id}),/到课记录不属于/);
});
test('v13 archive migrates apart with empty supplements and remains readable in its old identity',t=>{
 const f=exportFixture(t,2,13), old=f.capture();
 const v14=prepareProtectionRestore(old,2,14);
 const before=validateProtection(old),after=validateProtection(v14);
 assert.deepEqual(before.images.slice(1),after.images.slice(1));
 assert.equal(after.manifest.m1SourceVersion,13);
 assert.throws(()=>prepareProtectionRestore(v14,2,13),/不能降级/);
 assert.equal(businessExportDocument(v14,false).tables.find(row=>row.table==='learning_record_details').sourceRows,0);
});
