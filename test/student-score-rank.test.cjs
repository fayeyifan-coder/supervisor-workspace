const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { exportFixture } = require("./export-fixture.cjs");
const { captureProtection, prepareProtectionRestore, ProtectionFiles, validateProtection } = require("../build/offline-protection.js");
const { WorkspaceDatabase } = require("../build/database.js");
const { businessExportDocument, businessExportPayload } = require("../build/business-export.js");
const { Workbook } = require("../build/exceljs.runtime.js");
const { join } = require("node:path");

test("score ranks preserve the legacy payload, revision identity and backup/export round trip", async t => {
  const previous = exportFixture(t);
  const oldBytes = previous.capture();
  const v7 = prepareProtectionRestore(oldBytes, 2, 7);
  assert.deepEqual(validateProtection(v7).images.slice(1), validateProtection(oldBytes).images.slice(1));
  const restore = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
  const copy = await restore.restore(previous.dir, v7);
  assert.equal((await restore.inspect(previous.dir, copy.profileName, 2, 7)).summary.m1Version, 7);
  const activated = await restore.restore(previous.dir, v7, true);
  const folder = join(activated.location, "data");
  const scores = WorkspaceDatabase.open(join(folder, "mvp.sqlite3"), join(folder, "mvp.initialized"), 7);
  t.after(() => scores.close());
  const [initial] = scores.studentRecords("score", previous.studentId).records;
  assert.equal(initial.revision, 2);
  assert.equal(initial.fields.score, "91.25");
  assert.equal(initial.fields.classRank, undefined);
  const command = { kind: "score", id: initial.id, studentId: previous.studentId, expectedRevision: 2,
    requestId: randomUUID(), fields: { ...initial.fields, classRank: "1", classSize: "42", gradeSize: "200" } };
  for (const fields of [{ classRank: "0" }, { classRank: "1.5" }, { classRank: "1e2" }, { classRank: "9007199254740992" },
    { classRank: "43" }, { gradeRank: "201" }, { classSize: "-1" }]) {
    assert.throws(() => scores.saveStudentRecord({ ...command, fields: { ...command.fields, ...fields } }), /正整数|参考人数/);
  }
  assert.equal(scores.studentRecords("score", previous.studentId).records[0].revision, 2);
  const saved = scores.saveStudentRecord(command);
  assert.deepEqual(scores.saveStudentRecord(command), saved);
  assert.equal(saved.fields.gradeRank, undefined);
  assert.equal(saved.fields.gradeSize, "200");
  const bytes = captureProtection([scores, ...previous.stores.slice(1)], "0.2.3", 2, 7);
  assert.throws(() => prepareProtectionRestore(bytes, 2, 6), /不能降级/);
  const restored = await restore.restore(previous.dir, bytes, true);
  const restoredDb = WorkspaceDatabase.open(join(restored.location, "data", "mvp.sqlite3"),
    join(restored.location, "data", "mvp.initialized"), 7);
  try { assert.deepEqual(restoredDb.studentRecords("score", previous.studentId).records, [saved]); }
  finally { restoredDb.close(); }
  const document = businessExportDocument(bytes, false);
  const rows = document.tables.find(table => table.table === "student_scores").rows.sort((a, b) => a.revision - b.revision);
  const originals = businessExportDocument(oldBytes, false).tables.find(table => table.table === "student_scores").rows.sort((a, b) => a.revision - b.revision);
  assert.deepEqual(rows.slice(0, 2), originals);
  assert.equal(JSON.parse(rows[2].payload).fields.classRank, "1");
  const { files } = await businessExportPayload(document);
  const book = new Workbook();
  await book.xlsx.load(files[0].bytes);
  const sheet = book.getWorksheet("考试成绩");
  const column = sheet.getRow(1).values.findIndex(label => String(label).endsWith("[payload.classRank]"));
  assert(column > 0);
  assert.equal([2, 3, 4].filter(row => sheet.getCell(row, column).text === "1").length, 1);
});

test("rank series preserves exam slots where rank is missing and starts at first place", () => {
  const { rankTrend, scoreTrend } = require("../src/score-trend.ts");
  const create = (id, takenOn, fields) => ({ id, studentId: "one", savedAt: 1,
    fields: { takenOn, subject: "数学", category: "期中考试", score: "20", maximum: "30", ...fields } });
  const records = [create("a", "2026-10-02", { classRank: "1", gradeRank: "5" }),
    create("b", "2026-10-02", { classSize: "20" }), create("c", "2026-09-03", { classRank: "4" })];
  const view = scoreTrend(records, "one");
  assert.deepEqual(rankTrend(view.points, "class"), { ranks: [4, 1, null], count: 2, bottom: 4 });
  assert.deepEqual(rankTrend(view.points, "grade"), { ranks: [null, 5, null], count: 1, bottom: 5 });
});
