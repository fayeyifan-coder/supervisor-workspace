const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { WorkLogDatabase } = require("../build/worklog.js");
const { GrowthProfileDatabase } = require("../build/growth-profile.js");
const { IntakeStore, StudentIntakeService } = require("../build/student-intake.js");
const { captureProtection, prepareProtectionRestore, validateProtection, verifyProtectionStores, ProtectionFiles } = require("../build/offline-protection.js");
const { OperationsDatabase } = require("../build/operations.js");
const { approveActiveProfile, approvedSelection, checkOriginalProtectionMode, originalProfileSegments, readActivation, saveActivation, verifyActiveProfile } = require("../build/profile-activation.js");

const exe = join(__dirname, "..", "build", "recovery-io.exe");
const io = new ProtectionFiles(exe);
const input = [1, 2].map(n => readFileSync(join(__dirname, "fixtures", "synthetic-intake-00" + n + ".json"), "utf8"));
const temp = () => mkdtempSync(join(realpathSync.native(tmpdir()), "sw-m2d-"));
const fakeName = () => "sw-backup-" + randomUUID().replaceAll("-", "");
function openStores(dir, t, m1Version = 1) {
  const specs = [[WorkspaceDatabase, "mvp"], [WorkLogDatabase, "worklog"],
    [GrowthProfileDatabase, "growth"], [IntakeStore, "student-intake"]];
  const stores = specs.map(([type, key]) => type.open(join(dir, key + ".sqlite3"), join(dir, key + ".initialized"),
    ...(key === "mvp" ? [m1Version] : [])));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const store of [...stores].reverse()) store.close();
  };
  t.after(close);
  const [m1, work, growth, intake] = stores;
  return { stores, m1, work, growth, intake, close };
}
function confirm(service, index, target = { kind: "new" }, extraFields = {}) {
  const file = service.register("synthetic", input[index]);
  const plan = service.prepare(file.token, target);
  return { file, plan, result: service.confirm({ token: file.token, target: plan.target, expectedRevision: plan.revision,
    student: file.source.student, fields: { ...plan.proposed, ...extraFields }, reviewed: true, pendingId: plan.pendingId }) };
}
function populated(t) {
  const dir = temp();
  const f = openStores(dir, t);
  const service = new StudentIntakeService(f.intake, f.m1, f.growth);
  const done = confirm(service, 0).result;
  assert.equal(done.state, "saved");
  const studentId = done.studentId;
  const status = f.work.save({ id: randomUUID(), title: "合成作业核对", workDate: "2026-11-18", studentId,
    startedAt: "", notes: "", nextStep: "" }, id => id === studentId);
  f.work.setStatus(status.id, "done");
  const unavailable = new StudentIntakeService(f.intake, f.m1, {
    load: f.growth.load.bind(f.growth),
    save() { throw new Error("synthetic growth write failure"); },
  });
  const pending = confirm(unavailable, 1).result;
  assert.equal(pending.state, "pending");
  assert.equal(pending.studentConfirmed, true);
  const file = unavailable.register("synthetic", input[1]);
  const requestId = unavailable.prepare(file.token).pendingId;
  return { ...f, dir, studentId, itemId: status.id, pending, requestId };
}

