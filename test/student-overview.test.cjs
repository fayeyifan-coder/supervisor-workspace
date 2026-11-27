const assert = require("node:assert/strict");
const { test } = require("node:test");
const { summarizeStudentOverview } = require("../build/student-overview.js");

test("overview preserves source identity and excludes completed, cancelled and foreign records", () => {
  const studentId = "local-student", other = "other-student";
  const one = (id, owner, takenOn, score, extra = {}) => ({ id, studentId: owner, savedAt: 1,
    fields: { takenOn, subject: "数学", category: "日常测验", maximum: "100", score, assessment: id, ...extra } });
  const concern = (requestId, owner, nextOn, status) => ({ requestId, studentId: owner, nextOn,
    concern: requestId, reportedOn: "2026-11-01", followUps: status ? [{ studentId: owner, concernId: requestId, status, nextOn }] : [] });
  const at = Date.parse("2026-11-27T08:00:00+08:00");
  const visit = (id, owner, status) => ({ plan: { id, studentId: owner, startAt: at + 1000, endAt: at + 2000, status },
    blocks: [{ studentId: owner, attendancePlanId: id, status: "planned", plannedStart: at,
      tasks: [{ id: id + "-pending", status: "planned" }, { id: id + "-done", status: "done" }] }] });
  const sources = { studentId, now: at, concerns: { studentId, concerns: [
    concern("closed", studentId, "2026-11-26", "resolved"), concern("later", studentId, "2026-11-30"),
    concern("first", studentId, "2026-11-27", "in_progress"), concern("foreign", other, "2026-11-26")] },
  scores: [one("prior", studentId, "2026-10-01", "62"), one("later", studentId, "2026-11-25", "81", { classRank: "5", classSize: "40" }),
    one("foreign", other, "2026-11-26", "99")],
  growth: { studentId, currentSituation: "合成现状", goals: [
    { id: "done", status: "achieved", deadline: "2026-11-30" }, { id: "current", status: "active", deadline: "2026-12-01" }] },
  history: [{ studentId: other, id: "foreign", nextStep: "异档" }, { studentId, id: "lesson", nextStep: "合成复盘", date: "2026-11-24" }],
  visits: [visit("valid", studentId, "planned"), visit("cancelled", studentId, "cancelled"), visit("foreign", other, "confirmed")] };
  const view = summarizeStudentOverview(sources);
  assert.deepEqual(view.concerns.map(row => row.id), ["first", "later"]);
  assert.deepEqual(view.recentTrend.map(row => row.rate), [62, 81]);
  assert.equal(view.recentScore.id, "later");
  assert.deepEqual(view.recentScore.classRank, { rank: 5, size: 40 });
  assert.deepEqual(view.recentScore.gradeRank, { rank: null, size: null });
  assert.deepEqual(view.goals.map(row => row.id), ["current"]);
  assert.equal(view.situation, "合成现状");
  assert.deepEqual(view.attendance.map(row => row.id), ["valid"]);
  assert.deepEqual(view.tasks.map(row => [row.id, row.visitId]), [["valid-pending", "valid"]]);
  assert.equal(view.nextAction.id, "lesson");
  const empty = summarizeStudentOverview({ ...sources, studentId: "empty" });
  assert.deepEqual(empty, { studentId: "empty", concerns: [], openConcerns: 0, recentScore: undefined, recentTrend: [],
    goals: [], situation: "", attendance: [], tasks: [], nextAction: undefined });
});

test("8 is discovered only from the matching restored profile marker and invalid markers fail closed", async t => {
  const { exportFixture } = require("./export-fixture.cjs");
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { ProtectionFiles, prepareProtectionRestore } = require("../build/offline-protection.js");
  const { restoredStudentVersion } = require("../build/profile-activation.js");
  const { dir, capture } = exportFixture(t);
  const files = new ProtectionFiles(join(__dirname, "../build/recovery-io.exe"));
  const original = await files.restore(dir, capture());
  assert.equal(restoredStudentVersion(dir, original.profileName), 6);
  const migrated = await files.restore(dir, prepareProtectionRestore(capture(), 2, 8));
  assert.equal(restoredStudentVersion(dir, migrated.profileName), 8);
  assert.equal((await files.inspect(dir, migrated.profileName, 2, 8)).summary.students, 1);
  assert.throws(() => restoredStudentVersion(dir, "../elsewhere"));
  writeFileSync(join(migrated.location, "recovery", "mvp.initialized"), "mvp-v9\n");
  assert.throws(() => restoredStudentVersion(dir, migrated.profileName));
});
