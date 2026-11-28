const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const [input, mode = "candidate", workspaceArg] = process.argv.slice(2);
const exe = realpathSync.native(resolve(input));
const development = mode === "development";
assert.equal(process.platform, "win32");
assert.equal(basename(exe), development ? "electron.exe" : "SupervisorWorkspace-MVP.exe");
assert(!/^D:\\(?:SupervisorWorkspace|Codex-Development\\Builds\\sw-production-admission-)/i.test(exe));
const workspace = development ? realpathSync.native(resolve(workspaceArg)) : undefined;
const profileName = "sw-services-v6-maintenance-" + randomUUID().replaceAll("-", "");
const syntheticRoot = "D:\\Codex-Development\\Temp";
const owner = join(syntheticRoot, "sw-student-services-profiles", profileName);
assert(!existsSync(owner));
mkdirSync(syntheticRoot, { recursive: true });
assert.equal(realpathSync.native(syntheticRoot), syntheticRoot);
const temp = mkdtempSync(join(realpathSync.native(tmpdir()), "sw-maintenance-smoke-"));
const E = "process.mainModule.require('electron')";
const W = E + ".BrowserWindow.getAllWindows()[0]";
const student = alias => ({ id: randomUUID(), alias, grade: "测试", subjects: "数学", goal: "", notes: "" });

async function waitFor(read, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let cause;
  do {
    try { const value = await read(); if (value) return value; } catch (error) { cause = error; }
    await delay(120);
  } while (Date.now() < end);
  throw Error(description, { cause });
}

let child;
async function launch() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, M2C_SYNTHETIC_TEST: development ? "1" : "0",
    M2C_SYNTHETIC_PACKAGED: development ? "0" : "1", M2C_SYNTHETIC_PROFILE: profileName, M2B_SYNTHETIC_TEST: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, ["--inspect=127.0.0.1:" + port, ...(workspace ? [workspace] : [])], {
    cwd: temp, env, windowsHide: true, stdio: ["ignore", "ignore", "inherit"],
  });
  const exit = once(child, "exit");
  const endpoint = await waitFor(async () => (await (await fetch("http://127.0.0.1:" + port + "/json/list")).json())[0]?.webSocketDebuggerUrl, "Missing local Electron inspector");
  const ws = new WebSocket(endpoint);
  await once(ws, "open");
  let sequence = 0;
  const main = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const handle = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handle);
      if (message.error || message.result.exceptionDetails) reject(Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    };
    const timer = setTimeout(() => { ws.removeEventListener("message", handle); reject(Error("Electron evaluation timed out")); }, 15000);
    ws.addEventListener("message", handle);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const ui = code => main(W + ".webContents.executeJavaScript(" + JSON.stringify(code) + ")");
  const invoke = (method, ...args) => ui("window.supervisorWorkspace[" + JSON.stringify(method) + "](..." + JSON.stringify(args) + ")");
  await waitFor(() => ui("Boolean(window.supervisorWorkspace && document.querySelector('#schedule-title'))"), "Default timetable did not load");
  const runtime = await main("({profile:" + E + ".app.getPath('userData'),electron:process.versions.electron,node:process.versions.node,arch:process.arch,packaged:" + E + ".app.isPackaged})");
  assert.equal(runtime.profile, join(owner, "profile", "chromium"));
  assert.equal(runtime.arch, "x64");
  assert.equal(runtime.electron, require("../package-lock.json").packages["node_modules/electron"].version);
  assert.equal(runtime.node, "24.22.2");
  assert.equal(runtime.packaged, !development);
  const dialogs = (path, response = 1) => main(E + ".dialog.showOpenDialog=async()=>({canceled:false,filePaths:[" + JSON.stringify(path) + "]});" +
    E + ".dialog.showMessageBox=async()=>({response:" + response + "});true");
  const finish = async () => {
    ws.close();
    const [code, signal] = await Promise.race([exit, delay(12000, null, { ref: false }).then(() => { throw Error("Electron did not close"); })]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    child = undefined;
  };
  const close = async () => { await main("setTimeout(()=>" + W + ".close(),250);true"); await finish(); };
  const interrupt = async () => {
    ws.close();
    assert(child.kill());
    await exit;
    child = undefined;
  };
  return { main, ui, invoke, dialogs, close, finish, interrupt, runtime };
}
const ok = reply => { assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.value; };

const writeMethods = ["createStudent", "addLesson", "saveStudentEdit", "finishStudentEdit", "createParentConcern",
  "appendParentFollowUp", "saveStudentRecord", "saveStudentLifecycle", "changeCycleSchedule", "resolveStudentWrite", "saveSchedulePlan", "applyLearningChange",
  "acknowledgeOperation", "saveWorkItem", "setWorkItemStatus", "saveGrowthProfile", "pickStudentIntake",
  "prepareStudentIntake", "saveStudentIntake", "pickStudyPlans", "saveStudyPlan",
  "createManualPlan", "savePlanVersion", "linkPlanTask", "addQuickLesson", "saveQuickLearningDraft", "saveLearningTracking", "saveWeeklyReview"];