test("confirmed recovery can become a separate writable profile, reopen and back up again", async t => {
  const f = populated(t);
  const before = captureProtection(f.stores, "0.1.0");
  const artifact = await io.restore(f.dir, before);
  assert(!existsSync(join(artifact.location, "data")));
  const source = await io.inspect(f.dir, artifact.profileName);
  assert(source.bytes.equals(before));
  const pending = { kind: "restore", name: artifact.profileName, digest: source.digest };
  const previous = readActivation(f.dir);
  saveActivation(f.dir, { ...previous, pending });
  assert.deepEqual(readActivation(f.dir).pending, pending);
  assert.equal(readActivation(f.dir).active, null);
  saveActivation(f.dir, { ...previous, pending: { ...pending, kind: "opening" } });
  assert.equal(readActivation(f.dir).pending.kind, "opening");

  const deployed = await io.restore(f.dir, source.bytes, true);
  const active = { name: deployed.profileName, digest: source.digest };
  const activePath = verifyActiveProfile(f.dir, active, true);
  assert.throws(() => verifyActiveProfile(f.dir, active, false), /缺失/);
  assert.throws(() => approvedSelection(temp(), active.name), /缺失/);
  const first = openStores(join(activePath, "data"), t);
  verifyProtectionStores(first.stores, "0.1.0");
  const id = randomUUID();
  first.m1.createStudent({ id, alias: "恢复后新建虚构学生", grade: "七年级", subjects: "数学", notes: "", goal: "" });
  assert.throws(() => verifyActiveProfile(f.dir, active, true), /侧车/);
  approveActiveProfile(activePath, active.digest);
  saveActivation(f.dir, { ...previous, active });
  assert.doesNotThrow(() => verifyActiveProfile(f.dir, active, false));
  first.close();
  const reopened = openStores(join(verifyActiveProfile(f.dir, readActivation(f.dir).active, false), "data"), t);
  assert(reopened.m1.students().some(student => student.id === id));
  assert(!f.m1.students().some(student => student.id === id));

  const exported = await io.publish(f.dir, captureProtection(reopened.stores, "0.1.0"));
  const second = await io.restore(f.dir, await io.read(exported.location));
  assert.equal((await io.inspect(f.dir, second.profileName)).summary.students, 3);
  assert.equal((await io.inspect(f.dir, artifact.profileName)).summary.students, 2);
  saveActivation(f.dir, { ...previous, pending: { kind: "original" } });
  assert.deepEqual(readActivation(f.dir).pending, { kind: "original" });
  saveActivation(f.dir, previous);
  assert.equal(readActivation(f.dir).active, null);
  const resume = { ...approvedSelection(f.dir, active.name), kind: "resume" };
  saveActivation(f.dir, { ...previous, pending: resume });
  assert.deepEqual(readActivation(f.dir).pending, resume);
  assert.equal(verifyActiveProfile(f.dir, resume, false), activePath);
  assert(reopened.m1.students().some(student => student.id === id));
});

test("activation rejects sidecars, corrupt markers, missing artifacts and modified images", async t => {
  const f = populated(t);
  const bytes = captureProtection(f.stores, "0.1.0");
  for (const [filename, contents] of [["worklog.sqlite3-wal", "foreign"], ["mvp.initialized", "wrong"]]) {
    const artifact = await io.restore(f.dir, bytes);
    writeFileSync(join(artifact.location, "recovery", filename), contents);
    await assert.rejects(io.inspect(f.dir, artifact.profileName), /无法确认/);
    assert.equal(readFileSync(join(artifact.location, "recovery", filename), "utf8"), contents);
  }
  const artifact = await io.restore(f.dir, bytes);
  const modified = join(artifact.location, "recovery", "growth.sqlite3");
  const image = readFileSync(modified);
  image[image.length - 1] ^= 1;
  writeFileSync(modified, image);
  await assert.rejects(io.inspect(f.dir, artifact.profileName), /摘要/);
  renameSync(join(artifact.location, "restore.ready"), join(artifact.location, "restore.old"));
  await assert.rejects(io.inspect(f.dir, artifact.profileName), /无法确认/);
  assert.equal(readActivation(f.dir).active, null);
  assert.equal(f.m1.students().length, 2);
});

test("missing or corrupt activated profile metadata fails closed", async t => {
  const f = populated(t);
  const original = readActivation(f.dir);
  saveActivation(f.dir, original);
  const path = join(f.dir, "profile-selection-v1.json");
  writeFileSync(path, "invalid");
  assert.throws(() => readActivation(f.dir), /损坏/);
  renameSync(path, path + ".kept");
  assert.throws(() => readActivation(f.dir), /缺失/);
  assert.equal(f.m1.students().length, 2);
});

test("interruption during initial selection registration can still open the original", t => {
  const f = populated(t);
  const original = readActivation(f.dir);
  writeFileSync(join(f.dir, "profile-selection-v1.json"), JSON.stringify(original));
  assert.deepEqual(readActivation(f.dir), original);
  saveActivation(f.dir, { ...original, pending: { kind: "original" } });
  assert.deepEqual(readActivation(f.dir).pending, { kind: "original" });
});

