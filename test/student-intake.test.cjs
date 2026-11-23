const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const { WorkspaceDatabase } = require("../build/database.js");
const { GrowthProfileDatabase } = require("../build/growth-profile.js");
const { parseIntake } = require("../build/intake-format.js");
const { IntakeStore, StudentIntakeService, intakeSourceDigest } = require("../build/student-intake.js");

const fullFixture = readFileSync(join(__dirname, "fixtures", "synthetic-intake-001.json"), "utf8");
const shortFixture = readFileSync(join(__dirname, "fixtures", "synthetic-intake-002.json"), "utf8");
const fullJson = () => JSON.parse(fullFixture.replace(/^\uFEFF/, ""));
const newTarget = { kind: "new" };
const validationFault = error => error.code === "invalid";
const conflictFault = error => ["invalid", "conflict"].includes(error.code);

function localStores(t) {
  const root = mkdtempSync(join(tmpdir(), "supervisor-intake-synthetic-"));
  const openM1 = () => WorkspaceDatabase.open(join(root, "mvp.sqlite3"), join(root, "mvp.initialized"));
  const openGrowth = () => GrowthProfileDatabase.open(join(root, "growth.sqlite3"), join(root, "growth.initialized"));
  const openIntake = () => IntakeStore.open(join(root, "student-intake.sqlite3"), join(root, "student-intake.initialized"));
  let m1 = openM1();
  let growth = openGrowth();
  let intake = openIntake();
  let service = new StudentIntakeService(intake, m1, growth);

  function close() {
    const errors = [];
    for (const db of [intake, growth, m1]) {
      try { db?.close(); } catch (error) { errors.push(error); }
    }
    intake = growth = m1 = undefined;
    if (errors.length) throw new AggregateError(errors, "Failed to close synthetic stores");
  }

  t.after(() => {
    try { close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  return {
    get m1() { return m1; },
    get growth() { return growth; },
    get intake() { return intake; },
    get service() { return service; },
    useGrowth(growthOverride) {
      service = new StudentIntakeService(intake, m1, growthOverride);
    },
    reopen() {
      close();
      m1 = openM1();
      growth = openGrowth();
      intake = openIntake();
      service = new StudentIntakeService(intake, m1, growth);
    },
  };
}

function makeStudent(m1, patch = {}) {
  return m1.createStudent({
    id: randomUUID(),
    alias: "合成学生",
    grade: "七年级",
    subjects: "数学",
    goal: "",
    notes: "",
    ...patch,
  });
}

function register(service, raw = fullFixture) {
  return service.register("synthetic.json", raw);
}

function command(registered, prepared, patch = {}) {
  return {
    token: registered.token,
    target: prepared.target,
    expectedRevision: prepared.revision,
    ...(prepared.target?.kind === "new" && { student: registered.source.student }),
    fields: prepared.proposed,
    reviewed: true,
    ...(prepared.pendingId && { pendingId: prepared.pendingId }),
    ...patch,
  };
}

function createGrowth(f, studentId, patch = {}) {
  return f.growth.save({
    requestId: randomUUID(),
    studentId,
    expectedRevision: 0,
    learningCharacteristics: "",
    communicationPreferences: "",
    currentSituation: "",
    strengths: "原有优势",
    weakAreas: "",
    goals: [],
    observations: [],
    ...patch,
  }, id => f.m1.students().some(student => student.id === id));
}

test("valid WorkBuddy evidence, warnings, categories, and unrecognized values remain available", () => {
  const source = parseIntake(fullFixture);
  assert.equal(source.code, "DEMO-001");
  assert.equal(source.student.alias, "DEMO-001");
  assert.equal(source.student.grade, "七年级");
  assert.match(source.student.subjects, /数学/);
  assert.match(source.growth.learningCharacteristics, /检查/);
  assert.match(source.growth.strengths, /列出步骤/);
  assert.deepEqual(source.source, fullJson());
  for (const category of ["fact", "self-report", "teacher-assessment", "goal", "plan", "warning", "unknown"]) {
    assert.ok(source.review.some(item => item.category === category), "Missing review category " + category);
  }
  assert.ok(source.review.some(item => item.path === "$.future_section"));
  assert.deepEqual(source.source.profile.teacher_observations[0].evidence[0], {
    source_page: 3,
    source_type: "教师观察",
    original_text: "练习中列出分步计算。",
    confidence: "medium",
    review_required: true,
  });
  assert.equal(source.source.score_records[0].full_score, null);
  assert.equal(source.source.improvement_goals[0].target_display, "70+");
  assert.equal(source.source.improvement_goals[0].deadline, null);
});

test("strict validation rejects bad JSON, roots, imported codes, types, lengths, dates, page references, and list sizes", () => {
  for (const raw of ["", "{}", "[{}]", "{bad", "null"]) {
    assert.throws(() => parseIntake(raw), validationFault, raw);
  }
  const faults = [
    data => { data.schema_version = "sw-student-intake-v2"; },
    data => { data.student_code = "bad code"; },
    data => { data.student_code = "D".repeat(41); },
    data => { data.student = []; },
    data => { data.student.grade = 7; },
    data => { data.student.grade = "年".repeat(31); },
    data => { data.student.subjects = Array.from({ length: 1001 }, () => "数学"); },
    data => { data.student.registration_date = "2026-02-29"; },
    data => { data.improvement_goals[0].deadline = "2027-13-01"; },
    data => { data.profile.teacher_observations[0].evidence[0].confidence = false; },
    data => { data.profile.teacher_observations[0].evidence[0].source_page = -1; },
  ];
  for (const mutate of faults) {
    const data = fullJson();
    mutate(data);
    assert.throws(() => parseIntake(JSON.stringify(data)), validationFault, String(mutate));
  }
});

test("new import requires explicit confirmation and survives reopen", t => {
  const f = localStores(t);
  const unrelated = makeStudent(f.m1, { alias: "其他合成学生" });
  const file = register(f.service);
  const unchecked = f.service.prepare(file.token);
  assert.equal(unchecked.state, "unbound");
  assert.equal(f.m1.students().length, 1);

  const preview = f.service.prepare(file.token, newTarget);
  const request = command(file, preview, {
    student: { ...file.source.student, alias: "合成小禾" },
    fields: { ...preview.proposed, communicationPreferences: "先确认目标，再解释步骤。" },
  });
  assert.throws(() => f.service.confirm({ ...request, reviewed: false }), validationFault);
  assert.equal(f.m1.students().length, 1);
  const saved = f.service.confirm(request);
  assert.equal(saved.state, "saved");
  assert.equal(saved.studentConfirmed, true);
  assert.notEqual(saved.studentId, unrelated.id);
  assert.equal(f.m1.students().length, 2);
  assert.equal(f.growth.load(unrelated.id).exists, false);

  f.reopen();
  const student = f.m1.students().find(row => row.id === saved.studentId);
  const growth = f.growth.load(student.id);
  assert.equal(student.alias, "合成小禾");
  assert.equal(growth.communicationPreferences, "先确认目标，再解释步骤。");
  assert.equal(growth.revision, 1);
  assert.equal(growth.goals.length, 0);
  assert.equal(growth.observations.length, 0);
  const history = f.service.history(student.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].state, "done");
  assert.deepEqual(history[0].source.source, fullJson());
  assert.deepEqual(f.service.history(unrelated.id), []);
  assert.deepEqual(f.service.historySummary(student.id), {
    studentId: student.id,
    entries: [{
      digest: intakeSourceDigest(fullJson()), code: "DEMO-001", state: "done", updatedAt: history[0].updatedAt,
      documentCount: fullJson().source_documents.length,
      reviewCount: history[0].source.review.filter(item => ["warning", "unknown"].includes(item.category)).length,
    }],
  });
  assert.deepEqual(f.service.historySummary(unrelated.id), { studentId: unrelated.id, entries: [] });
  assert.throws(() => f.service.historySummary(randomUUID()), validationFault);
});

test("intake history reports an unreadable timestamp without erasing the source", t => {
  const f = localStores(t);
  const file = register(f.service);
  const saved = f.service.confirm(command(file, f.service.prepare(file.token, newTarget)));
  const digest = intakeSourceDigest(fullJson());
  const db = f.intake.protectionConnection();
  db.prepare("UPDATE intake_jobs SET updated_at=? WHERE digest=?").run(8640000000000001, digest);
  const original = f.service.history(saved.studentId);
  assert.equal(original[0].updatedAt, 8640000000000001);
  assert.throws(() => f.service.historySummary(saved.studentId), error => error.code === "recovery");
  assert.deepEqual(f.service.history(saved.studentId), original);
});

test("a matching display alias is never treated as an import identity", t => {
  const f = localStores(t);
  const sameAlias = makeStudent(f.m1, { alias: "DEMO-001" });
  const file = register(f.service);
  assert.equal(f.service.prepare(file.token).state, "unbound");
  const newPreview = f.service.prepare(file.token, newTarget);
  assert.throws(() => f.service.confirm(command(file, newPreview)), conflictFault);

  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(sameAlias.id).exists, false);
  assert.deepEqual(f.service.history(sameAlias.id), []);
  const association = f.service.prepare(file.token, { kind: "existing", studentId: sameAlias.id });
  assert.equal(f.service.confirm(command(file, association)).studentId, sameAlias.id);
  assert.equal(f.m1.students().length, 1);
});


test("explicit association updates only the selected growth record and keeps prior goals and observations", t => {
  const f = localStores(t);
  const a = makeStudent(f.m1, { alias: "相同代号" });
  const b = makeStudent(f.m1, { alias: "相同代号" });
  const goal = { id: randomUUID(), subject: "数学", targetScore: 83, deadline: "2027-01-30", strategy: "继续练习", status: "active" };
  const observation = { id: randomUUID(), observedOn: "2026-11-21", content: "已有合成观察。" };
  const before = createGrowth(f, a.id, { goals: [goal], observations: [observation] });
  const file = register(f.service);
  const target = { kind: "existing", studentId: a.id };
  const preview = f.service.prepare(file.token, target);
  assert.equal(preview.existing.strengths, before.strengths);
  assert.equal(preview.revision, 1);
  const request = command(file, preview, {
    fields: { ...preview.proposed, strengths: before.strengths + "\n人工核对后补充一项优势。" },
  });
  const result = f.service.confirm(request);
  assert.equal(result.state, "saved");
  assert.equal(result.studentId, a.id);
  assert.equal(f.m1.students().length, 2);
  assert.deepEqual(f.m1.students().find(student => student.id === a.id), a);
  assert.equal(f.growth.load(b.id).exists, false);
  const updated = f.growth.load(a.id);
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.goals, before.goals);
  assert.deepEqual(updated.observations, before.observations);
});

