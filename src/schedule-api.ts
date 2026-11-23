import type { Student } from "./contracts";
import { WorkspaceFault } from "./database";
import type { OperationsDatabase, SaveAttendancePlanInput } from "./operations";
import { minute, shanghaiParts, weekRange } from "./schedule-calendar";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function invalid(message: string): never {
  throw new WorkspaceFault("invalid", message);
}

export function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid("排课记录或学生 UUID 无效。");
  return value;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("排课请求格式无效。");
  return value as Record<string, unknown>;
}

export function instant(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value % minute !== 0 ||
      value < Date.UTC(1992, 0, 1) - 480 * minute || value >= Date.UTC(9999, 0, 1) - 480 * minute) {
    invalid("排课时间必须是有效的机构日期与分钟。");
  }
  return value;
}

export type StudentList = () => Student[];

export function requireStudent(value: unknown, students: StudentList): string {
  const studentId = id(value);
  if (!students().some(student => student.id === studentId)) invalid("关联的学生档案不存在，请重新选择。");
  return studentId;
}

export function listScheduleWeek(store: OperationsDatabase, students: StudentList, raw: unknown) {
  const query = object(raw);
  const range = weekRange(query.monday);
  if (!range) invalid("排课查询需要合法的机构周一日期。");
  const studentId = query.studentId === undefined ? undefined : requireStudent(query.studentId, students);
  // A failed rollback can leave uncommitted rows visible to this SQLite connection.
  store.protectionConnection();
  return store.listAttendancePlans(range.startAt, range.endAt, studentId);
}

export function readSchedulePlan(store: OperationsDatabase, students: StudentList, raw: unknown) {
  const planId = id(raw);
  store.protectionConnection();
  const plan = store.attendancePlan(planId);
  if (plan) requireStudent(plan.studentId, students);
  return plan ?? null;
}

export function saveSchedulePlan(store: OperationsDatabase, students: StudentList, raw: unknown) {
  const request = object(raw);
  const startAt = instant(request.startAt);
  const endAt = instant(request.endAt);
  if (startAt >= endAt || shanghaiParts(startAt).date !== shanghaiParts(endAt).date) {
    invalid("开始和结束必须在同一个机构日期，且结束晚于开始。");
  }
  const { expectedRevision, kind } = request;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      (kind !== "regular" && kind !== "whole_day")) invalid("排课版本或到校类型无效。");

  let exception: SaveAttendancePlanInput["exception"];
  if (request.exception !== undefined) {
    const approval = object(request.exception);
    if (approval.confirmed !== true || typeof approval.reason !== "string" || approval.reason.length > 500 ||
        !approval.reason.trim() || approval.reason.includes("\0")) invalid("请确认单次例外并填写原因。");
    exception = { confirmed: true, reason: approval.reason };
  }
  return store.saveAttendancePlan({
    id: id(request.id), studentId: requireStudent(request.studentId, students), requestId: id(request.requestId),
    expectedRevision, startAt, endAt, kind, exception,
  });
}
