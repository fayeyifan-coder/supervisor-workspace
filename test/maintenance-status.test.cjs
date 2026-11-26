const assert = require("node:assert/strict");
const { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Diagnostics, sqliteErrorCode } = require("../build/diagnostics.js");
const { readBackupStatus, recordSuccessfulBackup } = require("../build/backup-status.js");
const { channels } = require("../build/contracts.js");

const folder = () => mkdtempSync(join(realpathSync.native(tmpdir()), "sw-maint-"));
test("verified backup time is per-profile and survives reopen independently of the archive", () => {
  const a = folder(), b = folder();
  assert.equal(readBackupStatus(a), null);
  assert.equal(readBackupStatus(b), null);
  const recent = new Date("2026-11-25T02:00:00.000Z");
  assert.equal(recordSuccessfulBackup(a, recent), recent.toISOString());
  assert.equal(readBackupStatus(a), recent.toISOString());
  assert.equal(readBackupStatus(b), null);
  const later = new Date("2026-11-26T02:00:00.000Z");
  assert.equal(recordSuccessfulBackup(a, later), later.toISOString());
  assert.equal(readBackupStatus(a), later.toISOString());
});

test("backup status rejects invalid or externally linked state without writing its target", () => {
  const dir = folder();
  const stamp = join(dir, "last-verified-backup-v1.txt");
  const protectedFile = join(dir, "protected-sample.txt");
  writeFileSync(protectedFile, "fixture");
  linkSync(protectedFile, stamp);
  assert.equal(readBackupStatus(dir), null);
  assert.throws(() => recordSuccessfulBackup(dir, new Date()), /Invalid backup status/);
  assert.equal(readFileSync(protectedFile, "utf8"), "fixture");
});

test("diagnostic logs rotate within the cap and contain only approved, non-payload fields", () => {
  const dir = folder();
  const cap = 350;
  const logger = new Diagnostics(dir, "0.2.1", cap);
  const sqlite = Object.assign(Error("private payload"), { code: "ERR_SQLITE_ERROR", errcode: 2067 });
  assert.equal(sqliteErrorCode(sqlite), 2067);
  assert.equal(sqliteErrorCode({ code: "ERR_SQLITE_ERROR", errcode: 99 }), undefined);
  assert.equal(sqliteErrorCode(Object.assign(Error(), { code: "ERR_SQLITE_ERROR", errcode: "confidential" })), undefined);
  logger.record("untrusted raw message", "failed");
  for (let i = 0; i < 37; i++) logger.record(channels.saveStudentRecord, "failed", sqliteErrorCode(sqlite));
  const files = readdirSync(dir);
  assert.deepEqual(files.sort(), ["diagnostics.1.jsonl", "diagnostics.2.jsonl", "diagnostics.jsonl"].sort());
  for (const file of files) {
    const path = join(dir, file);
    assert(statSync(path).size <= cap);
    for (const line of readFileSync(path, "utf8").trim().split("\n")) {
      const entry = JSON.parse(line);
      assert.deepEqual(Object.keys(entry).sort(), ["time", "version", "channel", "category", "sqliteCode"].sort());
      assert.equal(entry.channel, channels.saveStudentRecord);
      assert.equal(entry.category, "failed");
      assert.equal(entry.sqliteCode, 2067);
    }
  }
});

test("diagnostic directory failure never propagates to the caller", () => {
  const dir = folder();
  const path = join(dir, "not-a-directory");
  writeFileSync(path, "fixture");
  mkdirSync(join(dir, "diagnostics.jsonl"));
  assert.doesNotThrow(() => new Diagnostics(path, "0.2.1").record(channels.createStudent, "failed"));
  assert.doesNotThrow(() => new Diagnostics(dir, "0.2.1").record(channels.createStudent, "failed"));
  assert.equal(readFileSync(path, "utf8"), "fixture");
});
