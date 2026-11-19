const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { WorkspaceDatabase } = require("../build/database.js");
const { GrowthProfileDatabase } = require("../build/growth-profile.js");

function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "M2C-合成成长档案-"));
  const m1Path = join(root, "mvp.sqlite3");
  const m1 = WorkspaceDatabase.open(m1Path, join(root, "mvp.initialized"));
  const studentA = m1.createStudent({ id: randomUUID(), alias: "合成学生·小禾", grade: "七年级", subjects: "数学、语文", goal: "练习分数", notes: "" });
  const studentB = m1.createStudent({ id: randomUUID(), alias: "合成学生·小川", grade: "八年级", subjects: "英语", goal: "", notes: "" });
  const path = join(root, "growth.sqlite3"), marker = join(root, "growth.initialized");
  let growth = GrowthProfileDatabase.open(path, marker);
  t.after(() => { growth?.close(); m1.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, m1, m1Path, studentA, studentB, path, marker, get growth() { return growth; },
    reopen() { growth?.close(); growth = GrowthProfileDatabase.open(path, marker); } };
}
function draft(studentId, expectedRevision = 0, patch = {}) {
  return { requestId: randomUUID(), studentId, expectedRevision,
    learningCharacteristics: "按步骤列式时较容易核对", communicationPreferences: "先说明目标，再给具体建议",
    currentSituation: "近期学习分数运算", strengths: "能按要求完成分数练习", weakAreas: "异分母通分步骤需继续练习",
    goals: [{ id: randomUUID(), subject: "数学", targetScore: 85, deadline: "2027-01-30", strategy: "每周复习错题并进行两次练习", status: "active" }],
    observations: [{ id: randomUUID(), observedOn: "2026-11-19", content: "完成练习后主动检查了两道题的分母。" }],
    ...patch };
}

test("growth profiles remain isolated by M1 student UUID and never change M1", t => {
  const f = fixture(t), before = hash(f.m1Path);
  const a = f.growth.load(f.studentA.id), b = f.growth.load(f.studentB.id);
  assert.equal(a.exists, false); assert.equal(a.revision, 0); assert.deepEqual(a.goals, []);
  const savedA = f.growth.save(draft(f.studentA.id), id => f.m1.students().some(student => student.id === id));
  const savedB = f.growth.save(draft(f.studentB.id, 0, { weakAreas: "英语听力策略需持续调整" }),
    id => f.m1.students().some(student => student.id === id));
  assert.equal(savedA.weakAreas, "异分母通分步骤需继续练习");
  assert.equal(f.growth.load(f.studentB.id).weakAreas, savedB.weakAreas);
  assert.notEqual(f.growth.load(f.studentA.id).weakAreas, f.growth.load(f.studentB.id).weakAreas);
  assert.equal(f.m1.students().length, 2); assert.equal(hash(f.m1Path), before);
});

test("create, edit, goal changes, dated observations, and full history survive close and reopen", t => {
  const f = fixture(t);
  const firstInput = draft(f.studentA.id);
  const first = f.growth.save(firstInput, id => f.m1.students().some(student => student.id === id));
  assert.equal(first.revision, 1); assert.equal(first.history.length, 1);
  const next = { ...firstInput, requestId: randomUUID(), expectedRevision: 1,
    currentSituation: "已保存两次分数练习记录", strengths: "完成练习并核对分母", weakAreas: "通分步骤",
    goals: first.goals.map(goal => ({ ...goal, status: "paused" })),
    observations: [...first.observations.map(({ id, observedOn, content }) => ({ id, observedOn, content })),
      { id: randomUUID(), observedOn: "2026-11-20", content: "按提示把约分写在最后一步。" }] };
  const edited = f.growth.save(next, id => f.m1.students().some(student => student.id === id));
  assert.equal(edited.revision, 2); assert.equal(edited.history.length, 2);
  assert.equal(edited.history.find(row => row.revision === 1).snapshot.weakAreas, first.weakAreas);
  assert.equal(edited.observations.length, 2); assert.equal(edited.goals[0].status, "paused");
  f.reopen();
  const reopened = f.growth.load(f.studentA.id);
  assert.equal(reopened.revision, 2); assert.equal(reopened.currentSituation, "已保存两次分数练习记录");
  assert.deepEqual(reopened.observations.map(row => row.observedOn), ["2026-11-20", "2026-11-19"]);
  assert.equal(reopened.history.length, 2); assert.equal(reopened.history[1].snapshot.goals[0].status, "active");
});