test("four committed WAL images verify, restore, reopen and preserve repeat and pending import identity", async t => {
  const f = populated(t);
  assert(existsSync(join(f.dir, "mvp.sqlite3-wal")));
  const snapshot = captureProtection(f.stores, "0.1.0");
  const initial = validateProtection(snapshot).summary;
  assert.deepEqual([initial.students, initial.workItems, initial.growthProfiles, initial.intakeBindings, initial.unfinishedImports],
    [2, 1, 1, 2, 1]);
  const saved = await io.publish(f.dir, snapshot);
  const bytes = await io.read(saved.location);
  assert(bytes.equals(snapshot));
  const clean = await io.restore(f.dir, bytes);
  assert(existsSync(join(clean.location, "restore.ready")));
  const data = join(clean.location, "recovery");
  for (const suffix of ["-wal", "-shm"]) assert(!existsSync(join(data, "mvp.sqlite3" + suffix)));

  const first = openStores(data, t);
  assert.equal(first.work.history(f.itemId).length, 2);
  assert.equal(first.growth.load(f.studentId).history.length, 1);
  first.close();

  const reopened = openStores(data, t);
  assert.equal(reopened.m1.students().find(s => s.id === f.studentId).alias, "DEMO-001");
  const svc = new StudentIntakeService(reopened.intake, reopened.m1, reopened.growth);
  const duplicate = svc.register("same", input[0]);
  assert.equal(svc.prepare(duplicate.token).state, "done");
  assert.equal(reopened.m1.students().length, 2);
  const retry = svc.register("pending", input[1]);
  const plan = svc.prepare(retry.token);
  assert.equal(plan.state, "pending");
  assert.equal(plan.pendingId, f.requestId);
  const resumed = confirm(svc, 1, plan.target).result;
  assert.equal(resumed.studentId, f.pending.studentId);
  assert.equal(resumed.state, "saved");
  assert.equal(reopened.m1.students().length, 2);
  assert.equal(reopened.growth.load(resumed.studentId).history[0].requestId, f.requestId);
});

test("later backup captures committed edits and keeps earlier image and backup unchanged", async t => {
  const f = populated(t);
  const before = captureProtection(f.stores, "0.1.0");
  const saved = await io.publish(f.dir, before);
  const now = f.growth.load(f.studentId);
  f.growth.save({ ...now, requestId: randomUUID(), expectedRevision: 1, currentSituation: "合成手动更新" }, id => id === f.studentId);
  const after = captureProtection(f.stores, "0.1.0");
  assert.notDeepEqual(after, before);
  assert((await io.read(saved.location)).equals(before));
  const p = await io.restore(f.dir, after);
  const restored = openStores(join(p.location, "recovery"), t);
  assert.equal(restored.growth.load(f.studentId).currentSituation, "合成手动更新");
  assert.equal(restored.growth.load(f.studentId).history.length, 2);
});

function rehash(bytes) {
  const out = Buffer.from(bytes);
  createHash("sha256").update(out.subarray(0, -32)).digest().copy(out, out.length - 32);
  return out;
}
test("truncation, tampering, missing databases and an invalid schema are rejected", async t => {
  const f = populated(t);
  const good = captureProtection(f.stores, "0.1.0");
  assert.throws(() => validateProtection(good.subarray(0, -12)), /不完整|SHA-256/);
  const damaged = Buffer.from(good);
  damaged[damaged.length - 33] ^= 1;
  assert.throws(() => validateProtection(damaged), /SHA-256/);
  assert.throws(() => validateProtection(rehash(damaged)), /SHA-256/);
  const missing = Buffer.from(good);
  const start = missing.indexOf(Buffer.from("growth.sqlite3"));
  missing.write("absent.sqlite3", start);
  assert.throws(() => validateProtection(rehash(missing)), /清单身份/);
  assert.throws(() => captureProtection(f.stores.slice(0, 3), "0.1.0"), /清单/);
  const db = f.m1.protectionConnection();
  db.exec("CREATE TABLE fake_data(x)");
  assert.throws(() => captureProtection(f.stores, "0.1.0"), /Schema/);
  const missingPath = join(f.dir, "missing.swbackup");
  await assert.rejects(io.read(missingPath), /无法确认/);
});

test("busy and uncommitted writers fail closed; cross-database orphan prevents export", async t => {
  const f = populated(t);
  const other = new DatabaseSync(join(f.dir, "growth.sqlite3"));
  try {
    other.exec("BEGIN IMMEDIATE");
    other.prepare("UPDATE growth_profiles SET current_situation='外部未提交'").run();
    assert.throws(() => captureProtection(f.stores, "0.1.0"), error => ((error.errcode ?? 0) & 255) === 5);
    other.exec("ROLLBACK");
  } finally { other.close(); }
  validateProtection(captureProtection(f.stores, "0.1.0"));
  const db = f.work.protectionConnection();
  db.prepare("UPDATE work_items SET student_id=?").run(randomUUID());
  const orphan = captureProtection(f.stores, "0.1.0");
  await assert.rejects(io.publish(f.dir, orphan), /找不到 M1 学生/);
});