async function rejectWrites(app) {
  for (const method of writeMethods) {
    const reply = await app.invoke(method, {});
    assert.equal(reply.code, "busy", method + " " + JSON.stringify(reply));
  }
}

async function pauseQuit(app) {
  await app.main(E + ".app.prependOnceListener('before-quit',e=>e.preventDefault());" +
    E + ".dialog.showErrorBox=(_,message)=>globalThis.switchError=message;true");
}

async function verifySwitch(app, copy, original, savedAt) {
  const chosen = join(copy.location, "restore.ready");
  await app.dialogs(chosen, 0);
  assert.equal(ok(await app.invoke("activateRecovery")), false);
  assert.equal(ok(await app.invoke("activationStatus")).pending, false);
  await app.ui("Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.trim()==='学生档案').click()");
  await waitFor(() => app.ui("Boolean(document.querySelector('#worklog-heading'))"), "Work log not rendered");
  const title = "document.querySelector('#worklog-heading').closest('section').querySelector('input[name=title]')";
  await app.ui(title + ".value='Synthetic unsaved input'");
  await app.dialogs(chosen);
  assert.equal((await app.invoke("activateRecovery")).code, "busy");
  assert.equal(await app.ui(title + ".value"), "Synthetic unsaved input");
  await app.ui(title + ".value=" + title + ".defaultValue");
  const guard = join(owner, "profile", "operations-request.guard");
  writeFileSync(guard, "operations-journal-v1\n", { flag: "wx" });
  assert.equal((await app.invoke("activateRecovery")).code, "recovery");
  unlinkSync(guard);

  // Keep a file picker in flight while the switch arrives.
  await app.main(E + ".dialog.showOpenDialog=()=>new Promise(r=>globalThis.finishPicker=r);true");
  const picking = app.invoke("pickStudentIntake");
  await waitFor(() => app.main("Boolean(globalThis.finishPicker)"), "Import file dialog did not start");
  assert.equal((await app.invoke("activateRecovery")).code, "busy");
  await app.main("globalThis.finishPicker({canceled:true,filePaths:[]});true");
  assert.deepEqual(ok(await picking), []);

  // Pin the final confirmation, attempt every write while protection holds,
  // then block normal quit so the pending-state admission can also be tested.
  await app.dialogs(chosen);
  await app.main(E + ".dialog.showMessageBox=()=>new Promise(r=>globalThis.answerSwitch=r);true");
  await pauseQuit(app);
  const switching = app.invoke("activateRecovery");
  await waitFor(() => app.main("Boolean(globalThis.answerSwitch)"), "Switch confirmation did not open");
  await rejectWrites(app);
  await app.main("globalThis.answerSwitch({response:1});true");
  assert.equal(ok(await switching), true);
  assert.equal(ok(await app.invoke("activationStatus")).pending, true);
  assert.equal((await app.invoke("createStudent", student("Rejected pending write"))).code, "busy");
  await waitFor(() => app.main("globalThis.switchError?.includes('未能正常退出')"), "No failed-quit diagnostic");
  assert.equal(ok(await app.invoke("activationStatus")).pending, false);
  assert.equal(await app.ui("document.body.inert"), false);

  // Interrupt another confirmed attempt before will-quit. The original stays selected.
  await app.dialogs(chosen);
  await pauseQuit(app);
  assert.equal(ok(await app.invoke("activateRecovery")), true);
  assert.equal(ok(await app.invoke("activationStatus")).pending, true);
  await app.interrupt();
  app = await launch();
  assert.equal(ok(await app.invoke("activationStatus")).active, null);
  assert.deepEqual(ok(await app.invoke("students")).map(p => p.id), [original.id]);

  const selection = join(owner, "profile-selection-v1.json");
  const quitError = join(temp, "quit-error.txt");
  await app.dialogs(chosen);
  await app.main(E + ".app.once('before-quit',()=>process.mainModule.require('node:fs').writeFileSync(" +
    JSON.stringify(selection) + ",'invalid',{flag:'wx'}));" +
    E + ".dialog.showErrorBox=(_,message)=>process.mainModule.require('node:fs').writeFileSync(" +
    JSON.stringify(quitError) + ",message);true");
  await app.ui("void window.supervisorWorkspace.activateRecovery()");
  await app.finish();
  assert.match(readFileSync(quitError, "utf8"), /无法安排档案切换/);
  assert.equal(readFileSync(selection, "utf8"), "invalid");
  unlinkSync(selection); // Remove only the synthetic fault injected by this test.
  app = await launch();
  assert.equal(ok(await app.invoke("activationStatus")).active, null);

  await app.dialogs(chosen);
  await app.ui("void window.supervisorWorkspace.activateRecovery()");
  await app.finish();
  app = await launch();
  const active = ok(await app.invoke("activationStatus"));
  assert(active.active);
  assert.equal(active.lastSuccessfulBackupAt, null);
  assert.deepEqual(ok(await app.invoke("students")).map(p => p.id), [original.id]);
  await app.dialogs(temp, 0);
  assert.equal(ok(await app.invoke("returnOriginalProfile")), false);
  await app.dialogs(temp);
  await app.ui("void window.supervisorWorkspace.returnOriginalProfile()");
  await app.finish();
  app = await launch();
  const originalState = ok(await app.invoke("activationStatus"));
  assert.equal(originalState.active, null);
  assert.equal(originalState.lastSuccessfulBackupAt, savedAt);
  assert.deepEqual(ok(await app.invoke("students")).map(p => p.id), [original.id]);
  return app;
}

