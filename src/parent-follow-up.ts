import type { DatabaseSync } from "node:sqlite";
import { shanghaiMinute } from "./schedule-calendar";
import { WorkspaceFault } from "./workspace-fault";

export const parentRoles = { mother: "母亲", father: "父亲", guardian: "监护人", other: "其他" } as const;
export const parentCategories = { academic: "成绩", habits: "习惯", homework: "作业", schedule: "时间", other: "其他" } as const;
export const parentStatuses = { open: "待跟进", in_progress: "跟进中", resolved: "已结案" } as const;
export interface ParentConcernInput {
  requestId: string;
  studentId: string;
  reportedOn: string;
  role: keyof typeof parentRoles;
  category: keyof typeof parentCategories;
  concern: string;
  nextOn: string;
}
export interface ParentFollowUpInput {
  requestId: string;
  studentId: string;
  concernId: string;
  expectedRevision: number;
  followedOn: string;
  status: keyof typeof parentStatuses;
  note: string;
  nextOn: string;
}
export type ParentFollowUp = Omit<ParentFollowUpInput, "expectedRevision"> & { revision: number; recordedAt: number };
export type ParentConcern = ParentConcernInput & { recordedAt: number };
export type ParentConcernHistory = ParentConcern & { followUps: ParentFollowUp[] };
export interface ParentFollowUpView {
  studentId: string;
  concerns: ParentConcernHistory[];
}

export const parentSchema = [
  ["parent_concerns", "table", `CREATE TABLE parent_concerns (
    request_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    reported_on TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('mother','father','guardian','other')),
    category TEXT NOT NULL CHECK(category IN ('academic','habits','homework','schedule','other')),
    concern TEXT NOT NULL, next_on TEXT NOT NULL, recorded_at INTEGER NOT NULL
  ) STRICT`],
  ["parent_followups", "table", `CREATE TABLE parent_followups (
    request_id TEXT PRIMARY KEY, concern_id TEXT NOT NULL REFERENCES parent_concerns(request_id),
    revision INTEGER NOT NULL CHECK(revision > 0), followed_on TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')),
    note TEXT NOT NULL, next_on TEXT NOT NULL, recorded_at INTEGER NOT NULL, UNIQUE(concern_id, revision)
  ) STRICT`],
] as const;

const concernColumns = "request_id AS requestId, student_id AS studentId, reported_on AS reportedOn, role, category, concern, next_on AS nextOn, recorded_at AS recordedAt";
const followUpColumns = "f.request_id AS requestId, c.student_id AS studentId, f.concern_id AS concernId, f.revision, f.followed_on AS followedOn, f.status, f.note, f.next_on AS nextOn, f.recorded_at AS recordedAt";
const joined = " FROM parent_followups f JOIN parent_concerns c ON c.request_id=f.concern_id";

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }
function conflict(message: string): never { throw new WorkspaceFault("conflict", message); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("家长诉求表单无效。");
  return input as Record<string, unknown>;
}
function id(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)) {
    invalid("学生或请求编号无效。");
  }
  return input;
}
function date(input: unknown): string {
  if (typeof input !== "string" || shanghaiMinute(input, "00:00") === null) invalid("请选择有效的机构日期。");
  return input;
}
function nextDate(input: unknown, on: string): string {
  if (input === "") return "";
  const next = date(input);
  if (next < on) invalid("下次跟进日期不能早于本次记录日期。");
  return next;
}
function detail(input: unknown): string {
  if (typeof input !== "string" || input.length > 1000 || input.includes("\0") || !input.trim()) {
    invalid("请输入 1 至 1000 字的诉求或跟进说明。");
  }
  return input.trim();
}
function select<T extends string>(input: unknown, labels: Record<T, string>): T {
  if (typeof input !== "string" || !Object.hasOwn(labels, input)) invalid("家长诉求来源、类别或状态无效。");
  return input as T;
}
function concernInput(input: unknown): ParentConcernInput {
  const row = object(input), reportedOn = date(row.reportedOn);
  return { requestId: id(row.requestId), studentId: id(row.studentId), reportedOn,
    role: select(row.role, parentRoles), category: select(row.category, parentCategories),
    concern: detail(row.concern), nextOn: nextDate(row.nextOn, reportedOn) };
}
function followUpInput(input: unknown): ParentFollowUpInput {
  const row = object(input), followedOn = date(row.followedOn);
  const revision = row.expectedRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    invalid("跟进版本无效。");
  }
  return { requestId: id(row.requestId), studentId: id(row.studentId), concernId: id(row.concernId),
    expectedRevision: revision, followedOn, status: select(row.status, parentStatuses),
    note: detail(row.note), nextOn: nextDate(row.nextOn, followedOn) };
}
function requireStudent(db: DatabaseSync, studentId: string): void {
  if (!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId)) invalid("找不到关联的学生。");
}
function concernById(db: DatabaseSync, requestId: string): ParentConcern | undefined {
  const row = db.prepare("SELECT " + concernColumns + " FROM parent_concerns WHERE request_id=?").get(requestId);
  return row && { ...concernInput(row), recordedAt: Number(row.recordedAt) };
}
function match(input: object, row: object): boolean {
  return Object.entries(input).every(([key, value]) => Reflect.get(row, key) === value);
}
function checkedRecordedAt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) invalid("家长跟进保存时间无效。");
}