test("native I/O refuses an existing output, a linked backup, and reparse directories", async t => {
  const f = populated(t);
  const bytes = captureProtection(f.stores, "0.1.0");
  const child = fakeName();
  const output = join(f.dir, child);
  mkdirSync(output);
  const target = join(f.dir, "sentinel.sqlite");
  writeFileSync(target, "preserve other database");
  writeFileSync(target + "-wal", "preserve sidecar");
  const backup = join(output, "workspace.swbackup");
  linkSync(target, backup);
  assert.notEqual(spawnSync(exe, ["publish", f.dir, child, String(bytes.length)], { input: bytes }).status, 0);
  await assert.rejects(io.read(backup), /无法确认/);
  assert.equal(readFileSync(target, "utf8"), "preserve other database");
  assert.equal(readFileSync(target + "-wal", "utf8"), "preserve sidecar");

  const junction = join(f.dir, "junction");
  const outside = temp();
  symlinkSync(outside, junction, "junction");
  await assert.rejects(io.publish(junction, bytes), /无法确认/);
  await assert.rejects(io.restore(junction, bytes), /无法确认/);
  const good = await io.publish(outside, bytes);
  await assert.rejects(io.read(join(junction, good.location.split("\\").at(-2), "workspace.swbackup")), /无法确认/);
});

