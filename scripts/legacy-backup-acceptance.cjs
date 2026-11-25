// Isolated Windows packaged-Electron acceptance. Never point this at an installed production EXE.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const [exeArg, candidateArg, outputArg] = process.argv.slice(2);const mode='compatibility';
let exe = fs.realpathSync.native(resolve(exeArg));
assert(!/^D:\\SupervisorWorkspace\\/i.test(exe));
assert.equal(process.platform, 'win32');
const output = resolve(outputArg); fs.mkdirSync(output, { recursive: true });
let profile = 'sw-services-v6-compat-' + randomUUID().replaceAll('-', '');
let owner = join('D:\\Codex-Development\\Temp\\sw-student-services-profiles', profile);
assert(!fs.existsSync(owner));
const E = "process.mainModule.require('electron')", W = E + '.BrowserWindow.getAllWindows()[0]';
const evidence = { mode, exe, owner, cases: [] };
let child, ws, sequence = 0;
async function wait(fn, label = 'condition') { let cause; for (let i = 0; i < 200; i++) { try { if (await fn()) return; } catch (error) { cause = error; } await delay(100); } throw Error('Timeout: ' + label, { cause }); }
function main(expression) { return new Promise((resolve, reject) => {
  const id = ++sequence;
  const listener = ({ data }) => { const m = JSON.parse(data); if (m.id !== id) return;
    clearTimeout(timer); ws.removeEventListener('message', listener);
    if (m.error || m.result.exceptionDetails) reject(Error(JSON.stringify(m.error || m.result.exceptionDetails)));
    else resolve(m.result.result.value);
  };
  const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(Error('Inspector timeout')); }, 20000);
  ws.addEventListener('message', listener);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
}); }
const ui = code => main(W + '.webContents.executeJavaScript(' + JSON.stringify(code) + ')');
const api = (name, ...args) => ui('window.supervisorWorkspace[' + JSON.stringify(name) + '](...' + JSON.stringify(args) + ')');
const ok = reply => { assert(reply.ok, JSON.stringify(reply)); return reply.value; };
async function launch() {
  const server = require('node:net').createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r));
  const env = { ...process.env, M2C_SYNTHETIC_PACKAGED: '1', M2C_SYNTHETIC_TEST: '0', M2C_SYNTHETIC_PROFILE: profile, M2B_SYNTHETIC_TEST: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, ['--inspect=127.0.0.1:' + port], { env, cwd: output, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {});
  let endpoint;
  await wait(async () => { try { endpoint = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json())[0]?.webSocketDebuggerUrl; return endpoint; } catch { return false; } }, 'inspector');
  ws = new WebSocket(endpoint); await once(ws, 'open');
  await wait(() => ui('Boolean(window.supervisorWorkspace && document.querySelector("#schedule-title"))'), 'application');
  evidence.runtime = await main('({userData:' + E + '.app.getPath("userData"),packaged:' + E + '.app.isPackaged,electron:process.versions.electron,node:process.versions.node})');
  assert(evidence.runtime.userData.startsWith(owner + require('node:path').sep));
  await main('(()=>{const ipc=' + E + '.ipcMain;const handler=ipc._invokeHandlers.get("mvp:save-student-record");globalThis.scoreSubmissions=[];ipc.removeHandler("mvp:save-student-record");ipc.handle("mvp:save-student-record",async(e,input)=>{scoreSubmissions.push(structuredClone(input));const r=await handler(e,input);if(globalThis.delayScoreSave)await new Promise(resolve=>globalThis.releaseScoreSave=resolve);return r;});return true;})()');
}
async function close() { const done = once(child, 'exit'); await main('setTimeout(()=>'+W+'.close(),100);true'); ws.close(); const [code] = await done; assert.equal(code, 0); child = undefined; }
async function click(text, scope = 'button') { await ui('Array.from(document.querySelectorAll('+JSON.stringify(scope)+')).find(x=>x.textContent.trim()==='+JSON.stringify(text)+').click();true'); await delay(120); }
async function select(selector, value) { await ui('(()=>{const x=document.querySelector('+JSON.stringify(selector)+');x.value='+JSON.stringify(value)+';x.dispatchEvent(new Event("change",{bubbles:true}));return true;})()'); await delay(100); }
async function fill(name, value) { await ui('(()=>{const x=document.querySelector("#student-section-score [name='+name+']");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,'+JSON.stringify(value)+');x.dispatchEvent(new Event("input",{bubbles:true}));return true;})()'); }
async function inputValue() { return ui('document.querySelector("input[name=maximum]").value'); }
async function points() { return ui('Array.from(document.querySelectorAll(".score-trend-points li")).map(x=>x.textContent)'); }
async function openStudent(alias) { await ui('Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes('+JSON.stringify(alias)+')).click();true'); await delay(150); await click('成绩趋势'); }
async function screenshot(name) {
  await main(W+'.setSize(1100,1200);true');
  await ui('document.querySelector(".score-trend").scrollIntoView({block:"start"});window.scrollBy(0,-90);true'); await delay(150);
  await main(W+'.capturePage().then(i=>process.mainModule.require("node:fs").writeFileSync('+JSON.stringify(join(output,name))+',i.toPNG())).then(()=>true)');
}
async function saveFields(studentId, fields) { const row = ok(await api('saveStudentRecord', { kind: 'score', studentId, id: randomUUID(), requestId: randomUUID(), expectedRevision: 0, fields })); ok(await api('resolveStudentWrite', 'confirm', row.requestId)); return row; }
const data = (assessment, takenOn, category, score, maximum, subject = '数学') => ({ assessment, takenOn, category, score, maximum, subject, notes: '' });

