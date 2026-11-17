const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { isAbsolute, join, relative, sep } = require("node:path");
const { createInterface } = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");

function testTempRoot() {
  assert.equal(process.platform, "win32");
  const hostedWindows = process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_OS === "Windows";
  const expected = hostedWindows ? process.env.RUNNER_TEMP : "D:\\Codex-Development\\Temp\\supervisor-workspace-mvp\\runtime";
  assert.match(expected ?? "", /^[A-Za-z]:\\/, "An approved local Windows temp root is required");
  const allowed = realpathSync.native(expected);
  assert.equal(relative(expected, allowed), "", "The temp root must not redirect");
  for (const [name, value] of Object.entries({
    TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, "os.tmpdir()": tmpdir(),
  })) {
    assert(value && isAbsolute(value) && relative(allowed, value) === "", name + " must point to the approved temp root");
  }
  return allowed;
}

function assertFixtureDirectory(allowed, path) {
  const actual = realpathSync.native(path);
  const child = relative(allowed, actual);
  assert(child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child),
    "The test directory must be inside the approved temp root");
  assert.equal(relative(path, actual), "", "The test directory must not redirect");
  assert(lstatSync(path).isDirectory(), "Expected a directory for the synthetic database");
}

function fixture(t) {
  const allowed = testTempRoot();
  const root = mkdtempSync(join(allowed, "MVP-合成测试-"));
  assertFixtureDirectory(allowed, root);
  const path = join(root, "mvp.sqlite3");
  const marker = join(root, "mvp.initialized");
  let store;
  t.after(() => {
    store?.close();
    assertFixtureDirectory(allowed, root);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    path, marker,
    open() { store = WorkspaceDatabase.open(path, marker); return store; },
    close() { store?.close(); store = undefined; },
  };
}

function student(alias = "虚构学员·小岚") {
  return { id: randomUUID(), alias, grade: "七年级", subjects: "数学、语文", goal: "练习分数运算", notes: "" };
}

function lesson(studentId, date = "2026-11-16") {
  return { id: randomUUID(), studentId, date, subject: "数学", task: "分数练习",
    completion: "完成两道练习并订正", assessment: "能解释通分步骤", nextStep: "复习异分母加法" };
}

async function interrupt(t, script, args, stage) {
  const child = spawn(process.execPath, [join(__dirname, script), ...args], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const output = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", text => { errors += text; });
  const exited = once(child, "exit");
  try {
    const [line] = await Promise.race([
      once(output, "line", { signal: t.signal }),
      exited.then(() => { throw new Error("Child exited before " + stage + ": " + errors); }),
    ]);
    assert.equal(line, stage);
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGKILL");
    await exited.catch(() => {});
  }
}

test("save student and learning facts, close and reopen with independent student history", t => {
  const f = fixture(t);
  const draft = student();
  let store = f.open();
  assert.deepEqual(store.students(), []);
  const persisted = store.createStudent(draft);
  const other = store.createStudent(student("虚构学员·小川"));
  const first = store.addLesson(lesson(draft.id));
  const second = store.addLesson(lesson(draft.id, "2026-11-17"));
  f.close();
  store = f.open();
  assert.deepEqual(store.students().find(item => item.id === draft.id), persisted);
  assert.deepEqual(store.history(draft.id), [second, first]);
  assert.deepEqual(store.history(other.id), []);
});

test("a replay after reopening returns the same persisted receipt and conflicting payloads fail", t => {
  const f = fixture(t);
  const draft = student();
  const record = lesson(draft.id);
  let store = f.open();
  const savedStudent = store.createStudent(draft);
  const savedLesson = store.addLesson(record);
  f.close();
  store = f.open();
  assert.deepEqual(store.createStudent(draft), savedStudent);
  assert.deepEqual(store.addLesson(record), savedLesson);
  assert.throws(() => store.createStudent({ ...draft, alias: "虚构代号变更" }), { code: "conflict" });
  assert.throws(() => store.addLesson({ ...record, completion: "虚构变更" }), { code: "conflict" });
  assert.deepEqual(store.history(draft.id), [savedLesson]);
});

test("reject invalid or orphaned input without writing rows", t => {
  const f = fixture(t);
  const store = f.open();
  const draft = student();
  assert.throws(() => store.createStudent({ ...draft, alias: " " }), { code: "invalid" });
  assert.throws(() => store.addLesson(lesson(draft.id)), { code: "invalid" });
  assert.deepEqual(store.students(), []);
  store.createStudent(draft);
  assert.throws(() => store.addLesson(lesson(draft.id, "2026-02-31")), { code: "invalid" });
  assert.throws(() => store.addLesson({ ...lesson(draft.id), task: "仿".repeat(501) }), { code: "invalid" });
  assert.deepEqual(store.history(draft.id), []);
});

test("reject a synthetic legacy database before touching its main file or sidecars", t => {
  const f = fixture(t);
  const foreign = new DatabaseSync(f.path);
  try { foreign.exec("PRAGMA application_id = 1398231089; PRAGMA user_version = 1; CREATE TABLE sample_record (id INTEGER PRIMARY KEY)"); }
  finally { foreign.close(); }
  const original = readFileSync(f.path);
  assert.throws(() => f.open(), { code: "recovery" });
  assert.deepEqual(readFileSync(f.path), original);
  assert.equal(existsSync(f.marker), false);
  assert.equal(existsSync(f.path + "-wal"), false);
  assert.equal(existsSync(f.path + "-shm"), false);
});

test("an exception after COMMIT yields unknown and can be resolved by retrying the same ID", t => {
  const f = fixture(t);
  const store = f.open();
  const draft = student();
  const execute = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const value = execute.call(this, sql);
    if (sql === "COMMIT") throw new Error("synthetic lost commit response");
    return value;
  };
  try { assert.throws(() => store.createStudent(draft), { code: "unknown" }); }
  finally { DatabaseSync.prototype.exec = execute; }
  const receipt = store.createStudent(draft);
  assert.deepEqual(store.students(), [receipt]);
});

test("abruptly killed writer preserves the committed WAL lesson and discards an uncommitted one", { timeout: 12000 }, async t => {
  const f = fixture(t);
  const draft = student();
  f.open().createStudent(draft);
  f.close();
  const saved = lesson(draft.id);
  await interrupt(t, "crash-writer.cjs", [f.path, f.marker, JSON.stringify(saved), randomUUID()], "committed-and-open");
  const history = f.open().history(draft.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, saved.id);
  assert.equal(history[0].completion, saved.completion);
});

test("interrupted first initialization preserves the incomplete file for recovery", { timeout: 12000 }, async t => {
  const f = fixture(t);
  await interrupt(t, "interrupt-initialization.cjs", [f.path, f.marker], "initialization-open");
  const original = readFileSync(f.path);
  assert.equal(existsSync(f.marker), false);
  assert.throws(() => f.open(), { code: "recovery" });
  assert.deepEqual(readFileSync(f.path), original);
});