test("repeat import of the same source, including formatting changes, adds no student, history, or observation", t => {
  const f = localStores(t);
  const student = makeStudent(f.m1);
  createGrowth(f, student.id, {
    observations: [{ id: randomUUID(), observedOn: "2026-11-21", content: "已有合成观察。" }],
  });
  const token = register(f.service);
  const ready = f.service.prepare(token.token, { kind: "existing", studentId: student.id });
  const request = command(token, ready);
  const saved = f.service.confirm(request);
  assert.equal(saved.state, "saved");
  f.reopen();

  const sameSource = register(f.service, JSON.stringify(fullJson(), null, 4));
  const replay = f.service.prepare(sameSource.token);
  assert.equal(replay.state, "done");
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(student.id).revision, 2);
  assert.equal(f.growth.load(student.id).observations.length, 1);
  assert.equal(f.service.history(student.id).length, 1);
});

test("invalid student associations and rebinding an imported code are refused", t => {
  const f = localStores(t);
  const a = makeStudent(f.m1);
  const b = makeStudent(f.m1);
  const file = register(f.service);
  assert.throws(() => f.service.prepare(file.token, { kind: "existing", studentId: randomUUID() }), conflictFault);
  const ready = f.service.prepare(file.token, { kind: "existing", studentId: a.id });
  assert.equal(f.service.confirm(command(file, ready)).state, "saved");

  const changed = fullJson();
  changed.student.learning_background[0].statement = "第二份合成材料。";
  const otherFile = register(f.service, JSON.stringify(changed));
  assert.throws(() => f.service.prepare(otherFile.token, { kind: "existing", studentId: b.id }), conflictFault);
  assert.equal(f.growth.load(b.id).exists, false);
  assert.equal(f.m1.students().length, 2);
});

