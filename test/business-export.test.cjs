const assert=require('node:assert/strict');
const {test}=require('node:test');
const {randomUUID,createHash}=require('node:crypto');
const {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {exportFixture}=require('./export-fixture.cjs');
const {businessExportDocument,businessExportPayload,BusinessExportPlans}=require('../build/business-export.js');
const {BusinessExportFiles,requireExportDestination}=require('../build/business-export-files.js');
const {readBackupStatus}=require('../build/backup-status.js');
const Excel=require('../build/exceljs.runtime.js');
const helper=join(__dirname,'../build/recovery-io.exe');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHashes=f=>f.stores.map(s=>sha(s.protectionConnection().serialize()));

test('empty five-store export enumerates all 24 tables and excludes only declared internal bodies',async t=>{
 const f=exportFixture(t,0);const before=sourceHashes(f);const d=businessExportDocument(f.capture(),false);
 assert.equal(d.tables.length,24);assert.equal(d.tables.filter(r=>r.role==='internal').length,3);
 assert(d.tables.every(r=>r.sourceRows===0&&r.exportedRows===0));
 const p=await businessExportPayload(d);const book=new Excel.Workbook();await book.xlsx.load(p.files[0].bytes);
 assert.equal(book.worksheets.length,24);assert.deepEqual(sourceHashes(f),before);
 assert.equal(book.getWorksheet('考试成绩').rowCount,1);
});

test('single and 20 synthetic students preserve every business row, identity, cross-store link and historical revision',t=>{
 for(const count of [1,20]){
  const f=exportFixture(t,count);const before=sourceHashes(f);const d=businessExportDocument(f.capture(),true);
  assert.equal(d.tables.find(r=>r.table==='students').exportedRows,count);
  for(const table of d.tables){
   const store=f.stores.find(s=>{try{return Boolean(s.protectionConnection().prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table.table));}catch{return false;}});
   const db=store.protectionConnection();assert.equal(table.sourceRows,Number(db.prepare('SELECT count(*) n FROM '+table.table).get().n));
   if(table.role==='internal'){assert.equal(table.rows.length,0);continue;}
   assert(table.rows.length>0,table.table+' must have a populated synthetic example');
   assert.deepEqual(table.rows,db.prepare('SELECT '+table.columns.join(',')+' FROM '+table.table+' ORDER BY '+table.columns.join(',')).all().map(r=>({...r})));
  }
  const scores=d.tables.find(r=>r.table==='student_scores');assert.equal(scores.rows.length,2);assert.equal(scores.entities,1);
  assert.equal(JSON.parse(scores.rows[0].payload).maximum,'150.50');assert.deepEqual(new Set(scores.rows.map(r=>r.revision)),new Set([1,2]));
  const task=d.tables.find(r=>r.table==='learning_tasks').rows[0];assert(d.tables.find(r=>r.table==='learning_blocks').rows.some(b=>b.id===task.block_id));
  assert.deepEqual(sourceHashes(f),before);assert(f.stores.every(s=>!s.protectionConnection().isTransaction));
 }
});

test('source raw-text opt-in and all three internal exclusions are explicit; old layouts fail without migration',t=>{
 const f=exportFixture(t);const bytes=f.capture();const without=businessExportDocument(bytes,false),withSource=businessExportDocument(bytes,true);
 const row=without.tables.find(r=>r.table==='intake_jobs');assert.deepEqual(row.excludedColumns,['source_json']);assert(!('source_json'in row.rows[0]));
 assert.equal(typeof withSource.tables.find(r=>r.table==='intake_jobs').rows[0].source_json,'string');
 const old=exportFixture(t,0,5);const before=sourceHashes(old);assert.throws(()=>businessExportDocument(old.capture(),true),e=>e.code==='invalid');assert.deepEqual(sourceHashes(old),before);
});

test('preview binds exact immutable snapshot, expires, cancels, rejects wrong owner and is single-use',t=>{
 const f=exportFixture(t);const plans=new BusinessExportPlans();t.after(()=>plans.clear());const now=Date.now();const p=plans.prepare('profile-A/window-1',f.capture(),false,now);
 f.m1.addLesson({id:randomUUID(),studentId:f.studentId,date:'2026-11-26',subject:'数学',task:'预览后新增',completion:'合成',assessment:'',nextStep:''});
 assert.equal(plans.peek(p.token,'profile-A/window-1').tables.find(r=>r.table==='learning_records').rows.length,1);
 assert.throws(()=>plans.peek(p.token,'profile-B/window-1'),e=>e.code==='conflict');
 plans.take(p.token,'profile-A/window-1');assert.throws(()=>plans.take(p.token,'profile-A/window-1'),e=>e.code==='conflict');
 const p2=plans.prepare('A',f.capture(),false,now);plans.cancel(p2.token,'A');assert.throws(()=>plans.peek(p2.token,'A'),e=>e.code==='conflict');
 const p3=plans.prepare('A',f.capture(),false,now);assert.throws(()=>plans.peek(p3.token,'A',now+15*60*1000),e=>e.code==='conflict');
});

