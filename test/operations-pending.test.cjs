const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, realpathSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { OperationsPending } = require("../build/operations-pending.js");

const code = expected => error => error.code === expected;
const request = () => ({ command: "saveLearningBlock", requestId: randomUUID(), id: randomUUID(), studentId: randomUUID(),
  expectedRevision: 0, attendanceId: randomUUID(), plannedStart: 10, plannedEnd: 20 });
const fixture = () => mkdtempSync(join(realpathSync.native(tmpdir()), "sw-journal-"));

test("pending write accepts only its original command and survives process replacement until acknowledgement", () => {
  const root = fixture(), command = request();
  const first = new OperationsPending(root);
  assert.equal(first.begin(command), command.requestId);
  first.remember(command.requestId);
  const restarted = new OperationsPending(root);
  assert.deepEqual(restarted.state(), { kind: "pending", command });
  assert.equal(restarted.begin(command), command.requestId);
  assert.throws(() => restarted.begin({ ...command, plannedEnd: 30 }), code("recovery"));
  assert.throws(() => restarted.begin(request()), code("recovery"));
  assert.throws(() => restarted.acknowledge(command.requestId, true, () => null), code("unknown"));
  restarted.acknowledge(command.requestId, false, identity => {
    assert.equal(identity.requestId, command.requestId);
    return { revision: 1 };
  });
  assert.deepEqual(restarted.state(), { kind: "empty" });
});

test("missing or tampered intent is blocked until database reconciliation", () => {
  const root = fixture(), command = request(), payload = join(root, "operations-request.json");
  new OperationsPending(root).begin(command);
  writeFileSync(payload, JSON.stringify({ ...command, plannedEnd: 40 }));
  const restarted = new OperationsPending(root);
  assert.equal(restarted.state().kind, "damaged");
  assert.equal(restarted.state().descriptor.requestId, command.requestId);
  assert.throws(() => restarted.begin(command), code("recovery"));
  unlinkSync(payload);
  assert.throws(() => restarted.acknowledge(command.requestId, false, () => null), code("unknown"));
  restarted.acknowledge(command.requestId, true, () => null);
  assert.deepEqual(restarted.state(), { kind: "empty" });
});

test("unreadable marker cannot be replaced by an unrelated request or clear action", () => {
  const root = fixture(), command = request();
  writeFileSync(join(root, "operations-request.pending"), "");
  const journal = new OperationsPending(root);
  assert.equal(journal.state().kind, "damaged");
  assert.equal(journal.state().descriptor, undefined);
  assert.throws(() => journal.begin(command), code("recovery"));
  assert.throws(() => journal.acknowledge(command.requestId, true, () => null), code("recovery"));
});