test("stale approved revision cannot overwrite a growth edit performed after preview", t => {
  const f = localStores(t);
  const student = makeStudent(f.m1);
  const file = register(f.service);
  const prepared = f.service.prepare(file.token, { kind: "existing", studentId: student.id });
  createGrowth(f, student.id, { currentSituation: "预览之后手动录入的学情。" });
  assert.throws(() => f.service.confirm(command(file, prepared)), conflictFault);
  assert.equal(f.growth.load(student.id).currentSituation, "预览之后手动录入的学情。");
  assert.equal(f.growth.load(student.id).revision, 1);
});

test("M1 success plus growth failure stays pending across reopen and resumes without creating a second M1 row", t => {
  const f = localStores(t);
  const store = f.growth;
  let attempts = 0;
  f.useGrowth({
    load: store.load.bind(store),
    save() {
      attempts++;
      const error = new Error("Injected growth storage I/O error");
      error.errcode = 10;
      throw error;
    },
  });
  const file = register(f.service);
  const preview = f.service.prepare(file.token, newTarget);
  const editedFields = { ...preview.proposed, communicationPreferences: "合成资料，先给提示。" };
  const result = f.service.confirm(command(file, preview, { fields: editedFields }));
  assert.equal(attempts, 1);
  assert.equal(result.state, "pending");
  assert.equal(result.studentConfirmed, true);
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(result.studentId).exists, false);

  f.reopen();
  const resumed = register(f.service);
  const pending = f.service.prepare(resumed.token);
  assert.equal(pending.state, "pending");
  assert.equal(f.service.history(result.studentId)[0].state, "pending");
  const finish = f.service.confirm(command(resumed, pending, { fields: editedFields }));
  assert.equal(finish.state, "saved");
  assert.equal(finish.studentId, result.studentId);
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(result.studentId).communicationPreferences, editedFields.communicationPreferences);
  assert.equal(f.growth.load(result.studentId).revision, 1);
});

