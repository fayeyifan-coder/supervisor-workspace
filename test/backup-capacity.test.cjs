const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {join}=require('node:path');
const {exportFixture}=require('./export-fixture.cjs');
const {applyBackupPageLimit,readBackupCapacity,backupDatabaseWarning,backupDatabaseLimit}=require('../build/backup-capacity.js');
const {failure}=require('../build/database.js');
const {ProtectionFiles,validateProtection}=require('../build/offline-protection.js');

test('near-capacity committed WAL remains independently restorable while an oversized write rolls back',async t=>{
 const f=exportFixture(t,1,16), db=f.m1.protectionConnection(),studentId=f.studentId;
 const stores=f.stores.map(store=>store.protectionConnection());
 stores.forEach(applyBackupPageLimit);
 assert(stores.every(s=>Number(s.prepare('PRAGMA max_page_count').get().max_page_count)===8192));
 db.exec('PRAGMA wal_autocheckpoint=0');
 const idTag=randomUUID();
 const insert=db.prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
 INSERT INTO learning_records SELECT printf('%s-%d',?,i),?,'2026-11-26','数学',?,'部分完成',?,'合成继续',1 FROM n`);
 const sample='合成'.repeat(225);
 for(let batch=0;batch<500&&readBackupCapacity(stores).stores[0].bytes<backupDatabaseWarning;batch++){
  insert.run(`${idTag}-${batch}`,studentId,sample,sample);
 }
 const capacity=readBackupCapacity(stores);
 assert(capacity.stores[0].bytes>=backupDatabaseWarning&&capacity.stores[0].bytes<backupDatabaseLimit);
 const last=randomUUID();
 assert.throws(()=>db.prepare("INSERT INTO learning_records VALUES(?,?,'2026-11-26','数学',?,'合成','合成','合成',1)")
  .run(last,studentId,'合成'.repeat(6*1024*1024)),err=>failure(err).message.includes('达到离线备份容量'));
 assert.equal(db.prepare('SELECT count(*) AS n FROM learning_records WHERE id=?').get(last).n,0);
 const bytes=f.capture(),io=new ProtectionFiles(join(__dirname,'../build/recovery-io.exe'));
 const staged=await io.restore(f.dir,bytes);
 const restored=await io.inspect(f.dir,staged.profileName,2,16);
 assert(restored.bytes.equals(bytes));
 const checked=validateProtection(restored.bytes);
 assert.equal(checked.images[0].length,capacity.stores[0].bytes);
 const memory=new DatabaseSync(':memory:');memory.deserialize(checked.images[0]);
 try{assert.equal(memory.prepare('SELECT count(*) AS n FROM learning_records').get().n,
  db.prepare('SELECT count(*) AS n FROM learning_records').get().n);}
 finally{memory.close();}
});