function snapshot(folder){const result={};for(const name of ['mvp','worklog','growth','student-intake','operations']){const db=new DatabaseSync(join(folder,name+'.sqlite3'),{readOnly:true});try{const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();result[name]={version:db.prepare('PRAGMA user_version').get().user_version,tables:tables.map(t=>({...t,rows:db.prepare('SELECT * FROM '+t.name+' ORDER BY rowid').all()})),integrity:db.prepare('PRAGMA quick_check').all()};}finally{db.close();}}return result;}
const sha=path=>require('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex');
async function quitBySwitch(method){await main(E+'.dialog.showMessageBox=async()=>({response:1});true');const exit=once(child,'exit');await ui('void window.supervisorWorkspace['+JSON.stringify(method)+']()');ws.close();const [code]=await Promise.race([exit,delay(12000,null,{ref:false}).then(()=>{throw Error('Switch did not exit');})]);assert.equal(code,0);child=undefined;}
(async()=>{
 await launch();evidence.oldVersion=await main(E+'.app.getVersion()');assert.equal(evidence.oldVersion,'0.2.0');
 const student=ok(await api('createStudent',{id:randomUUID(),alias:'虚构旧版兼容',grade:'七年级',subjects:'数学',goal:'保留旧目标',notes:'合成'}));
 await saveFields(student.id,data('旧版期中','2026-01-01','期中考试','120','150'));await saveFields(student.id,data('旧版小测','2025-12-31','日常测验','80.25','100'));
 const concern=ok(await api('createParentConcern',{requestId:randomUUID(),studentId:student.id,reportedOn:'2026-11-25',role:'mother',category:'academic',concern:'旧版合成诉求',nextOn:''}));ok(await api('resolveStudentWrite','confirm',concern.requestId));
 ok(await api('addLesson',{id:randomUUID(),studentId:student.id,date:'2026-11-25',subject:'数学',task:'旧版合成任务',completion:'完成',assessment:'旧版观察',nextStep:'复习'}));
 ok(await api('saveWorkItem',{id:randomUUID(),title:'旧版合成工作',workDate:'2026-11-25',studentId:student.id,startedAt:'',notes:'保留',nextStep:''}));
 const fixture=join(__dirname,'../test/fixtures/synthetic-intake-001.json');await main(E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']});true');const file=ok(await api('pickStudentIntake'))[0];const target={kind:'existing',studentId:student.id};const review=ok(await api('prepareStudentIntake',file.token,target));assert.equal(ok(await api('saveStudentIntake',{token:file.token,target,expectedRevision:review.revision,fields:review.proposed,reviewed:true})).state,'saved');
 // Deterministic clock only inside this synthetic application's main process.
 const at=time=>Date.parse('2026-12-05T'+time+':00+08:00');await main('globalThis.originalClock=Date.now;Date.now=()=>'+at('07:50')+';true');
 const operation=async(method,input)=>{const result=ok(await api(method,input));ok(await api('acknowledgeOperation',input.requestId));return result;};
 let plan=await operation('saveSchedulePlan',{id:randomUUID(),studentId:student.id,requestId:randomUUID(),expectedRevision:0,startAt:at('08:00'),endAt:at('10:00'),kind:'regular'});
 const change=(row,fields)=>({id:row.id,studentId:student.id,attendanceId:plan.id,expectedRevision:row.revision,requestId:randomUUID(),...fields});
 let block=await operation('applyLearningChange',change({id:randomUUID(),revision:0},{command:'saveLearningBlock',plannedStart:at('08:00'),plannedEnd:at('09:00'),notes:'旧版合成学习块'}));
 const taskId=randomUUID();block=await operation('applyLearningChange',change(block,{command:'saveLearningTasks',tasks:[{id:taskId,category:'home_school',subject:'数学',content:'旧版合成任务'}]}));
 await main('Date.now=()=>'+at('08:01')+';true');plan=await operation('applyLearningChange',change(plan,{command:'recordAttendance',action:'checkIn'}));
 block=await operation('applyLearningChange',change(block,{command:'recordLearningOutcome',action:'start'}));block=await operation('applyLearningChange',change(block,{command:'recordTaskOutcome',taskId,status:'in_progress'}));
 await main('Date.now=()=>'+at('08:25')+';true');block=await operation('applyLearningChange',change(block,{command:'recordTaskOutcome',taskId,status:'done',resultNotes:'旧版合成完成'}));
 await main('Date.now=()=>'+at('08:30')+';true');block=await operation('applyLearningChange',change(block,{command:'recordLearningOutcome',action:'finish'}));plan=await operation('applyLearningChange',change(plan,{command:'recordAttendance',action:'checkOut'}));await main('Date.now=originalClock;true');evidence.oldProgramOperationsCompleted=true;
 const backupParent=fs.mkdtempSync(join(output,'synthetic-backups-'));await main(E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(backupParent)+']});true');const backup=ok(await api('exportProtection'));evidence.backupSha256=sha(backup.location);assert.equal(backup.formatVersion,2);const oldOwner=owner;
 await close();const original=snapshot(join(oldOwner,'profile','data'));const originalHashes=Object.fromEntries(['mvp','worklog','growth','student-intake','operations'].map(n=>[n,sha(join(oldOwner,'profile','data',n+'.sqlite3'))]));
 exe=fs.realpathSync.native(resolve(candidateArg));assert(!/^D:\\SupervisorWorkspace\\/i.test(exe));profile='sw-services-v6-compat-'+randomUUID().replaceAll('-','');owner=join('D:\\Codex-Development\\Temp\\sw-student-services-profiles',profile);assert(!fs.existsSync(owner));await launch();evidence.candidateVersion=await main(E+'.app.getVersion()');
 await main(E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(backup.location)+']});'+E+'.dialog.showMessageBox=async()=>({response:1});true');const restored=ok(await api('restoreProtection'));assert.deepEqual(snapshot(join(restored.location,'recovery')),original);evidence.allTablesEqualBeforeActivation=true;
 await main(E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(join(restored.location,'restore.ready'))+']});true');await quitBySwitch('activateRecovery');await launch();
 assert.deepEqual(ok(await api('students')).map(s=>s.id),[student.id]);assert.equal(ok(await api('studentRecords','score',student.id)).records.length,2);assert.equal(ok(await api('parentFollowUp',student.id)).concerns[0].concern,'旧版合成诉求');const day=ok(await api('learningDay',{studentId:student.id,attendanceId:plan.id}));assert.equal(day.blocks[0].status,'done');assert.equal(day.blocks[0].tasks[0].status,'done');assert(day.attendance.checkOutAt);evidence.candidateOpenedRestoredBackup=true;evidence.restoredAttendanceAndTaskComplete=true;
 await quitBySwitch('returnOriginalProfile');await launch();assert.equal(ok(await api('students')).length,0);await close();
 assert.equal(sha(backup.location),evidence.backupSha256);for(const [n,h]of Object.entries(originalHashes))assert.equal(sha(join(oldOwner,'profile','data',n+'.sqlite3')),h);
 evidence.sourceDatabasesUnchanged=true;evidence.sourceBackupUnchanged=true;evidence.roundTripToEmptyCandidateProfile=true;evidence.tables=Object.fromEntries(Object.entries(original).map(([n,s])=>[n,{version:s.version,tables:s.tables.length,rows:s.tables.reduce((sum,t)=>sum+t.rows.length,0)}]));evidence.completed=true;fs.writeFileSync(join(output,'compatibility.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
})().catch(e=>{evidence.error=e.stack;fs.writeFileSync(join(output,'compatibility.json'),JSON.stringify(evidence,null,2));console.error(e);if(child)child.kill();process.exitCode=1;});