test("a growth COMMIT that returns an error cannot add a duplicate growth revision after reopen", t => {
  const f = localStores(t);
  const store = f.growth;
  let injected = false;
  f.useGrowth({
    load: store.load.bind(store),
    save(input, studentExists) {
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === "COMMIT" && !injected) {
          injected = true;
          throw new Error("Injected driver error after actual growth COMMIT");
        }
        return result;
      };
      try {
        return store.save(input, studentExists);
      } finally {
        DatabaseSync.prototype.exec = exec;
      }
    },
  });
  const file = register(f.service, shortFixture);
  const preview = f.service.prepare(file.token, newTarget);
  const result = f.service.confirm(command(file, preview));
  assert.ok(injected);
  assert.ok(["pending", "saved"].includes(result.state));
  assert.equal(f.growth.load(result.studentId).revision, 1);

  f.reopen();
  const reopened = register(f.service, shortFixture);
  const state = f.service.prepare(reopened.token);
  if (state.state === "pending") {
    assert.equal(f.service.confirm(command(reopened, state)).state, "saved");
  } else {
    assert.equal(state.state, "done");
  }
  assert.equal(f.m1.students().length, 1);
  const growth = f.growth.load(result.studentId);
  assert.equal(growth.revision, 1);
  assert.equal(growth.history.length, 1);
  assert.equal(f.service.history(result.studentId).length, 1);
});

test("a saved student whose COMMIT response is lost is reused on a same-file retry", t => {
  const f = localStores(t);
  const m1 = f.m1;
  const realCreate = m1.createStudent.bind(m1);
  let injected = false;
  m1.createStudent = input => {
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === "COMMIT" && !injected) {
        injected = true;
        throw new Error("Injected driver error after actual M1 COMMIT");
      }
      return result;
    };
    try {
      return realCreate(input);
    } finally {
      DatabaseSync.prototype.exec = exec;
    }
  };

  const file = register(f.service, shortFixture);
  const ready = f.service.prepare(file.token, newTarget);
  const first = f.service.confirm(command(file, ready));
  assert.ok(injected);
  assert.equal(first.state, "pending");
  assert.equal(first.studentConfirmed, false);
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.m1.students()[0].id, first.studentId);
  assert.equal(f.growth.load(first.studentId).exists, false);

  f.reopen();
  const reopened = register(f.service, shortFixture);
  const pending = f.service.prepare(reopened.token);
  assert.equal(pending.state, "pending");
  const saved = f.service.confirm(command(reopened, pending));
  assert.equal(saved.state, "saved");
  assert.equal(saved.studentId, first.studentId);
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(saved.studentId).revision, 1);
});

