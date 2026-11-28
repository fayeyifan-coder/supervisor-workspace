const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { ProfileWriteGate } = require("../build/profile-write-gate.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("protection excludes late writes and pending switches stay locked after protection releases", async () => {
  let switching = false;
  const gate = new ProfileWriteGate(() => switching);
  const dialog = deferred();
  const protectedAction = gate.protect(async () => {
    await dialog.promise;
    switching = true;
  });
  await assert.rejects(gate.write(() => assert.fail("late write executed")), { code: "busy" });
  dialog.resolve();
  await protectedAction;
  assert.equal(gate.busy, false);
  await assert.rejects(gate.write(() => assert.fail("pending write executed")), { code: "busy" });
  switching = false;
  assert.equal(await gate.write(() => "current profile"), "current profile");
});

test("in-flight asynchronous writes exclude protection and thrown operations release their gate", async () => {
  const gate = new ProfileWriteGate(() => false);
  const readFile = deferred();
  const write = gate.write(() => readFile.promise);
  await assert.rejects(gate.protect(() => assert.fail("switch ran during an asynchronous write")), { code: "busy" });
  readFile.resolve();
  await write;
  await assert.rejects(gate.protect(async () => { throw Error("cancelled"); }), /cancelled/);
  assert.equal(await gate.write(() => 1), 1);
});

test("business IPC writes and mutable import previews all use the shared writer registration", () => {
  const main = readFileSync(join(__dirname, "../src/main.ts"), "utf8");
  const registered = [...main.matchAll(/handleWrite\(channels\.(\w+),/g)].map(result => result[1]);
  const writes = ["createStudent", "addLesson", "saveStudentEdit", "finishStudentEdit", "createParentConcern",
    "appendParentFollowUp", "saveStudentRecord", "saveStudentLifecycle", "changeCycleSchedule", "resolveStudentWrite", "saveSchedulePlan", "applyLearningChange",
    "acknowledgeOperation", "saveWorkItem", "setWorkItemStatus", "saveGrowthProfile", "pickStudentIntake",
    "prepareStudentIntake", "saveStudentIntake", "pickStudyPlans", "saveStudyPlan",
    "createManualPlan", "savePlanVersion", "linkPlanTask", "addQuickLesson"];
  assert.deepEqual(registered.sort(), writes.sort());
  for (const write of writes) assert(!main.includes("ipcMain.handle(channels." + write + ","));
});
