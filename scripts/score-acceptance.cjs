// Isolated Windows packaged-Electron acceptance. Never point this at an installed production EXE.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const [exeArg, outputArg, mode = 'candidate'] = process.argv.slice(2);
const exe = fs.realpathSync.native(resolve(exeArg));
assert(!/^D:\\SupervisorWorkspace\\/i.test(exe));
assert.equal(process.platform, 'win32');
const output = resolve(outputArg); fs.mkdirSync(output, { recursive: true });
const profile = 'sw-services-v6-phase1-' + randomUUID().replaceAll('-', '');
const owner = join('D:\\Codex-Development\\Temp\\sw-student-services-profiles', profile);
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
  assert.equal(evidence.runtime.userData, join(owner, 'profile', 'chromium'));
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

(async () => {
  await launch();
  const student = ok(await api('createStudent', { id: randomUUID(), alias: '虚构验收甲', grade: '七年级', subjects: '数学、英语', goal: '', notes: '' }));
  const beta = ok(await api('createStudent', { id: randomUUID(), alias: '虚构验收乙', grade: '八年级', subjects: '数学', goal: '', notes: '' }));
  evidence.studentId = student.id;
  await saveFields(student.id, data('英语隔离', '2026-01-01', '日常测验', '70', '100', '英语'));
  const exams = [data('跨年甲', '2025-12-31', '日常测验', '60', '100'), data('跨年乙', '2026-01-01', '期中考试', '105', '150'),
    data('同日甲', '2026-02-01', '日常测验', '120', '150'), data('同日乙', '2026-02-01', '期末考试', '108', '120')];
  for (const fields of exams) await saveFields(student.id, fields);
  await saveFields(beta.id, data('乙独立成绩', '2026-01-01', '日常测验', '1', '100'));
  await close(); await launch(); await click('学生档案', 'nav button'); await openStudent('虚构验收甲');
  await wait(async () => (await points()).length > 0);
  evidence.defaultPoints = await points(); evidence.defaultCount = evidence.defaultPoints.length;
  evidence.expectedCount = 4; evidence.productRulePass = evidence.defaultCount === 4;
  await screenshot(mode+'-comparison.png');
  if (mode === 'baseline') { await close(); fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence)); process.exitCode = evidence.productRulePass ? 1 : 0; return; }
  assert.equal(evidence.defaultCount, 4);
  await main(W+'.webContents.executeJavaScript('+JSON.stringify('({html:document.querySelector(".score-trend").outerHTML,chart:document.querySelector(".score-trend canvas").toDataURL()})')+').then(snapshot=>{const fs=process.mainModule.require("node:fs"),p=process.mainModule.require("node:path"),assets=p.join('+E+'.app.getAppPath(),"dist","assets");const css=fs.readdirSync(assets).filter(n=>n.endsWith(".css")).map(n=>fs.readFileSync(p.join(assets,n),"utf8")).join("\\n");fs.writeFileSync('+JSON.stringify(join(output,'component.html'))+',"<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content=width=device-width,initial-scale=1><title>成绩趋势</title><style>"+css+"body{padding:20px}main{max-width:800px;margin:auto}h1{font-size:24px}</style><main><h1>成绩趋势</h1>"+snapshot.html+"</main><script>const image=new Image();image.onload=()=>document.querySelector(\'canvas\').getContext(\'2d\').drawImage(image,0,0);image.src="+JSON.stringify(snapshot.chart)+";</script></html>");return true;})');
  assert(evidence.defaultPoints[0].includes('2025-12-31')); assert(evidence.defaultPoints[1].includes('2026-01-01'));
  assert.equal(evidence.defaultPoints.filter(x=>x.includes('2026-02-01')).length,2);
  const controls = '.score-trend-controls label';
  assert.equal(await ui('document.querySelector("'+controls+':nth-child(3) option[value=raw]").disabled'), true);
  await select(controls+':nth-child(2) select', '期中考试'); assert.equal((await points()).length,1);
  await select(controls+':nth-child(3) select', 'raw'); assert.equal(await ui('document.querySelector("'+controls+':nth-child(3) select").value'),'raw');
  await select(controls+':nth-child(2) select', ''); assert.equal((await points()).length,4);
  assert.equal(await ui('document.querySelector("'+controls+':nth-child(3) select").value'),'rate');
  await select(controls+':nth-child(1) select', '英语'); assert.equal((await points()).length,1);
  await select(controls+':nth-child(1) select', '数学');
  evidence.cases.push({name:'category subject raw-rate controls',pass:true});

  await click('新增成绩'); await fill('maximum',''); await ui('document.querySelector("input[name=maximum]").focus();true');
  const typing=[]; for(const char of '150.50'){await main(W+'.webContents.insertText('+JSON.stringify(char)+')');typing.push(await inputValue());}
  await ui('document.querySelector("input[name=maximum]").blur();true'); assert.equal(await inputValue(),'150.50');
  evidence.cases.push({name:'type and blur',typing,value:await inputValue()});
  await fill('maximum','');
  evidence.cases.push({name:'native paste',status:'not-run',reason:'Requires an explicitly approved independent Windows session; this script never accesses the system clipboard.'});
  await fill('maximum','100');await ui('document.querySelector("input[name=maximum]").focus();true');
  await main(W+'.webContents.sendInputEvent({type:"keyDown",keyCode:"Up"});'+W+'.webContents.sendInputEvent({type:"keyUp",keyCode:"Up"});true');await delay(80);
  evidence.cases.push({name:'native step',before:'100',after:await inputValue()});
  await fill('maximum','150.50');
  for(const deltaY of [-120,120]) { const position = await ui('(()=>{const x=document.querySelector("input[name=maximum]");x.scrollIntoView({block:"center"});x.focus();const r=x.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await main(W+'.webContents.sendInputEvent('+JSON.stringify({type:'mouseMove',...position})+');'+W+'.webContents.sendInputEvent('+JSON.stringify({type:'mouseWheel',...position,deltaY,deltaX:0,canScroll:true})+');true'); await delay(100);
    evidence.cases.push({name:'native wheel',deltaY,value:await inputValue()}); }
  await fill('assessment','四层数值核对');await fill('subject','数学');await fill('takenOn','2026-11-25');await fill('score','90.25');
  await select('#student-section-score select[name=category]','期中考试');await click('家长诉求');await click('成绩趋势');assert.equal(await inputValue(),'150.50');
  evidence.beforeSaveDisplay=await inputValue();
  await main('globalThis.delayScoreSave=true;true');await click('保存成绩');
  await wait(()=>main('Boolean(globalThis.releaseScoreSave)'));
  await ui('document.querySelector("#student-section-score form").requestSubmit();document.querySelector("#student-section-score form").requestSubmit();true');
  evidence.cases.push({name:'delayed save and rapid duplicate submits',value:await inputValue(),studentSwitchDisabled:await ui('Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes("虚构验收乙")).disabled')});
  await main('globalThis.delayScoreSave=false;globalThis.releaseScoreSave();true');
  await wait(()=>ui('!document.querySelector("#student-section-score form")'));
  evidence.submissions=await main('scoreSubmissions');assert.equal(evidence.submissions.length,1);assert.equal(evidence.submissions[0].fields.maximum,'150.50');
  evidence.readback=ok(await api('studentRecords','score',student.id)).records.find(r=>r.fields.assessment==='四层数值核对');assert.equal(evidence.readback.fields.maximum,'150.50');
  // Continuous creation uses a fresh entity and does not change the previous record.
  await click('新增成绩');assert.equal(await inputValue(),'');await fill('assessment','连续新增');await fill('subject','数学');await fill('takenOn','2026-11-26');await fill('score','40');await fill('maximum','50');await click('保存成绩');await wait(()=>ui('!document.querySelector("#student-section-score form")'));
  // Edit an old exam and verify the visible trend refreshes without a restart.
  await ui('Array.from(document.querySelectorAll("#student-section-score ul.student-source-list>li")).find(x=>x.querySelector("h3").textContent==="跨年甲").querySelector("button").click();true');await fill('score','88.25');await click('保存成绩');
  await wait(async()=> (await points()).some(x=>x.includes('跨年甲')&&x.includes('88.25/100')));
  evidence.cases.push({name:'history edit refresh',pass:true});
  // Hold an old student's read result, switch away, then release the stale result.
  await main('(()=>{const ipc='+E+'.ipcMain;const handler=ipc._invokeHandlers.get("mvp:student-records");ipc.removeHandler("mvp:student-records");ipc.handle("mvp:student-records",async(e,kind,id)=>{const r=await handler(e,kind,id);if(kind==="score"&&id==='+JSON.stringify(student.id)+')await new Promise(resolve=>globalThis.releaseScoreRead=resolve);return r;});return true;})()');
  await openStudent('虚构验收乙');await openStudent('虚构验收甲');await wait(()=>main('Boolean(globalThis.releaseScoreRead)'));await openStudent('虚构验收乙');await main('globalThis.releaseScoreRead();true');await delay(150);
  assert.equal((await points()).length,1);assert((await points())[0].includes('乙独立成绩'));evidence.cases.push({name:'late read after student switch',pass:true});
  await close();
  const database = new DatabaseSync(join(owner,'profile','data','mvp.sqlite3'),{readOnly:true});
  try { evidence.databasePayloads=database.prepare('SELECT payload FROM student_scores WHERE entity_id=? ORDER BY revision').all(evidence.readback.id).map(r=>JSON.parse(r.payload));evidence.schemaVersion=database.prepare('PRAGMA user_version').get().user_version;evidence.integrity=database.prepare('PRAGMA quick_check').all(); } finally {database.close();}
  assert.equal(evidence.databasePayloads[0].maximum,'150.50');
  await launch();await click('学生档案','nav button');await openStudent('虚构验收甲');
  await ui('Array.from(document.querySelectorAll("#student-section-score ul.student-source-list>li")).find(x=>x.querySelector("h3").textContent==="四层数值核对").querySelector("button").click();true');
  evidence.reopenedDisplay=await inputValue();assert.equal(evidence.reopenedDisplay,'150.50');await click('取消编辑');
  evidence.reopenedPoints=await points();assert.equal(evidence.reopenedPoints.length,6);
  await screenshot('candidate-reopened.png');
  evidence.viewStates=await require('./score-view-states.cjs')(ui,output);
  await close();
  evidence.completed=true;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({completed:true,defaultCount:evidence.defaultCount,cases:evidence.cases,owner}));
})().catch(async error=>{evidence.error=error.stack;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));console.error(error);if(child)child.kill();process.exitCode=1;});