test("active destination identity is pinned and interruption leaves an incomplete package", async t => {
  const f = populated(t);
  const bytes = captureProtection(f.stores, "0.1.0");
  const parent = join(f.dir, "target");
  mkdirSync(parent);
  const name = fakeName();
  const file = join(parent, name, "workspace.swbackup");
  const child = spawn(exe, ["publish", parent, name, String(bytes.length)], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.on("error", () => {});
  child.stdin.write(bytes.subarray(0, 100));
  for (let i = 0; i < 200 && !existsSync(file); i++) await delay(10);
  assert(existsSync(file), "native output was never acquired");
  assert.throws(() => renameSync(parent, join(f.dir, "different")), /EPERM|EBUSY|EACCES/);
  assert.throws(() => linkSync(file, join(f.dir, "unexpected-link")), /EPERM|EBUSY|EACCES/);
  const closed = once(child, "close");
  child.kill();
  await closed;
  const partial = readFileSync(file);
  assert.throws(() => validateProtection(partial), /不完整|长度|SHA-256/);

  const restore = "sw-m2d-restore-" + randomUUID().replaceAll("-", "");
  assert.notEqual(spawnSync(exe, ["restore", f.dir, restore], { input: Buffer.from([0, 4, 0, 0, 1]) }).status, 0);
  assert(!existsSync(join(f.dir, restore, "profile", "restore.ready")));
});

test("restore consumes the verified byte snapshot after the source path points elsewhere", async t => {
  const f = populated(t);
  const first = await io.publish(f.dir, captureProtection(f.stores, "0.1.0"));
  const original = await io.read(first.location);
  const before = validateProtection(original).summary;
  const another = f.m1.createStudent({ id: randomUUID(), alias: "另一名虚构学生", grade: "七年级",
    subjects: "数学", notes: "", goal: "" });
  const later = await io.publish(f.dir, captureProtection(f.stores, "0.1.0"));
  const replacement = await io.read(later.location);
  renameSync(first.location, first.location + ".kept");
  writeFileSync(first.location, replacement, { flag: "wx" });
  assert.equal(validateProtection(await io.read(first.location)).summary.students, before.students + 1);
  const recovered = await io.restore(f.dir, original);
  const stores = openStores(join(recovered.location, "recovery"), t);
  assert.equal(stores.m1.students().length, before.students);
  assert(!stores.m1.students().some(student => student.id === another.id));
});

test("restoration record binds genuine package manifests and native file identities, without authorizing startup", async t => {
  const { requireSupportedProfileOpen } = require("../build/offline-protection.js");
  const f = populated(t);
  const bytes = captureProtection(f.stores, "0.1.0");
  const validate = validateProtection(bytes);
  const recordFor = async () => {
    const recovered = await io.restore(f.dir, bytes);
    const record = JSON.parse(readFileSync(join(recovered.location, "restore.ready"), "utf8"));
    assert.equal(record.format, "sw-recovery-evidence-v1");
    assert.equal(record.profileName, recovered.profileName);
    assert.deepEqual(Object.keys(record.directoryIds).sort(), ["container", "data", "parent", "profile"]);
    assert.deepEqual(Object.keys(record.verifiedFiles).sort(), validate.manifest.databases
      .flatMap(entry => [entry.file, entry.initialization.file]).sort());
    for (const id of [...Object.values(record.verifiedFiles), ...Object.values(record.directoryIds)]) {
      assert.match(id, /^[0-9a-f]{8}:[0-9a-f]{16}$/);
    }
    const evidence = JSON.parse(Buffer.from(record.packageEvidenceBase64, "base64").toString("utf8"));
    assert.equal(evidence.packageSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(evidence.manifest, validate.manifest);
    const before = readFileSync(join(recovered.location, "restore.ready"));
    assert.throws(() => requireSupportedProfileOpen(recovered.profileName), error => error.code === "recovery");
    assert.throws(() => requireSupportedProfileOpen(recovered.profileName.toUpperCase()), error => error.code === "recovery");
    assert.deepEqual(readFileSync(join(recovered.location, "restore.ready")), before);
    return record;
  };
  const first = await recordFor();
  const second = await recordFor();
  assert.notEqual(first.directoryIds.data, second.directoryIds.data);
  assert.notEqual(first.verifiedFiles["mvp.sqlite3"], second.verifiedFiles["mvp.sqlite3"]);
  assert.equal(first.packageEvidenceBase64, second.packageEvidenceBase64);
  assert.throws(() => requireSupportedProfileOpen("synthetic-renamed", true), error => error.code === "recovery");
  assert.doesNotThrow(() => requireSupportedProfileOpen("synthetic-existing"));
});

function fiveFixture(t) {
  const f = populated(t);
  const ops = OperationsDatabase.open(f.dir, f.m1, true);
  t.after(() => ops.close());
  const stores = [...f.stores, ops];
  const studentId = f.studentId;
  const startAt = Date.UTC(2099, 5, 6, 8);
  const plan = { studentId, id: randomUUID(), requestId: randomUUID(), expectedRevision: 0,
    startAt, exception: { confirmed: true, reason: "合成时段" } };
  const create = () => ops.saveAttendancePlan(plan);
  return { ...f, ops, stores, plan, create };
}

test("SWBACK2 reads committed operations from pinned WAL and restores the five-store lifecycle", async t => {
  const f = fiveFixture(t);
  const reader = new DatabaseSync(join(f.dir, "operations.sqlite3"), { readOnly: true });
  reader.exec("BEGIN");
  assert.equal(reader.prepare("SELECT count(*) AS n FROM attendance_plans").get().n, 0);
  const planned = f.create();
  let bytes;
  try {
    assert(readFileSync(join(f.dir, "operations.sqlite3-wal")).length > 32);
    assert.equal(f.ops.protectionConnection().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 1);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM attendance_plans").get().n, 0);
    const block = f.ops.saveLearningBlock({ studentId: planned.studentId, id: randomUUID(), requestId: randomUUID(),
      expectedRevision: 0, attendancePlanId: planned.id, plannedStart: planned.startAt, plannedEnd: planned.endAt });
    f.ops.saveLearningTasks({ studentId: block.studentId, id: block.id, expectedRevision: 1,
      requestId: randomUUID(), tasks: [{ id: randomUUID(), category: "foundation", content: "合成作业" }] });
    bytes = captureProtection(f.stores, "0.2.0", 2);
  } finally { reader.close(); }
  const verified = validateProtection(bytes);
  assert.equal(bytes.subarray(0, 8).toString(), "SWBACK2\n");
  const entry = verified.manifest.databases[4];
  assert.equal(entry.applicationId, 0x53574f31);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.integrity, "ok");
  assert.deepEqual(entry.initialization, { file: "operations.initialized", content: "operations-v1\n" });
  assert.equal(verified.summary.attendancePlans, 1);
  assert.equal(verified.summary.learningTasks, 1);

  const owner = temp();
  const backup = await io.publish(owner, bytes);
  const restored = await io.restore(owner, await io.read(backup.location));
  const checked = await io.inspect(owner, restored.profileName, 2);
  assert.deepEqual(checked.bytes, bytes);
  const active = await io.restore(owner, checked.bytes, true);
  const selection = { name: active.profileName, digest: checked.digest };
  assert.equal(verifyActiveProfile(owner, selection, true, 2), active.location);
  const data = join(active.location, "data");
  const open = () => {
    const profile = openStores(data, t);
    const ops = OperationsDatabase.open(data, profile.m1);
    return { ...profile, ops, full: [...profile.stores, ops], close() { try { ops.close(); } finally { profile.close(); } } };
  };
  const first = open();
  try {
    verifyProtectionStores(first.full, "0.2.0", 2);
    assert.deepEqual(first.ops.saveAttendancePlan(f.plan), planned);
    assert.equal(first.work.protectionConnection().prepare("SELECT id FROM work_items").get().id, f.itemId);
    assert.equal(first.growth.load(f.studentId).studentId, f.studentId);
    const service = new StudentIntakeService(first.intake, first.m1, first.growth);
    assert.equal(service.prepare(service.register("synthetic", input[1]).token).pendingId, f.requestId);
    first.ops.recordAttendance({ studentId: planned.studentId, id: planned.id, expectedRevision: 1,
      requestId: randomUUID(), action: "confirm" });
  } finally { first.close(); }
  approveActiveProfile(active.location, checked.digest);
  saveActivation(owner, { version: 1, active: selection, pending: null });
  saveActivation(owner, { version: 1, active: null, pending: null });
  assert.equal(f.ops.attendancePlan(planned.id).revision, 1);
  assert.deepEqual(approvedSelection(owner, active.profileName), selection);
  saveActivation(owner, { version: 1, active: selection, pending: null });
  assert.equal(verifyActiveProfile(owner, readActivation(owner).active, false, 2), active.location);
  const reopened = open();
  try {
    assert.equal(reopened.ops.attendancePlan(planned.id).status, "confirmed");
    const again = await io.restore(owner, captureProtection(reopened.full, "0.2.0", 2));
    assert.equal((await io.inspect(owner, again.profileName, 2)).summary.learningTasks, 1);
  } finally { reopened.close(); }
});

test("SWBACK1 upgrades into a new isolated SWBACK2 copy with an empty operations library", async t => {
  const f = fiveFixture(t);
  f.create();
  const v1 = captureProtection(f.stores.slice(0, 4), "0.1.0");
  const candidate = prepareProtectionRestore(v1, 2);
  const old = validateProtection(v1);
  const upgraded = validateProtection(candidate);
  assert.equal(old.summary.formatVersion, 1);
  assert.equal(upgraded.summary.upgradedFromFour, true);
  assert.equal(upgraded.summary.attendancePlans, 0);
  assert.deepEqual(upgraded.images.slice(0, 4), old.images);
  assert.throws(() => prepareProtectionRestore(candidate, 1), /五库备份/);
  const owner = temp(), restored = await io.restore(owner, candidate);
  assert.equal((await io.inspect(owner, restored.profileName, 2)).summary.learningBlocks, 0);
  await assert.rejects(io.inspect(owner, restored.profileName, 1), /无法确认/);
  assert.equal(f.ops.attendancePlan(f.plan.id).revision, 1);
  assert.throws(() => captureProtection(f.stores, "0.2.0", 1), /清单/);
  assert.throws(() => captureProtection(f.stores.slice(0, 4), "0.2.0", 2), /清单/);
});

test("old four- and five-store packages migrate to independent M1 v2 images and retain original bytes", async t => {
  const f = populated(t);
  const operations = OperationsDatabase.open(f.dir, f.m1, true);
  t.after(() => operations.close());
  const originalFiles = ["mvp.sqlite3", "mvp.initialized"].map(name => readFileSync(join(f.dir, name)));
  for (const [stores, format] of [[f.stores, 1], [[...f.stores, operations], 2]]) {
    const legacy = captureProtection(stores, "0.1.0", format);
    const sealed = Buffer.from(legacy);
    const old = validateProtection(legacy);
    const upgraded = prepareProtectionRestore(legacy, 2, 2);
    assert.deepEqual(legacy, sealed);
    assert.equal(old.summary.m1Version, 1);
    const checked = validateProtection(upgraded);
    assert.equal(checked.summary.m1Version, 2);
    assert.equal(checked.summary.upgradedM1, true);
    assert.deepEqual(checked.images.slice(1, old.images.length), old.images.slice(1));
    assert.equal(checked.manifest.m1UpgradedFrom, createHash("sha256").update(sealed).digest("hex"));
    assert.throws(() => prepareProtectionRestore(upgraded, 2), /不能降级/);

    const isolated = await io.restore(f.dir, upgraded);
    assert.equal(readFileSync(join(isolated.location, "recovery", "mvp.initialized"), "utf8"), "mvp-v2\n");
    await assert.rejects(io.inspect(f.dir, isolated.profileName, 2));
    const inspected = await io.inspect(f.dir, isolated.profileName, 2, 2);
    assert.deepEqual(inspected.bytes, upgraded);
    const active = await io.restore(f.dir, inspected.bytes, true);
    const selection = { name: active.profileName, digest: inspected.digest };
    const profile = verifyActiveProfile(f.dir, selection, true, 2, 2);
    const root = join(profile, "data");
    const edited = openStores(root, t, 2);
    const ops = OperationsDatabase.open(root, edited.m1);
    try {
      assert.deepEqual(edited.m1.students(), f.m1.students());
      const view = edited.m1.studentEditView(f.studentId);
      assert.deepEqual(view.history, []);
      const { id, createdAt, ...fields } = view.student;
      edited.m1.saveStudentEdit({ studentId: id, requestId: randomUUID(), expectedRevision: 0,
        fields: { ...fields, alias: "恢复后的虚构学生" } });
      const current = captureProtection([...edited.stores, ops], "0.1.0", 2, 2);
      const copy = await io.restore(f.dir, current, true);
      const library = join(copy.location, "data");
      const reopened = WorkspaceDatabase.open(join(library, "mvp.sqlite3"), join(library, "mvp.initialized"), 2);
      try {
        assert.deepEqual(reopened.studentEditView(id), edited.m1.studentEditView(id));
        assert.equal(reopened.students().find(s => s.id === id).createdAt, createdAt);
      } finally { reopened.close(); }
      assert.equal(f.m1.students().find(s => s.id === id).alias, fields.alias);
      edited.m1.protectionConnection().prepare("UPDATE students SET alias=? WHERE id=?").run("合成损坏", id);
      assert.throws(() => captureProtection([...edited.stores, ops], "0.1.0", 2, 2), /与修改历史不一致/);
    } finally { ops.close(); edited.close(); }
  }
  assert.deepEqual(["mvp.sqlite3", "mvp.initialized"].map(name => readFileSync(join(f.dir, name))), originalFiles);
  assert.deepEqual(originalProfileSegments("sw-r3b-proof", 2), ["sw-r3b-profiles", "sw-r3b-proof", "profile"]);
});

test("SWBACK2 rejects busy and wrongly linked operations and releases earlier SQLite locks", t => {
  const f = fiveFixture(t);
  f.create();
  const connection = new DatabaseSync(join(f.dir, "operations.sqlite3"));
  try {
    connection.exec("BEGIN IMMEDIATE; UPDATE attendance_plans SET updated_at=updated_at+1");
    assert.throws(() => captureProtection(f.stores, "0.2.0", 2), error => ((error.errcode ?? 0) & 255) === 5);
    assert(f.stores.slice(0, 4).every(store => !store.protectionConnection().isTransaction));
    connection.exec("ROLLBACK");
  } finally { connection.close(); }
  const db = f.ops.protectionConnection();
  db.prepare("UPDATE operation_changes SET snapshot_json=json_set(snapshot_json, '$.studentId', ?)").run(f.pending.studentId);
  assert.throws(() => captureProtection(f.stores, "0.2.0", 2), /历史、学生归属/);
  db.exec("UPDATE operation_changes SET snapshot_json=(SELECT result_json FROM operation_requests)");
  db.prepare("UPDATE attendance_plans SET student_id=?").run(randomUUID());
  assert.throws(() => captureProtection(f.stores, "0.2.0", 2), /找不到对应 M1/);
});

test("SWBACK2 rejects fifth-store tampering, truncation and unverified recovery sidecars", async t => {
  const f = fiveFixture(t);
  f.create();
  const bytes = captureProtection(f.stores, "0.2.0", 2);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 40] ^= 1;
  assert.throws(() => validateProtection(rehash(damaged)), /SHA-256/);
  const missing = Buffer.from(bytes);
  missing.write("wrongstore.sqlite3", missing.indexOf(Buffer.from("operations.sqlite3")));
  assert.throws(() => validateProtection(rehash(missing)), /缺少数据库|清单身份/);
  assert.throws(() => validateProtection(bytes.subarray(0, -512)), /SHA-256/);

  const owner = temp(), restored = await io.restore(owner, bytes);
  const checked = await io.inspect(owner, restored.profileName, 2);
  const active = await io.restore(owner, checked.bytes, true);
  const selection = { name: active.profileName, digest: checked.digest };
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const rejected = await io.restore(owner, checked.bytes, true);
    const path = join(rejected.location, "data", "operations.sqlite3" + suffix);
    writeFileSync(path, "unverified");
    assert.throws(() => verifyActiveProfile(owner, { ...selection, name: rejected.profileName }, true, 2), /侧车/);
    assert.equal(readFileSync(path, "utf8"), "unverified");
  }
  const restoredData = join(restored.location, "recovery");
  const originalFile = join(restoredData, "operations.sqlite3");
  renameSync(originalFile, join(owner, "held-operations.sqlite3"));
  assert.throws(() => verifyActiveProfile(owner, selection, true, 1), /选择记录/);
  await assert.rejects(io.inspect(owner, restored.profileName, 2), /无法确认/);
  linkSync(join(owner, "held-operations.sqlite3"), originalFile);
  await assert.rejects(io.inspect(owner, restored.profileName, 2), /无法确认/);
});