async function main() {
  let app = await launch();
  const { runtime } = app;
  const original = student("Synthetic maintenance sample");
  ok(await app.invoke("createStudent", original));
  await app.close();
  app = await launch();
  assert.deepEqual(ok(await app.invoke("students")).map(p => p.id), [original.id]);
  if (mode !== "baseline") {
    assert.deepEqual(ok(await app.invoke("workspaceInfo")), { mode: "synthetic", backupFormat: 2 });
    assert.equal(ok(await app.invoke("activationStatus")).lastSuccessfulBackupAt, null);
  }
  await app.dialogs(temp);
  const backup = ok(await app.invoke("exportProtection"));
  assert.equal(backup.formatVersion, 2);
  assert.equal(backup.students, 1);
  await app.dialogs(backup.location);
  const copy = ok(await app.invoke("restoreProtection"));
  assert.equal(copy.students, 1);
  if (mode === "baseline") {
    await app.dialogs(join(copy.location, "restore.ready"));
    assert.equal(ok(await app.invoke("activateRecovery")), true);
    assert.equal(ok(await app.invoke("activationStatus")).pending, true);
    const late = student("Synthetic write after selection");
    assert.equal(ok(await app.invoke("createStudent", late)).id, late.id);
    console.log(JSON.stringify({ regressionReproduced: true, lateStudentWriteAccepted: true, runtime }));
    await app.close();
    return;
  }
  const savedAt = ok(await app.invoke("activationStatus")).lastSuccessfulBackupAt;
  assert.equal(typeof savedAt, "string");
  assert(Number.isFinite(Date.parse(savedAt)));
  await app.main(E + ".dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});true");
  assert.equal(ok(await app.invoke("exportProtection")), null);
  await app.dialogs(owner);
  assert.equal((await app.invoke("exportProtection")).code, "invalid");
  assert.equal(ok(await app.invoke("activationStatus")).lastSuccessfulBackupAt, savedAt);
  const { validateProtection } = require("../build/offline-protection.js");
  assert.equal(validateProtection(readFileSync(backup.location)).summary.students, 1);
  app = await verifySwitch(app, copy, original, savedAt);
  await app.close();
  const old = new Date(Date.now() - 4 * 86400000);
  const { recordSuccessfulBackup } = require("../build/backup-status.js");
  recordSuccessfulBackup(join(owner, "profile"), old); // Simulate four days passing in this fixture.
  app = await launch();
  assert(await waitFor(() => app.ui("document.querySelector('#protection-title')?.closest('section').textContent.includes('已超过 3 天未备份')"),
    "Overdue backup reminder is missing."));
  await app.close();
  const diagnostics = readFileSync(join(owner, "profile", "logs", "diagnostics.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line));
  assert(diagnostics.some(row => row.channel === "m2d:export" && row.category === "invalid"));
  for (const row of diagnostics) {
    assert(Object.keys(row).every(field => ["time", "version", "channel", "category", "sqliteCode"].includes(field)));
  }
  console.log(JSON.stringify({ runtime, persisted: true, format: backup.formatVersion, restored: true,
    switchCancelled: true, draftsPreserved: true, lateWritesRejected: writeMethods.length,
    pendingAndInFlightRejected: true, failedQuitRecovered: true, commitFailureReported: true,
    interruptedBeforeQuit: true, roundTrip: true, backupStatusIsolated: true, backupReminder: true,
    diagnosticsSanitized: true }));
}
main().catch(error => {
  console.error(error);
  if (child) child.kill(); // Only the isolated fixture process created by this script.
  process.exitCode = 1;
});
