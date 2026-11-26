const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspect, run, sha } = require('../scripts/check-sensitive-files.cjs');
const secret = () => ['gh', 'p_', 'Z'.repeat(36)].join('');
const review = bytes => ({ kind: 'synthetic-json', purpose: 'isolated guard acceptance fixture', provenance: 'generated in memory, no real business source', realStudentData: false, reviewed: true, sha256: sha(bytes) });

test('guard blocks database and archive magic after a harmless rename', () => {
 for (const bytes of [Buffer.from('SQLite format 3\0payload'), Buffer.from('SWBACK2\nbody'), Buffer.from('SWBACK1\nbody'), Buffer.from([80,75,3,4,0,1])]) {
  assert(inspect('notes.txt', bytes).some(f => f.rule === 'PRIVATE_CONTAINER_MAGIC'));
 }
});
test('guard blocks private extensions, data roots, symlinks and submodules', () => {
 for (const name of ['x.swbackup','x.sqlite3-wal','x.db-shm','x.csv','x.docx','x.xlsx','.env.local','exports/notes.txt']) assert(inspect(name, Buffer.from('synthetic')).length);
 for (const mode of ['120000','160000']) assert(inspect('source.ts', Buffer.from('synthetic'), {}, mode).some(f => f.rule === 'EXTERNAL_REFERENCE'));
});
test('fixture approval binds bytes and provenance, never just a demo label', () => {
 const bytes=Buffer.from('{"synthetic":true}'); const entry=review(bytes);
 assert.equal(inspect('test/fixtures/demo.json',bytes,{entries:{'test/fixtures/demo.json':entry}}).length,0);
 assert(inspect('test/fixtures/demo.json',Buffer.from('{"synthetic":false}'),{entries:{'test/fixtures/demo.json':entry}}).length);
 assert(inspect('test/fixtures/demo.json',bytes,{entries:{'test/fixtures/demo.json':{...entry,provenance:''}}}).length);
});
test('approved fixture bytes still cannot contain credentials or private paths', () => {
 const bytes=Buffer.from(JSON.stringify({fake:secret()}));
 assert(inspect('test/fixtures/demo.json',bytes,{entries:{'test/fixtures/demo.json':review(bytes)}}).some(f => f.rule === 'CREDENTIAL'));
 const privateLocation=['C:', 'Users', 'SyntheticAccount', 'data'].join('\\');
 assert(inspect('src/example.ts',Buffer.from(privateLocation)).some(f => f.rule === 'PERSONAL_PATH'));
});
test('guard distinguishes phone shapes from hexadecimal object IDs', () => {
 assert(inspect('note.txt',Buffer.from(['13','8','0'.repeat(8)].join(''))).some(f => f.rule === 'PERSONAL_CONTACT'));
 assert.equal(inspect('note.txt',Buffer.from('a'+['13','8','0'.repeat(8)].join('')+'b')).length,0);
});
test('unreviewed binary and LFS pointers fail closed', () => {
 assert(inspect('note.txt',Buffer.from([1,0,2])).some(f => f.rule === 'UNREVIEWED_BINARY'));
 assert(inspect('note.txt',Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:0')).some(f => f.rule === 'UNINSPECTED_LFS_OBJECT'));
});

test('initialization, recovery, pending journals and rotated diagnostics are ignored and blocked when forced', () => {
 const names=['mvp.initialized','restore.ready','activation.approved','profile-selection-v1.json','student-write.pending','student-write.json','operations-request.guard','last-verified-backup-v1.txt','.backup-status-synthetic','diagnostics.jsonl','diagnostics.2.jsonl'];
 for(const name of names) assert(inspect(name,Buffer.from('synthetic')).some(f=>f.rule==='PRIVATE_PROFILE_STATE'));
 const ignored=execFileSync('git',['check-ignore','--no-index','--stdin'],{cwd:path.join(__dirname,'..'),input:names.join('\n')+'\n',encoding:'utf8'}).trim().split(/\r?\n/);
 assert.deepEqual(ignored,names);
 assert.equal(inspect('src/profile-activation.ts',Buffer.from('source')).length,0);
});
test('findings never repeat secret contents or a private filename', () => {
 const value=secret();const file=['Private','Student','Record'].join('')+'.txt';const result=JSON.stringify(inspect(file,Buffer.from(value)));
 assert(!result.includes(value));assert(!result.includes(file));assert(result.includes('fileId'));
});
test('staged scan reads index bytes, ignores untracked files and catches staged deletion bypass', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'privacy-index-')); const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try {
  git(['init','-q']);fs.mkdirSync(path.join(root,'test','fixtures'),{recursive:true});
  fs.writeFileSync(path.join(root,'test','fixtures','manifest.json'),JSON.stringify({entries:{}}));
  fs.writeFileSync(path.join(root,'note.txt'),'initial');git(['add','.']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','initial']);
  fs.writeFileSync(path.join(root,'untracked.txt'),secret());assert.equal(run(['--staged'],root).findings.length,0);
  fs.writeFileSync(path.join(root,'note.txt'),secret());git(['add','note.txt']);fs.writeFileSync(path.join(root,'note.txt'),'clean worktree');
  assert(run(['--staged'],root).findings.some(f=>f.rule==='CREDENTIAL'));
  git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','intermediate']);git(['add','note.txt']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','clean tip']);
  assert.equal(run(['--tracked'],root).findings.length,0);
  assert(run(['--history','HEAD~2..HEAD'],root).findings.some(f=>f.rule==='CREDENTIAL'));
 } finally { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'privacy-index-'));fs.rmSync(root,{recursive:true,force:true}); }
});