test('external concurrent writer blocks snapshot instead of returning a mixed five-store export',t=>{
 const f=exportFixture(t);const external=new DatabaseSync(join(f.dir,'worklog.sqlite3'));t.after(()=>external.close());external.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>f.capture());}finally{external.exec('ROLLBACK');}
 const d=businessExportDocument(f.capture(),false);assert.equal(d.tables.length,24);assert(f.stores.every(s=>!s.protectionConnection().isTransaction));
});

test('XLSX is string-only for formula shapes and preserves Unicode, long text, control characters, line breaks and row overflow',async t=>{
 const f=exportFixture(t,20);const d=businessExportDocument(f.capture(),true);const students=d.tables.find(r=>r.table==='students');
 const values=['=1+1','+cmd|synthetic','-2+3','@SUM(1,2)','\t=1+1',('中文😀\n'.repeat(11000))+'\0末尾'];
 values.forEach((v,i)=>students.rows[i].notes=v);
 const p=await businessExportPayload(d,4);const raw=JSON.parse(p.files.find(r=>r.name==='business-data.json').bytes);
 assert.deepEqual(raw.tables.find(r=>r.table==='students').rows.slice(0,values.length).map(r=>r.notes),values);
 const book=new Excel.Workbook();await book.xlsx.load(p.files[0].bytes);assert(book.getWorksheet('学生档案-5'));
 assert.equal(p.manifest.longTextCells,1);
 for(const sheet of book.worksheets)for(const row of sheet.getRows(1,sheet.rowCount)||[])row.eachCell(c=>{assert.equal(c.type,3,'no formula, hyperlink or numeric coercion');});
 const fragments=book.worksheets.filter(s=>s.name.startsWith('长文本分片')).flatMap(s=>{const rows=[];s.eachRow((r,n)=>{if(n>1)rows.push({part:Number(r.getCell(5).value),value:r.getCell(7).value});});return rows;}).sort((a,b)=>a.part-b.part);
 assert.equal(JSON.parse(fragments.map(r=>r.value).join('')),values.at(-1));
});

test('native publication verifies four files in a Chinese path, never changes source or backup status, and refuses conflicts, repository roots and insufficient space',async t=>{
 const f=exportFixture(t);const parent=join(f.dir,'中文 导出目录');mkdirSync(parent);const d=businessExportDocument(f.capture(),false);const before=sourceHashes(f);const io=new BusinessExportFiles(helper);
 const result=await io.publish(parent,d,[]);assert.equal(result.files.length,4);
 for(const file of result.files){const b=readFileSync(join(result.location,file.name));assert.equal(b.length,file.bytes);assert.equal(sha(b),file.sha256);}
 const marker=readFileSync(join(result.location,'export.complete'),'utf8');assert(marker.includes(sha(readFileSync(join(result.location,'export-manifest.json')))));
 const leaf='sw-business-export-'+randomUUID().replaceAll('-','');mkdirSync(join(parent,leaf));writeFileSync(join(parent,leaf,'keep.txt'),'existing');
 await assert.rejects(io.publish(parent,d,[],leaf),e=>e.code==='failed');assert.equal(readFileSync(join(parent,leaf,'keep.txt'),'utf8'),'existing');
 const low=new BusinessExportFiles(helper,()=>0);const entries=readdirSync(parent);await assert.rejects(low.publish(parent,d,[]),e=>e.code==='failed');assert.deepEqual(readdirSync(parent),entries);
 assert.throws(()=>requireExportDestination(parent,[f.dir]),e=>e.code==='invalid');
 const repo=join(parent,'synthetic-repo');mkdirSync(repo);writeFileSync(join(repo,'.git'),'synthetic');assert.throws(()=>requireExportDestination(repo,[]),e=>e.code==='invalid');
 assert.deepEqual(sourceHashes(f),before);assert.equal(readBackupStatus(f.dir),null);
});

test('interrupted or truncated native output cannot create a successful completion marker',t=>{
 const f=exportFixture(t,0);const leaf='sw-business-export-'+randomUUID().replaceAll('-','');
 const r=spawnSync(helper,['publish-business',f.dir,leaf,'1000','1000','1000'],{input:Buffer.from('truncated'),windowsHide:true});
 assert.notEqual(r.status,0);assert(existsSync(join(f.dir,leaf)));assert(!existsSync(join(f.dir,leaf,'export.complete')));
 const denied=spawnSync(helper,['publish-business',f.dir,'../escape','1','1','1'],{input:Buffer.from('abc'),windowsHide:true});assert.notEqual(denied.status,0);
});
