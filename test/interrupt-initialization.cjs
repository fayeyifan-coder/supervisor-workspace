const assert = require("node:assert/strict");
const { writeSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { SampleDatabase } = require("../build/database.js");

const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = execute.call(this, sql);
  if (sql.startsWith("CREATE TABLE sample_record")) {
    assert.equal(this.isTransaction, true);
    assert.equal(this.prepare("PRAGMA user_version").get().user_version, 0);
    writeSync(1, "migration-open\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};

SampleDatabase.open(process.argv[2], process.argv[3]).close();
throw new Error("First initialization did not reach the interruption point");