test("the original-profile mode never reenrolls a missing five-store profile or exports four stores", t => {
  const root = temp(), profile = join(root, "profile"), data = join(profile, "data");
  mkdirSync(data, { recursive: true });
  assert.equal(checkOriginalProtectionMode(profile, 2, true), true);
  assert.throws(() => checkOriginalProtectionMode(profile, 2, true), /文件缺失/);
  assert.throws(() => checkOriginalProtectionMode(profile, 1), /无法使用四库模式/);
  assert.deepEqual(readdirSync(data), []);
  const other = temp(), old = join(other, "profile"), oldData = join(old, "data");
  mkdirSync(oldData, { recursive: true });
  const f = openStores(oldData, t);
  assert.throws(() => checkOriginalProtectionMode(old, 2, true), /全新合成档案/);
  assert.equal(checkOriginalProtectionMode(old, 1), false);
  const ops = OperationsDatabase.open(oldData, f.m1, true);
  t.after(() => ops.close());
  assert.throws(() => checkOriginalProtectionMode(old, 1), /无法使用四库模式/);
});

test("an interrupted fifth-image write leaves no ready record and preserves the original stores", t => {
  const f = fiveFixture(t);
  const plan = f.create();
  const verified = validateProtection(captureProtection(f.stores, "0.2.0", 2));
  const part = bytes => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const input = Buffer.concat([part(Buffer.from("{}")), ...verified.images.map(part)]).subarray(0, -512);
  const root = temp();
  const name = "sw-m2d-active-" + randomUUID().replaceAll("-", "");
  const result = spawnSync(exe, ["activate", root, name, "2"], { input });
  assert.equal(result.status, 1);
  const target = join(root, name, "profile");
  assert.equal(existsSync(join(target, "restore.ready")), false);
  assert.equal(existsSync(join(target, "data", "operations.initialized")), false);
  assert.equal(existsSync(join(target, "data", "student-intake.initialized")), true);
  assert.deepEqual(f.ops.attendancePlan(plan.id), plan);
  validateProtection(captureProtection(f.stores, "0.2.0", 2));
});

test("a historical four-store executable cannot reach the nested five-store owner with the same profile name", t => {
  const root = temp(), name = "sw-r2a-downgrade-test";
  const legacy = join(root, ...originalProfileSegments(name, 1));
  const five = join(root, ...originalProfileSegments(name, 2));
  assert.equal(legacy, join(root, name, "profile"));
  assert.notEqual(five, legacy);
  mkdirSync(join(five, "data"), { recursive: true });
  assert.equal(checkOriginalProtectionMode(five, 2, true), true);
  mkdirSync(join(legacy, "data"), { recursive: true });
  assert.equal(checkOriginalProtectionMode(legacy, 1), false);
  assert.throws(() => checkOriginalProtectionMode(five, 1), /无法使用四库模式/);
});