export function readParentFollowUp(db: DatabaseSync, raw: unknown): ParentFollowUpView {
  const studentId = id(raw);
  requireStudent(db, studentId);
  const rows = db.prepare("SELECT " + concernColumns + " FROM parent_concerns WHERE student_id=? ORDER BY reported_on DESC,recorded_at DESC,request_id")
    .all(studentId).map((row): ParentConcernHistory => ({ ...concernInput(row), recordedAt: Number(row.recordedAt), followUps: [] }));
  const byId = new Map(rows.map(row => [row.requestId, row]));
  const followUps = db.prepare("SELECT " + followUpColumns + joined + " WHERE c.student_id=? ORDER BY f.concern_id,f.revision DESC");
  for (const row of followUps.iterate(studentId)) byId.get(String(row.concernId))?.followUps.push({ ...row } as ParentFollowUp);
  return { studentId, concerns: rows };
}

export function createParentConcern(db: DatabaseSync, raw: unknown): ParentConcern {
  const input = concernInput(raw);
  const existing = concernById(db, input.requestId);
  if (existing) {
    if (!match(input, existing)) conflict("请求编号已用于其他诉求。");
    return existing;
  }
  if (db.prepare("SELECT 1 FROM parent_followups WHERE request_id=?").get(input.requestId)) conflict("请求编号已用于跟进。");
  requireStudent(db, input.studentId);
  const recordedAt = Date.now();
  db.prepare("INSERT INTO parent_concerns VALUES (?,?,?,?,?,?,?,?)").run(input.requestId, input.studentId,
    input.reportedOn, input.role, input.category, input.concern, input.nextOn, recordedAt);
  return { ...input, recordedAt };
}

export function appendParentFollowUp(db: DatabaseSync, raw: unknown): ParentFollowUp {
  const { expectedRevision, ...input } = followUpInput(raw);
  const concern = concernById(db, input.concernId);
  if (!concern || concern.studentId !== input.studentId) return invalid("诉求与当前学生不一致。");
  const existing = db.prepare("SELECT " + followUpColumns + joined + " WHERE f.request_id=?").get(input.requestId);
  if (existing) {
    if (existing.revision !== expectedRevision + 1 || !match(input, existing)) conflict("请求编号已用于其他跟进内容。");
    return { ...existing } as ParentFollowUp;
  }
  if (concernById(db, input.requestId)) conflict("请求编号已用于新建诉求。");
  const previous = db.prepare("SELECT revision, followed_on FROM parent_followups WHERE concern_id=? ORDER BY revision DESC LIMIT 1").get(input.concernId);
  if ((previous?.revision ?? 0) !== expectedRevision) conflict("跟进已更新，请核对最新记录后再保存。");
  if (input.followedOn < String(previous?.followed_on ?? concern.reportedOn)) invalid("跟进日期不能早于上一条记录。");
  const revision = expectedRevision + 1, recordedAt = Date.now();
  db.prepare("INSERT INTO parent_followups VALUES (?,?,?,?,?,?,?,?)").run(input.requestId, input.concernId,
    revision, input.followedOn, input.status, input.note, input.nextOn, recordedAt);
  return { ...input, revision, recordedAt };
}

export function verifyParentFollowUp(db: DatabaseSync): void {
  const cases = new Map<string, { revision: number; on: string }>();
  for (const row of db.prepare("SELECT " + concernColumns + " FROM parent_concerns").iterate()) {
    const concern = concernInput(row);
    checkedRecordedAt(Number(row.recordedAt));
    if (!match(concern, row)) invalid("家长诉求与已保存的内容不一致。");
    cases.set(concern.requestId, { revision: 0, on: concern.reportedOn });
  }
  for (const row of db.prepare("SELECT " + followUpColumns + joined + " ORDER BY f.concern_id,f.revision").iterate()) {
    const { expectedRevision, ...followUp } = followUpInput({ ...row, expectedRevision: Number(row.revision) - 1 });
    const previous = cases.get(followUp.concernId);
    checkedRecordedAt(Number(row.recordedAt));
    if (!previous || previous.revision !== expectedRevision || followUp.followedOn < previous.on ||
        cases.has(followUp.requestId) || !match(followUp, row)) invalid("家长跟进历史存在不连续或重复请求。");
    cases.set(followUp.concernId, { revision: expectedRevision + 1, on: followUp.followedOn });
  }
}
