const test=require('node:test');
const assert=require('node:assert/strict');
const { join }=require('node:path');
const { randomUUID }=require('node:crypto');
const { studyPlanDocx }=require('./study-plan-docx-fixture.cjs');
const { parseStudyPlan }=require('../build/study-plan-docx.js');
const { addStudyPlan, listStudyPlans, studyPlanSource, digestDocument }=require('../build/study-plans.js');
const { exportFixture }=require('./export-fixture.cjs');
const { ProtectionFiles, validateProtection, prepareProtectionRestore }=require('../build/offline-protection.js');
const { businessExportDocument }=require('../build/business-export.js');

test('local Word extraction keeps merged coordinates, ambiguous dates, identity conflict and five weeks',async()=>{
 const parsed=parseStudyPlan(await studyPlanDocx(1,true));
 assert.equal(parsed.fields.learner,'');
 assert(parsed.warnings.some(warning=>warning.includes('姓名不一致')));
 assert(parsed.cells.some(cell=>cell.merge==='continue'));
 assert(parsed.cells.some(cell=>cell.span===6));
 assert(parsed.cells.some(cell=>cell.text.includes('合成未知备注')));
 assert.equal(parsed.fields.entries.filter(item=>item.month==='12月'&&item.kind==='week').length,5);
 assert.equal(parsed.fields.entries.find(item=>item.week==='第2周').estimated,'2 小时');
 assert(parsed.fields.entries.every(item=>item.from===''));
 assert.deepEqual(parsed.fields.subjects,['数学','英语']);
 assert.throws(()=>parseStudyPlan(Buffer.from('bad')),/大小|DOCX/);
});
test('20 originals through partial failure and duplicate retry preserve independent bindings and SWBACK2 identity',async t=>{
 const fixture=exportFixture(t,2,11), db=fixture.m1.protectionConnection(), [a,b]=fixture.m1.students();
 const empty=businessExportDocument(fixture.capture(),false);
 assert.equal(empty.tables.length,31);
 assert.equal(empty.tables.find(table=>table.table==='study_plans').sourceRows,0);
 const attempts=[];
 for(let i=0;i<20;i++){
  const bytes=await studyPlanDocx(i+1), parsed=parseStudyPlan(bytes);
  const file={filename:'合成规划-'+i+'.docx',bytes,sha256:digestDocument(bytes),cells:parsed.cells};
  if(i===1)assert.throws(()=>addStudyPlan(db,randomUUID(),parsed.fields,file),/现有学生/);
  const saved=addStudyPlan(db,a.id,parsed.fields,file);
  attempts.push(saved.id);
  assert.deepEqual(addStudyPlan(db,a.id,parsed.fields,file),{id:saved.id,duplicate:true});
  if(i===0)assert.throws(()=>addStudyPlan(db,b.id,parsed.fields,file),/另一份/);
  const result=studyPlanSource(db,a.id,saved.id);
  assert(result.bytes.equals(bytes));
  assert.equal(result.metadata.sha256,file.sha256);
  assert.throws(()=>studyPlanSource(db,b.id,saved.id),/找不到/);
 }
 assert.equal(listStudyPlans(db,a.id).length,20);
 assert.equal(listStudyPlans(db,b.id).length,0);
 const backup=fixture.capture();
 assert.equal(validateProtection(backup).summary.m1Version,11);
 const publisher=new ProtectionFiles(join(__dirname,'../build/recovery-io.exe'));
 const restored=await publisher.restore(fixture.dir,backup);
 const verified=await publisher.inspect(fixture.dir,restored.profileName,2,11);
 assert(verified.bytes.equals(backup));
 const exportDoc=businessExportDocument(verified.bytes,false);
 const metadata=exportDoc.tables.find(table=>table.table==='study_plan_sources');
 assert.equal(metadata.exportedRows,20);
 assert(metadata.excludedColumns.includes('document_bytes'));
 assert(metadata.rows.every(row=>typeof row.sha256==='string'&&!('document_bytes' in row)));
});
test('v10 independently migrates to v11 without moving existing tables or changing backup format',t=>{
 const source=exportFixture(t,1,10).capture();
 const result=prepareProtectionRestore(source,2,11);
 assert.deepEqual(validateProtection(result).images.slice(1),validateProtection(source).images.slice(1));
 assert.equal(validateProtection(result).summary.formatVersion,2);
 assert.throws(()=>prepareProtectionRestore(result,2,10),/不能降级/);
});
