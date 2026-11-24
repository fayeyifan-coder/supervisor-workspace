const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { SampleDatabase } = require("../build/database.js");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "SW-测试 数据-"));
  const databasePath = join(root, "data", "workspace.sqlite3");
  const marker = join(root, "database.initialized");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, databasePath, marker, open: () => SampleDatabase.open(databasePath, marker) };
}

async function interruptWorker(t, script, args, stage) {
  const child = spawn(process.execPath, [join(__dirname, script), ...args],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  try {
    const [signal] = await Promise.race([
      once(child.stdout, "data", { signal: t.signal }),
      exited.then(() => { throw new Error(`${script} exited before ${stage}: ${errors}`); }),
    ]);
    assert.equal(signal.toString().trim(), stage);
    assert.ok(child.kill("SIGKILL"));
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGKILL");
    await exited.catch(() => {});
  }
}

test("persist a single Chinese test record; update its revision after reopening", (t) => {
  const f = fixture(t);
  let store = f.open();
  try {
    assert.equal(store.details.schemaVersion, 1);
    assert.equal(store.read(), null);
    assert.throws(() => store.save({ content: "仿".repeat(201), expectedRevision: null }), /200/);
    const first = store.save({ content: "虚构记录：第一次保存", expectedRevision: null });
    store.close();
    store = f.open();
    assert.deepEqual(store.read(), first);
    assert.throws(() => store.save({ content: "旧值", expectedRevision: null }), /版本/);
    assert.deepEqual(store.read(), first);
    const second = store.save({ content: "虚构记录：第二次保存", expectedRevision: 1 });
    assert.equal(second.revision, 2);
    assert.equal(second.createdAt, first.createdAt);
    store.close();
    store = f.open();
    assert.deepEqual(store.read(), second);
  } finally {
    store.close();
  }
});

test("reject invalid or missing initialized databases without creating a replacement", (t) => {
  const f = fixture(t);
  f.open().close();
  renameSync(f.databasePath, f.databasePath + ".retained");
  assert.throws(f.open, /文件缺失/);
  assert.equal(existsSync(f.databasePath), false);
  const invalid = Buffer.from("This is not a SQLite file.");
  writeFileSync(f.databasePath, invalid);
  assert.throws(f.open);
  assert.deepEqual(readFileSync(f.databasePath), invalid);
});

test("reject a newer schema or another application's file", (t) => {
  const f = fixture(t);
  f.open().close();
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec("PRAGMA user_version = 99");
    assert.throws(f.open, /版本/);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 99);
    db.exec("PRAGMA user_version = 1; PRAGMA application_id = 1");
    assert.throws(f.open, /应用标识/);
    assert.equal(db.prepare("PRAGMA application_id").get().application_id, 1);
  } finally {
    db.close();
  }
});

test("an abruptly killed writer preserves commit and discards an open transaction", { timeout: 12000 }, async (t) => {
  const f = fixture(t);
  f.open().close();
  await interruptWorker(t, "crash-writer.cjs", [f.databasePath], "committed-and-open");

  const store = f.open();
  try {
    assert.equal(store.read()?.content, "虚构已提交值");
    assert.equal(store.read()?.revision, 1);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM sample_record").get().value, 1);
  } finally {
    db.close();
  }
});

test("an interrupted first initialization preserves the database and requires manual recovery", { timeout: 12000 }, async (t) => {
  const f = fixture(t);
  assert.equal(existsSync(f.databasePath), false);
  await interruptWorker(t, "interrupt-initialization.cjs", [f.databasePath, f.marker], "migration-open");

  const interruptedBytes = readFileSync(f.databasePath);
  assert.ok(interruptedBytes.length > 0);
  assert.equal(existsSync(f.marker), false);
  assert.throws(f.open, /数据库应用标识不匹配/);
  assert.deepEqual(readFileSync(f.databasePath), interruptedBytes);
  assert.equal(existsSync(f.marker), false);

  // Preserve the entire data directory, including any remaining SQLite sidecars.
  const retained = join(f.root, "data.retained");
  renameSync(dirname(f.databasePath), retained);
  const store = f.open();
  try {
    assert.equal(store.details.schemaVersion, 1);
    assert.equal(existsSync(f.marker), true);
    assert.equal(store.read(), null);
    const saved = store.save({ content: "虚构初始化恢复记录", expectedRevision: null });
    assert.deepEqual(store.read(), saved);
  } finally {
    store.close();
  }
  assert.deepEqual(readFileSync(join(retained, "workspace.sqlite3")), interruptedBytes);
});
