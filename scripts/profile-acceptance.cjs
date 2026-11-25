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
const profile = (mode === 'legacy' ? 'phase2-legacy-' : 'sw-services-v6-phase2-') + randomUUID().replaceAll('-', '');
const owner = mode === 'legacy' ? join('D:\\Codex-Development\\Temp',profile) : join('D:\\Codex-Development\\Temp\\sw-student-services-profiles', profile);
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
  await wait(() => ui(mode === 'legacy' ? 'Boolean(window.supervisorWorkspace && document.querySelector(".workspace") && !document.querySelector(".workspace").hidden && !document.querySelector("aside button").disabled)' : 'Boolean(window.supervisorWorkspace && Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent==="学生档案"&&!b.disabled) && document.querySelector("#schedule-title"))'), 'application ready');
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

const navLabels = () => ui('Array.from(document.querySelectorAll(".student-detail-nav button")).map(x=>x.textContent)');
const selected = () => ui('document.querySelector(".student-detail-nav [aria-pressed=true]")?.textContent');
async function choose(alias) { await ui('Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes('+JSON.stringify(alias)+')).click();true');await delay(80); }
async function profileShot(name) { await main(W+'.setSize(1100,1000);true');await ui('window.scrollTo(0,0);true');await delay(120);await main(W+'.capturePage().then(i=>process.mainModule.require("node:fs").writeFileSync('+JSON.stringify(join(output,name))+',i.toPNG())).then(()=>true)'); }
(async()=>{
 await launch();const students=[];
 for(let i=1;i<=20;i++){
  const s=ok(await api('createStudent',{id:randomUUID(),alias:'虚构学生'+String(i).padStart(2,'0'),grade:'七年级',subjects:'数学',goal:'既有阶段目标'+i,notes:''}));students.push(s);
  if(mode!=='legacy'){const c=ok(await api('createParentConcern',{requestId:randomUUID(),studentId:s.id,reportedOn:'2026-11-25',role:'mother',category:'academic',concern:'专属诉求'+String(i).padStart(2,'0'),nextOn:''}));ok(await api('resolveStudentWrite','confirm',c.requestId));}
 }
 const a=students[0],b=students[1];ok(await api('addLesson',{id:randomUUID(),studentId:a.id,date:'2026-11-25',subject:'数学',task:'虚构历史任务',completion:'完成',assessment:'合成观察',nextStep:'复习'}));
 if(mode!=='legacy'){
  await saveFields(a.id,data('甲独立考试','2026-11-25','日常测验','80','100'));await saveFields(b.id,data('乙独立考试','2026-11-25','日常测验','60','100'));
  const fixture=join(__dirname,'../test/fixtures/synthetic-intake-001.json');await main(E+'.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']});true');
  const file=ok(await api('pickStudentIntake'))[0];assert(file.token,JSON.stringify(file));const target={kind:'existing',studentId:a.id};const review=ok(await api('prepareStudentIntake',file.token,target));
  assert.equal(ok(await api('saveStudentIntake',{token:file.token,target,expectedRevision:review.revision,fields:review.proposed,reviewed:true})).state,'saved');evidence.sourceCode=file.source.code;
 }
 await close();await launch();if(mode!=='legacy')await click('学生档案','nav button');await choose(a.alias);await wait(()=>ui('Boolean(document.querySelector(".student-detail-nav"))'));assert.equal(await ui('document.querySelector(".workspace").hidden'),false);
 evidence.defaultTab=await selected();evidence.navigation=await navLabels();await profileShot(mode+'-profile.png');
 if(mode==='baseline'){assert.equal(evidence.defaultTab,'成长档案');await close();evidence.completed=true;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));return;}
 if(mode==='legacy'){assert.deepEqual(evidence.navigation,['成长档案','学习历史','导入来源']);await click('学习历史');assert(await ui('document.querySelector("#student-section-history").innerText.includes("虚构历史任务")'));await close();evidence.completed=true;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));return;}
 assert.deepEqual(evidence.navigation,['家长诉求','成绩趋势','成长档案','提分方案','报名与到期','基础档案编辑','学习历史','导入来源']);assert.equal(evidence.defaultTab,'家长诉求');
 await wait(()=>ui('document.querySelector("#student-section-parent").innerText.includes("专属诉求01")'));
 await click('学习历史');assert(await ui('document.querySelector("#student-section-history").innerText.includes("虚构历史任务")'));
 await click('导入来源');assert(await ui('document.querySelector("#student-section-sources").innerText.includes('+JSON.stringify(evidence.sourceCode)+')'));
 await click('成绩趋势');await wait(()=>ui('document.querySelector("#student-section-score").innerText.includes("甲独立考试")'));
 await click('查看该学生排课');assert.equal(await ui('!document.querySelector(".workspace").hidden'),false);await click('学生档案','nav button');await choose(a.alias);
 await click('基础档案编辑');await click('修改基础档案');await ui('(()=>{const x=document.querySelector("#student-section-edit textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(x,"更新后的既有目标");x.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#student-section-edit form").requestSubmit();return true;})()');
 await wait(()=>ui('!document.querySelector("#student-section-edit form")'));assert.equal(await selected(),'基础档案编辑');evidence.cases.push({name:'same-student refresh retains selected tab',pass:true});
 await click('家长诉求');await click('登记诉求');
 await main('(()=>{const ipc='+E+'.ipcMain;const h=ipc._invokeHandlers.get("mvp:create-parent-concern");ipc.removeHandler("mvp:create-parent-concern");ipc.handle("mvp:create-parent-concern",async(e,input)=>{globalThis.heldConcern=input;await new Promise(resolve=>globalThis.releaseConcern=resolve);const result=await h(e,input);ipc.removeHandler("mvp:create-parent-concern");ipc.handle("mvp:create-parent-concern",h);throw Error("synthetic lost reply");});return true;})()');
 await ui('(()=>{const f=document.querySelector("#student-section-parent form");f.querySelector("textarea").value="合成待核对诉求";f.querySelector("select[name=role]").value="mother";f.querySelector("select[name=category]").value="academic";f.requestSubmit();return true;})()');
 await wait(()=>main('Boolean(globalThis.releaseConcern)'));assert(await ui('Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes("虚构学生02")).disabled'));
 await main('globalThis.releaseConcern();true');await wait(()=>ui('Boolean(document.querySelector(".student-write-recovery"))'));
 const pending=ok(await api('studentWriteState'));assert.equal(pending.kind,'pending');assert.equal(pending.outcome,'saved');
 const blocked=await api('createParentConcern',{requestId:randomUUID(),studentId:a.id,reportedOn:'2026-11-25',role:'mother',category:'academic',concern:'不得写入',nextOn:''});assert(!blocked.ok);
 await click('确认已保存','.student-write-recovery button');await wait(async()=>ok(await api('studentWriteState')).kind==='empty');evidence.cases.push({name:'busy switch blocked and lost reply retains durable request until confirmation',pass:true});
 await click('登记诉求');await ui('(()=>{const x=document.querySelector("#student-section-parent textarea");x.value="未保存合成草稿";x.dispatchEvent(new Event("input",{bubbles:true}));window.confirm=()=>false;return true;})()');
 await click('成绩趋势');await click('家长诉求');assert.equal(await ui('document.querySelector("#student-section-parent textarea").value'),'未保存合成草稿');await choose(b.alias);assert.equal(await ui('document.querySelector("#student-detail-heading").textContent'),a.alias);
 await ui('window.confirm=()=>true;true');await click('取消','#student-section-parent button');evidence.cases.push({name:'draft survives tabs and cancelled student switch',pass:true});
 await choose(b.alias);
 await main('(()=>{const ipc='+E+'.ipcMain;globalThis.delayedReads=[];globalThis.delayedReadChannels=[];for(const channel of ["mvp:parent-follow-up","mvp:student-records","m2c:student-intake-history"]){const h=ipc._invokeHandlers.get(channel);if(!h)throw Error("Missing handler "+channel);ipc.removeHandler(channel);ipc.handle(channel,async(e,...args)=>{const result=await h(e,...args);if(args.includes('+JSON.stringify(a.id)+')&&(channel!=="mvp:student-records"||args[0]==="score"))await new Promise(resolve=>{delayedReadChannels.push(channel);delayedReads.push(resolve);});return result;});}return true;})()');
 await choose(a.alias);await wait(()=>main('new Set(delayedReadChannels).size===3'));await choose(b.alias);await main('delayedReads.forEach(r=>r());true');await delay(150);
 assert.equal(await selected(),'家长诉求');assert(await ui('document.querySelector("#student-section-parent").innerText.includes("专属诉求02")'));assert(!(await ui('document.querySelector("#student-section-parent").innerText.includes("专属诉求01")')));
 await click('成绩趋势');assert(await ui('document.querySelector("#student-section-score").innerText.includes("乙独立考试")'));await click('导入来源');assert(!(await ui('document.querySelector("#student-section-sources").innerText.includes('+JSON.stringify(evidence.sourceCode)+')')));evidence.cases.push({name:'three delayed old-student responses ignored',pass:true});
 await close();await launch();await click('学生档案','nav button');evidence.switchTimings=[];
 for(const s of students){const n=s.alias.slice(-2);const timing=await ui('new Promise((resolve,reject)=>{const start=performance.now();Array.from(document.querySelectorAll("aside button")).find(x=>x.textContent.includes('+JSON.stringify(s.alias)+')).click();const poll=()=>{if(performance.now()-start>5000)return reject(Error("Switch timeout"));if(document.querySelector("#student-detail-heading")?.textContent==='+JSON.stringify(s.alias)+'&&document.querySelector("#student-section-parent")?.innerText.includes('+JSON.stringify('专属诉求'+n)+'))requestAnimationFrame(()=>resolve(performance.now()-start));else setTimeout(poll,5);};poll();})');evidence.switchTimings.push(timing);}
 evidence.performance={students:20,medianMs:[...evidence.switchTimings].sort((a,b)=>a-b)[10],maxMs:Math.max(...evidence.switchTimings)};assert(evidence.performance.maxMs<1000);
 await choose(a.alias);await profileShot('candidate-final.png');evidence.counts={students:ok(await api('students')).length,concerns:ok(await api('parentFollowUp',a.id)).concerns.length,history:ok(await api('history',a.id)).length,sources:ok(await api('studentIntakeHistory',a.id)).entries.length};
 await close();evidence.completed=true;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({completed:true,navigation:evidence.navigation,cases:evidence.cases,performance:evidence.performance}));
})().catch(e=>{evidence.error=e.stack;fs.writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));console.error(e);if(child)child.kill();process.exitCode=1;});