test("a full selection of 20 files remains isolated and preview skips all database writes", t => {
  const f = localStores(t);
  const sources = Array.from({ length: 20 }, (_, index) => ({
    schema_version: "sw-student-intake-v1",
    student_code: "BATCH-" + String(index + 1).padStart(3, "0"),
    student: { grade: "八年级", subjects: ["英语"] },
  }));
  const files = sources.map(source => f.service.register(source.student_code + ".json", JSON.stringify(source)));
  assert.throws(() => register(f.service, shortFixture), validationFault);
  assert.equal(new Set(files.map(file => file.token)).size, 20);
  assert.equal(f.m1.students().length, 0);

  const first = files[0];
  const last = files[files.length - 1];
  const firstPreview = f.service.prepare(first.token, newTarget);
  const lastPreview = f.service.prepare(last.token, newTarget);
  const lastSave = f.service.confirm(command(last, lastPreview));
  const firstSave = f.service.confirm(command(first, firstPreview));
  assert.equal(firstSave.state, "saved");
  assert.equal(lastSave.state, "saved");
  assert.notEqual(firstSave.studentId, lastSave.studentId);
  assert.deepEqual(f.m1.students().map(student => student.alias).sort(), ["BATCH-001", "BATCH-020"]);
  assert.equal(f.service.history(firstSave.studentId)[0].source.code, "BATCH-001");
  assert.equal(f.service.history(lastSave.studentId)[0].source.code, "BATCH-020");
});

test("pending import keeps a conflicting growth edit intact until a fresh review confirms new fields", t => {
  const f = localStores(t);
  const store = f.growth;
  f.useGrowth({
    load: store.load.bind(store),
    save() { throw new Error("Injected service outage before growth save"); },
  });
  const file = register(f.service);
  const ready = f.service.prepare(file.token, newTarget);
  const pending = f.service.confirm(command(file, ready));
  assert.equal(pending.state, "pending");
  const studentId = pending.studentId;

  f.reopen();
  createGrowth(f, studentId, { currentSituation: "待核对期间手动保存的学情。" });
  const reopened = register(f.service);
  const retry = f.service.prepare(reopened.token);
  assert.equal(retry.state, "pending");
  const conflict = f.service.confirm(command(reopened, retry));
  assert.equal(conflict.state, "review");
  assert.equal(f.growth.load(studentId).revision, 1);
  assert.equal(f.growth.load(studentId).currentSituation, "待核对期间手动保存的学情。");
  assert.equal(f.service.history(studentId)[0].state, "review");

  const reviewed = f.service.prepare(reopened.token);
  assert.equal(reviewed.state, "review");
  assert.equal(reviewed.existing.currentSituation, "待核对期间手动保存的学情。");
  const complete = f.service.confirm(command(reopened, reviewed, {
    fields: { ...reviewed.proposed, currentSituation: reviewed.existing.currentSituation + "\n人工核对后补充。" },
  }));
  assert.equal(complete.state, "saved");
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(studentId).revision, 2);
  assert.match(f.growth.load(studentId).currentSituation, /^待核对期间手动保存的学情/);
});


test("two previews of the same file cannot confirm different students", t => {
  const f = localStores(t);
  const a = makeStudent(f.m1, { alias: "合成A" });
  const b = makeStudent(f.m1, { alias: "合成B" });
  const fileA = register(f.service);
  const fileB = register(f.service);
  const readyA = f.service.prepare(fileA.token, { kind: "existing", studentId: a.id });
  const readyB = f.service.prepare(fileB.token, { kind: "existing", studentId: b.id });

  const confirmed = f.service.confirm(command(fileA, readyA));
  assert.equal(confirmed.state, "saved");
  assert.equal(confirmed.studentId, a.id);
  assert.throws(() => f.service.confirm(command(fileB, readyB)), conflictFault);
  assert.equal(f.growth.load(b.id).exists, false);
  assert.deepEqual(f.service.history(b.id), []);
  assert.equal(f.service.history(a.id).length, 1);
});

test("a lost response from the intake plan COMMIT can resume the durable plan after reopen", t => {
  const f = localStores(t);
  const file = register(f.service);
  const ready = f.service.prepare(file.token, newTarget);
  const exec = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === "COMMIT" && !injected) {
      injected = true;
      throw new Error("Injected driver error after actual intake plan COMMIT");
    }
    return result;
  };
  let outcome;
  try {
    try {
      outcome = f.service.confirm(command(file, ready));
    } catch (error) {
      assert.equal(error.code, "unknown");
    }
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  if (outcome) assert.equal(outcome.state, "pending");
  assert.ok(injected);
  assert.equal(f.m1.students().length, 0);

  f.reopen();
  const restored = register(f.service);
  const pending = f.service.prepare(restored.token);
  assert.equal(pending.state, "pending");
  const saved = f.service.confirm(command(restored, pending));
  assert.equal(saved.state, "saved");
  assert.equal(f.m1.students().length, 1);
  assert.equal(f.growth.load(saved.studentId).revision, 1);
  assert.equal(f.service.history(saved.studentId).length, 1);
});
