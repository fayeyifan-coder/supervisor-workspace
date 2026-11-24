const assert = require("node:assert/strict");
const { writeSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { WorkspaceDatabase } = require("../build/database.js");

const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = execute.call(this, sql);
  if (sql.startsWith("CREATE TABLE students")) {
    assert.equal(this.isTransaction, true);
    writeSync(1, "initialization-open\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};

WorkspaceDatabase.open(process.argv[2], process.argv[3]).close();
throw new Error("Initialization failed to reach the interruption point");
