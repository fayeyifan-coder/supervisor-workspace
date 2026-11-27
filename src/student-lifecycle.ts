import type { DatabaseSync } from "node:sqlite";
import { WorkspaceFault } from "./workspace-fault";

export const lifecycleLabels = { active: "正常跟进", paused: "暂停学习", archived: "已归档" } as const;
export type LifecycleStatus = keyof typeof lifecycleLabels;
export interface LifecycleInput {
  studentId: string; requestId: string; expectedRevision: number; status: LifecycleStatus; reason: string;
}
export type LifecycleChange = Omit<LifecycleInput, "expectedRevision"> & {
  previousStatus: LifecycleStatus; revision: number; changedAt: number;
};
export interface LifecycleView { studentId: string; status: LifecycleStatus; revision: number; history: LifecycleChange[] }

export const lifecycleSchema = ["student_lifecycle", "table", `CREATE TABLE student_lifecycle (
  request_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
  revision INTEGER NOT NULL CHECK(revision > 0), previous_status TEXT NOT NULL CHECK(previous_status IN ('active','paused','archived')),
  status TEXT NOT NULL CHECK(status IN ('active','paused','archived')), reason TEXT NOT NULL, changed_at INTEGER NOT NULL,
  UNIQUE(student_id, revision), CHECK(previous_status <> status)
) STRICT`] as const;

const columns = "request_id AS requestId, student_id AS studentId, revision, previous_status AS previousStatus, status, reason, changed_at AS changedAt";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid("学生或请求身份无效。");
  return value;
}
function statusOf(value: unknown): LifecycleStatus {
  if (typeof value !== "string" || !Object.hasOwn(lifecycleLabels, value)) invalid("跟进状态无效。");
  return value as LifecycleStatus;
}
function versionOf(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid("跟进状态记录的版本或时间无效。");
  return value;
}
function reasonOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || value.includes("\0")) invalid("请填写 500 字以内的状态变更原因。");
  return value.trim();
}

export function lifecycleInput(raw: unknown): LifecycleInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("跟进状态请求格式无效。");
  const { studentId, requestId, expectedRevision, status, reason } = raw as Record<string, unknown>;
  const version = versionOf(expectedRevision);
  if (version >= Number.MAX_SAFE_INTEGER) invalid("跟进状态版本超过上限。");
  return { studentId: identifier(studentId), requestId: identifier(requestId), expectedRevision: version,
    status: statusOf(status), reason: reasonOf(reason) };
}

function change(row: Record<string, unknown>): LifecycleChange {
  const reason = reasonOf(row.reason);
  if (reason !== row.reason) invalid("跟进状态历史包含未规范化的原因。");
  return { requestId: identifier(row.requestId), studentId: identifier(row.studentId), revision: versionOf(row.revision, 1),
    previousStatus: statusOf(row.previousStatus), status: statusOf(row.status), reason, changedAt: versionOf(row.changedAt) };
}

export function studentLifecycle(db: DatabaseSync, raw: unknown): LifecycleView {
  const studentId = identifier(raw);
  if (!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId)) invalid("找不到所选学生。");
  const history = db.prepare(`SELECT ${columns} FROM student_lifecycle WHERE student_id=? ORDER BY revision DESC`).all(studentId).map(change);
  return { studentId, status: history[0]?.status ?? "active", revision: history[0]?.revision ?? 0, history };
}

export function lifecycleReceipt(db: DatabaseSync, input: LifecycleInput): LifecycleChange | undefined {
  const row = db.prepare(`SELECT ${columns} FROM student_lifecycle WHERE request_id=?`).get(input.requestId);
  if (!row) return;
  const record = change(row);
  if (record.studentId !== input.studentId || record.revision !== input.expectedRevision + 1 ||
      record.status !== input.status || record.reason !== input.reason) {
    throw new WorkspaceFault("conflict", "此请求编号已用于其他跟进状态操作。");
  }
  return record;
}

export function changeStudentLifecycle(db: DatabaseSync, raw: unknown): LifecycleChange {
  const input = lifecycleInput(raw);
  const receipt = lifecycleReceipt(db, input);
  if (receipt) return receipt;
  const prior = studentLifecycle(db, input.studentId);
  if (prior.revision !== input.expectedRevision) throw new WorkspaceFault("conflict", "跟进状态已更新，请核对当前版本。");
  if (prior.status === input.status) invalid("请选择不同的跟进状态。");
  const revision = prior.revision + 1;
  const changedAt = Date.now();
  db.prepare("INSERT INTO student_lifecycle VALUES (?,?,?,?,?,?,?)")
    .run(input.requestId, input.studentId, revision, prior.status, input.status, input.reason, changedAt);
  return { requestId: input.requestId, studentId: input.studentId, revision, previousStatus: prior.status,
    status: input.status, reason: input.reason, changedAt };
}

export function verifyStudentLifecycle(db: DatabaseSync): void {
  let previous: LifecycleChange | undefined;
  for (const row of db.prepare(`SELECT ${columns} FROM student_lifecycle ORDER BY student_id, revision`).iterate()) {
    const next = change(row);
    if (previous?.studentId !== next.studentId) previous = undefined;
    if (next.revision !== (previous?.revision ?? 0) + 1 || next.previousStatus !== (previous?.status ?? "active") ||
        next.status === next.previousStatus) invalid("学生跟进状态历史不连续。");
    previous = next;
  }
}