test("same request is idempotent, changed payload conflicts, and stale profile versions are rejected", t => {
  const f = fixture(t), input = draft(f.studentA.id);
  const first = f.growth.save(input, id => f.m1.students().some(student => student.id === id));
  const replay = f.growth.save(input, id => f.m1.students().some(student => student.id === id));
  assert.equal(replay.revision, first.revision); assert.equal(replay.updatedAt, first.updatedAt);
  assert.equal(replay.goals[0].id, first.goals[0].id); assert.equal(replay.observations[0].id, first.observations[0].id);
  assert.equal(f.growth.load(f.studentA.id).history.length, 1);
  assert.throws(() => f.growth.save({ ...input, weakAreas: "changed payload" }, () => true), error => error.code === "conflict");
  assert.throws(() => f.growth.save({ ...input, requestId: randomUUID(), currentSituation: "stale edit" }, () => true), error => error.code === "conflict");
  assert.equal(f.growth.load(f.studentA.id).currentSituation, first.currentSituation);
  assert.equal(f.growth.load(f.studentA.id).history.length, 1);
});

test("wrong M1 student association and cross-student goal IDs are rejected", t => {
  const f = fixture(t), a = draft(f.studentA.id), b = draft(f.studentB.id);
  const savedB = f.growth.save(b, id => f.m1.students().some(student => student.id === id));
  assert.throws(() => f.growth.save(draft(randomUUID()), () => false), error => error.code === "invalid");
  assert.throws(() => f.growth.save({ ...a, goals: savedB.goals.map(({ id, subject, targetScore, deadline, strategy, status }) =>
    ({ id, subject, targetScore, deadline, strategy, status })) }, () => true), error => error.code === "invalid");
  assert.deepEqual(f.growth.load(f.studentA.id).goals, []);
  assert.equal(f.m1.students().length, 2);
});

test("invalid calendar dates and empty dates are rejected without creating a partial profile", t => {
  const f = fixture(t), input = draft(f.studentA.id), before = hash(f.m1Path);
  const studentExists = id => f.m1.students().some(student => student.id === id);
  assert.throws(() => f.growth.save({ ...input, goals: input.goals.map(goal => ({ ...goal, deadline: "2026-02-30" })) }, studentExists),
    error => error.code === "invalid");
  assert.throws(() => f.growth.save({ ...input, goals: input.goals.map(goal => ({ ...goal, deadline: "" })) }, studentExists),
    error => error.code === "invalid");
  assert.throws(() => f.growth.save({ ...input, observations: input.observations.map(row => ({ ...row, observedOn: "" })) }, studentExists),
    error => error.code === "invalid");
  assert.throws(() => f.growth.save({ ...input, observations: input.observations.map(row => ({ ...row, observedOn: "2026-13-01" })) }, studentExists),
    error => error.code === "invalid");
  const view = f.growth.load(f.studentA.id);
  assert.equal(view.exists, false); assert.equal(view.history.length, 0); assert.deepEqual(view.goals, []); assert.deepEqual(view.observations, []);
  assert.equal(hash(f.m1Path), before);
});

test("unknown COMMIT result resolves with the same request without duplicate revisions or observations", t => {
  const f = fixture(t), input = draft(f.studentA.id), originalExec = DatabaseSync.prototype.exec;
  let inject = true;
  DatabaseSync.prototype.exec = function(sql) {
    const result = originalExec.call(this, sql);
    if (sql === "COMMIT" && inject) { inject = false; throw new Error("injected after commit"); }
    return result;
  };
  try { assert.throws(() => f.growth.save(input, () => true), error => error.code === "unknown"); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  const retried = f.growth.save(input, () => true);
  assert.equal(retried.revision, 1); assert.equal(retried.history.length, 1); assert.equal(retried.observations.length, 1);
  assert.equal(f.growth.load(f.studentA.id).history.length, 1);
});

test("failed growth database identity preserves M1 and leaves the existing database untouched", t => {
  const f = fixture(t), before = hash(f.m1Path), bad = join(f.root, "bad-growth.sqlite3");
  const db = new DatabaseSync(bad); db.exec("PRAGMA application_id=77; PRAGMA user_version=1; CREATE TABLE unrelated(x)"); db.close();
  const badBefore = hash(bad);
  assert.throws(() => GrowthProfileDatabase.open(bad, join(f.root, "bad-growth.initialized")), /身份或版本/);
  assert.equal(hash(bad), badBefore); assert.equal(hash(f.m1Path), before);
});

test("failed first growth database initialization rolls back locally and preserves M1", t => {
  const f = fixture(t), before = hash(f.m1Path);
  const path = join(f.root, "first-init-failure.sqlite3"), marker = join(f.root, "first-init-failure.initialized");
  const originalExec = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!injected && sql.startsWith("CREATE TABLE growth_goals (")) {
      injected = true;
      throw new Error("injected during first growth database initialization");
    }
    return originalExec.call(this, sql);
  };
  try {
    assert.throws(() => GrowthProfileDatabase.open(path, marker), /injected during first growth database initialization/);
  } finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(injected, true);
  assert.equal(existsSync(marker), false);
  assert.equal(hash(f.m1Path), before);
  const partial = new DatabaseSync(path);
  try {
    assert.equal(partial.prepare("PRAGMA application_id").get().application_id, 0);
    assert.equal(partial.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(partial.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='growth_profiles'").get().count, 0);
  } finally { partial.close(); }
  assert.equal(hash(f.m1Path), before);
});
