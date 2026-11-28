import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceFault, type WorkspaceDatabase } from "./database";
import { operationsProtectionFor, verifyOperationsStudentLinks, type OperationsLayout } from "./operations-schema";
import { dateApplies, type CycleRule, persistCycleRule, persistScheduleHours, rangeFitsHours,
  recurringConfiguration, scheduleCommand, stableScheduleId, storedScheduleHours,
  type CycleKind, type CycleResult, type DayException, type DayExceptionAction, type FlexWindow, type GenerationResult, type ScheduleConfiguration, type ScheduleOrigin } from "./recurring-schedule";
import { isExpectedVisit, minute, openingHours, shanghaiMinute, shanghaiParts, shiftDate } from "./schedule-calendar";

export { operationsProtection, verifyOperationsStudentLinks } from "./operations-schema";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const planColumns = `id, student_id AS studentId, start_at AS startAt, end_at AS endAt, kind, status,
  check_in_at AS checkInAt, check_out_at AS checkOutAt, exception_reason AS exceptionReason,
  revision, created_at AS createdAt, updated_at AS updatedAt`;
const blockColumns = `id, student_id AS studentId, attendance_plan_id AS attendancePlanId,
  planned_start AS plannedStart, planned_end AS plannedEnd, actual_start AS actualStart, actual_end AS actualEnd,
  status, outside_attendance_reason AS outsideAttendanceReason, notes, revision,
  created_at AS createdAt, updated_at AS updatedAt`;
const taskColumns = `id, position, category, subject, content, knowledge_points AS knowledgePoints,
  planned_target AS plannedTarget, status, result_notes AS resultNotes, completed_at AS completedAt`;

type PlanKind = "regular" | "whole_day";
type PlanStatus = "planned" | "confirmed" | "attended" | "absent" | "cancelled";
type BlockStatus = "planned" | "in_progress" | "done" | "cancelled";
type TaskStatus = "planned" | "in_progress" | "done" | "skipped";
type TaskCategory = "foundation" | "synchronous" | "targeted_test" | "home_school";

interface ChangeInput {
  requestId: string;
  id: string;
  studentId: string;
  expectedRevision: number;
}

export interface SaveAttendancePlanInput extends ChangeInput {
  startAt: number;
  endAt?: number;
  kind?: PlanKind;
  exception?: { confirmed: true; reason: string };
  changeReason?: string;
}

export interface AttendancePlan {
  cycleKind?: CycleKind;
  cycleOrigin?: ScheduleOrigin;
  dayException?: DayException;
  actualOnly?: boolean;
  id: string;
  studentId: string;
  startAt: number;
  endAt: number;
  kind: PlanKind;
  status: PlanStatus;
  checkInAt: number | null;
  checkOutAt: number | null;
  exceptionReason: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface LearningTaskInput {
  id: string;
  category: TaskCategory;
  content: string;
  subject?: string;
  knowledgePoints?: string;
  plannedTarget?: string;
}

export interface LearningTask extends Omit<LearningTaskInput, "subject" | "knowledgePoints" | "plannedTarget"> {
  position: number;
  subject: string | null;
  knowledgePoints: string | null;
  plannedTarget: string | null;
  status: TaskStatus;
  resultNotes: string | null;
  completedAt: number | null;
}

export interface LearningBlock {
  id: string;
  studentId: string;
  attendancePlanId: string | null;
  plannedStart: number;
  plannedEnd: number;
  actualStart: number | null;
  actualEnd: number | null;
  status: BlockStatus;
  outsideAttendanceReason: string | null;
  notes: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  tasks: LearningTask[];
}

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }
function conflict(message: string): never { throw new WorkspaceFault("conflict", message); }
function recovery(message: string): never { throw new WorkspaceFault("recovery", message); }

function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid("教务记录或学生 UUID 无效。");
  return value;
}

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) {
    invalid("教务文本内容或长度无效。");
  }
  return value.trim();
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= 253402214400000) {
    invalid("教务时间无效。");
  }
  return value;
}

function identity(input: ChangeInput): ChangeInput {
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    invalid("教务记录版本无效。");
  }
  return { id: id(input.id), studentId: id(input.studentId), requestId: id(input.requestId), expectedRevision: input.expectedRevision };
}

function planningWindow(start: number, end: number): boolean {
  const from = shanghaiParts(start), until = shanghaiParts(end);
  if (start >= end || from.date !== until.date || start % minute !== 0 || end % minute !== 0) {
    invalid("计划须为同一机构日期内的正向分钟区间。");
  }
  const hours = openingHours(from.date);
  return hours !== null && from.time >= hours.start && until.time <= hours.end;
}

function plainFile(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync.native(path) !== path) {
    recovery("教务库文件路径无效，请保留原目录。");
  }
  return true;
}

function verifySchema(db: DatabaseSync, layout: OperationsLayout): void {
  const schema = "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name";
  const expected = new DatabaseSync(":memory:");
  try {
    for (const sql of layout.ddl) expected.exec(sql);
    if (db.prepare("PRAGMA application_id").get()?.application_id !== layout.applicationId ||
        db.prepare("PRAGMA user_version").get()?.user_version !== layout.version ||
        JSON.stringify(db.prepare(schema).all()) !== JSON.stringify(expected.prepare(schema).all()) ||
        db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
      recovery("教务数据库身份、Schema 或完整性无法确认。");
    }
  } finally { expected.close(); }
}

function verifyHeader(path: string, layout: OperationsLayout): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== layout.applicationId ||
        header.readUInt32BE(60) !== layout.version) recovery("教务数据库身份无法确认。");
  } finally { closeSync(fd); }
}

type ScheduleStudents = Pick<WorkspaceDatabase, "students"> & Partial<Pick<WorkspaceDatabase, "version" | "hasPlanTaskLink">>;

export class OperationsDatabase {
  private writesBlocked = false;

  private constructor(private readonly db: DatabaseSync, private readonly m1: ScheduleStudents) {}

  get recurringEnabled(): boolean { return (this.m1.version ?? 0) >= 9; }
  get flexibilityEnabled(): boolean { return (this.m1.version ?? 0) >= 10; }

  static open(dataDirectory: string, m1: ScheduleStudents, allowInitialize = false): OperationsDatabase {
    const layout = operationsProtectionFor(m1.version ?? 1);
    const directory = resolve(dataDirectory);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync.native(directory) !== directory) {
      recovery("教务数据库需要已存在的独立数据目录。");
    }
    const path = join(directory, "operations.sqlite3"), marker = join(directory, "operations.initialized");
    const exists = plainFile(path), initialized = plainFile(marker);
    const sidecars = ["-wal", "-shm", "-journal"].map(suffix => plainFile(path + suffix));
    if (exists !== initialized || (!exists && (!allowInitialize || sidecars.some(Boolean)))) {
      recovery("教务库初始化文件不完整，请保留主库、标记和侧车。");
    }
    if (exists) {
      if (lstatSync(marker).size !== layout.marker.length ||
          readFileSync(marker, "utf8") !== layout.marker) recovery("教务库初始化标记无效。");
      verifyHeader(path, layout);
    } else closeSync(openSync(path, "wx"));

    const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500 });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
      if (!exists) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const sql of layout.ddl) db.exec(sql);
          db.exec(`PRAGMA application_id=${layout.applicationId}; PRAGMA user_version=${layout.version}`);
          verifySchema(db, layout);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } else verifySchema(db, layout);
      verifyOperationsStudentLinks(db, new Set(m1.students().map(student => student.id)));
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") recovery("无法启用教务数据库 WAL。");
      if (!initialized) writeFileSync(marker, layout.marker, { flag: "wx", flush: true });
      return new OperationsDatabase(db, m1);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  attendancePlan(planId: string): AttendancePlan | undefined {
    const row = this.db.prepare("SELECT " + planColumns + " FROM attendance_plans WHERE id=?").get(id(planId));
    return row ? this.withScheduleOrigin({ ...row } as unknown as AttendancePlan) : undefined;
  }

  listAttendancePlans(startAt: number, endAt: number, studentId?: string): AttendancePlan[] {
    if (timestamp(startAt) >= timestamp(endAt)) invalid("排课查询区间无效。");
    const criteria = studentId === undefined ? "" : " AND student_id=?";
    const params = studentId === undefined ? [endAt, startAt] : [endAt, startAt, id(studentId)];
    return this.db.prepare("SELECT " + planColumns + " FROM attendance_plans WHERE start_at<? AND end_at>?" +
      criteria + " ORDER BY start_at,id").all(...params).map(row => this.withScheduleOrigin({ ...row } as unknown as AttendancePlan));
  }

  private withScheduleOrigin(plan: AttendancePlan): AttendancePlan {
    if (!this.recurringEnabled) return plan;
    const origin = this.db.prepare(`SELECT rule_id AS ruleId,rule_revision AS revision,slot_id AS slotId,occurrence_date AS date,
      json_extract(definition_json,'$.kind') AS kind FROM schedule_origins o
      JOIN schedule_rule_revisions r ON r.id=o.rule_id AND r.revision=o.rule_revision
      WHERE o.plan_id=?`).get(plan.id);
    const exception = this.flexibilityEnabled ? this.db.prepare("SELECT action,reason FROM attendance_exceptions WHERE plan_id=? ORDER BY revision DESC LIMIT 1").get(plan.id) : undefined;
    const details = exception ? { dayException: exception as unknown as DayException, ...(exception.action === "walk_in" ? { actualOnly: true } : {}) } : {};
    if (!origin) return { ...plan, ...details };
    const { kind, ...cycleOrigin } = origin;
    return { ...plan, ...details, cycleKind: kind as CycleKind, cycleOrigin: cycleOrigin as unknown as ScheduleOrigin };
  }

  scheduleConfiguration(): ScheduleConfiguration {
    if (!this.recurringEnabled) recovery("当前档案尚未启用周期排课。");
    return recurringConfiguration(this.protectionConnection());
  }

  private *cycleSlots(rules: readonly CycleRule[], from: string, to: string) {
    const byRule = new Map<string, CycleRule[]>();
    for (const rule of rules) {
      const revisions = byRule.get(rule.id) ?? [];
      revisions.push(rule);
      byRule.set(rule.id, revisions);
    }
    // An already generated rule/date remains on its original revision, even if slots later change identity.
    const pinned = new Map(this.db.prepare(`SELECT rule_id,occurrence_date,min(rule_revision) AS revision
      FROM schedule_origins WHERE occurrence_date BETWEEN ? AND ? GROUP BY rule_id,occurrence_date`)
      .all(from, to).map(row => [row.rule_id + "/" + row.occurrence_date, row.revision]));
    for (const [id, revisions] of byRule) {
      for (let date = from; date <= to; date = shiftDate(date, 1)) {
        const revision = pinned.get(id + "/" + date);
        const rule = revisions.find(row => revision === undefined ? row.startsOn <= date : row.revision === revision);
        if (!rule) continue;
        for (const slot of rule.slots) if (dateApplies(rule, date, slot)) yield { rule, date, slot };
      }
    }
  }

  changeCycleSchedule(raw: unknown): CycleResult {
    this.scheduleConfiguration();
    const command = scheduleCommand(raw);
    if (command.action === "walkIn") {
      if (!this.flexibilityEnabled) recovery("当前档案尚未启用临时签到。");
      const planId = stableScheduleId("walk-in", command.requestId);
      const change = identity({ id: planId, requestId: command.requestId, studentId: command.studentId, expectedRevision: 0 });
      return { action: "visit", plan: this.createArrival(change, command.durationMinutes) };
    }
    if (command.action === "confirmFlex" || command.action === "arriveFlex") {
      if (!this.flexibilityEnabled) recovery("当前档案尚未启用弹性安排。");
      const origin = command.window;
      const planId = stableScheduleId("plan", origin.ruleId, origin.slotId, origin.date);
      const existing = this.attendancePlan(planId);
      if (existing) {
        if (!existing.cycleOrigin || (command.action === "confirmFlex" && shanghaiMinute(origin.date, command.start) !== existing.startAt)) {
          conflict("该窗口已有具体安排，请打开原安排核对或调整。");
        }
        if (command.action === "arriveFlex" && existing.status !== "attended") conflict("该窗口已有预约，请从原安排签到。");
        return { action: "visit", plan: existing };
      }
      const window = this.flexWindows(origin.date, origin.date).find(row => row.id === planId && row.revision === origin.revision);
      if (!window) conflict("弹性窗口已有变化，请重新读取。");
      const change = identity({ id: planId, requestId: stableScheduleId("request", origin.ruleId, origin.slotId, origin.date),
        studentId: window.studentId, expectedRevision: 0 });
      if (command.action === "arriveFlex") return { action: "visit", plan: this.createArrival(change, window.durationMinutes, window) };
      const startAt = shanghaiMinute(origin.date, command.start)!;
      const endAt = startAt + window.durationMinutes * minute;
      if (startAt < shanghaiMinute(origin.date, window.start)! || endAt > shanghaiMinute(origin.date, window.end)!) {
        invalid("具体预约须落在该窗口内，并覆盖预计学习时长。");
      }
      return { action: "visit", plan: this.saveAttendancePlan({ ...change, startAt, endAt }, origin, true) };
    }
    if (command.action === "generate") {
      if (command.studentId && !this.m1.students().some(row => row.id === command.studentId)) invalid("找不到关联的学生。");
      const configuration = this.scheduleConfiguration();
      const students = new Map(this.m1.students().map(student => [student.id, student]));
      const result: GenerationResult = { created: 0, existing: 0, inactive: 0, conflicts: 0, elapsed: 0 };
      const originExists = this.db.prepare("SELECT 1 FROM schedule_origins WHERE plan_id=?");
      for (const { rule, date, slot } of this.cycleSlots(configuration.rules, command.from, command.to)) {
        if (rule.kind === "flex" || (command.studentId && command.studentId !== rule.studentId)) continue;
        const origin = { ruleId: rule.id, revision: rule.revision, slotId: slot.id, date };
        const planId = stableScheduleId("plan", rule.id, slot.id, date);
        if (originExists.get(planId)) { result.existing++; continue; }
        if (rule.paused || students.get(rule.studentId)?.lifecycleStatus !== "active") { result.inactive++; continue; }
        const startAt = shanghaiMinute(date, slot.start)!, endAt = shanghaiMinute(date, slot.end)!;
        if (startAt <= Date.now()) { result.elapsed++; continue; }
        if (!rangeFitsHours(startAt, endAt, configuration.hours)) { result.conflicts++; continue; }
        try {
          this.saveAttendancePlan({ id: planId, studentId: rule.studentId, expectedRevision: 0, startAt, endAt,
            requestId: stableScheduleId("request", rule.id, slot.id, date) }, origin);
          result.created++;
        } catch (error) {
          if (!(error instanceof WorkspaceFault) || error.code !== "conflict") throw error;
          result.conflicts++;
        }
      }
      return { action: "generate", result };
    }
    return this.transact(() => {
      if (command.action === "hours") return { action: "hours", revision: persistScheduleHours(this.db, command, Date.now()) };
      if (!this.m1.students().some(student => student.id === command.studentId)) invalid("找不到关联的学生。");
      if (command.definition.kind === "flex" && !this.flexibilityEnabled) recovery("当前档案尚未启用弹性安排。");
      return { action: "rule", rule: persistCycleRule(this.db, command, Date.now()) };
    });
  }

  flexWindows(from: string, to: string, studentId?: string): FlexWindow[] {
    if (!this.flexibilityEnabled) return [];
    const range = scheduleCommand({ action: "generate", from, to, studentId });
    if (range.action !== "generate") invalid("弹性查询区间无效。");
    const active = new Set(this.m1.students().filter(row => row.lifecycleStatus === "active").map(row => row.id));
    const pending: FlexWindow[] = [];
    const originExists = this.db.prepare("SELECT 1 FROM schedule_origins WHERE plan_id=?");
    for (const { rule, date, slot } of this.cycleSlots(this.scheduleConfiguration().rules, range.from, range.to)) {
      if (rule.kind !== "flex" || rule.paused || !active.has(rule.studentId) || (studentId && rule.studentId !== studentId)) continue;
      const id = stableScheduleId("plan", rule.id, slot.id, date);
      if (originExists.get(id)) continue;
      pending.push({ id, studentId: rule.studentId, date, ruleId: rule.id, revision: rule.revision, slotId: slot.id,
        start: slot.start, end: slot.end, durationMinutes: rule.durationMinutes! });
    }
    return pending.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  }

  // Print previews use recorded plans first. Future occurrences can be previewed without creating attendance rows.
  plannedSigninVisits(from: string, to: string, now = Date.now()) {
    if (!this.flexibilityEnabled) recovery("当前档案尚未启用签到表。");
    const range = scheduleCommand({ action: "generate", from, to });
    if (range.action !== "generate") invalid("签到表日期无效。");
    const fromAt = shanghaiMinute(range.from, "00:00")!, toAt = shanghaiMinute(shiftDate(range.to, 1), "00:00")!;
    const plans = this.listAttendancePlans(fromAt, toAt);
    const visits: { studentId: string; startAt: number; endAt: number; source: "appointment" | "rule" }[] =
      plans.filter(isExpectedVisit).map(({ studentId, startAt, endAt }) => ({ studentId, startAt, endAt, source: "appointment" }));
    const occupying = plans.filter(plan => plan.status !== "cancelled" && plan.status !== "absent")
      .map(({ studentId, startAt, endAt }) => ({ studentId, startAt, endAt }));
    const conflicts: { studentId: string; startAt: number; endAt: number }[] = [];
    const active = new Set(this.m1.students().filter(row => row.lifecycleStatus === "active").map(row => row.id));
    const config = this.scheduleConfiguration();
    const originExists = this.db.prepare("SELECT 1 FROM schedule_origins WHERE plan_id=?");
    for (const { rule, date, slot } of this.cycleSlots(config.rules, range.from, range.to)) {
      if (rule.kind === "flex" || rule.paused || !active.has(rule.studentId)) continue;
      const startAt = shanghaiMinute(date, slot.start)!, endAt = shanghaiMinute(date, slot.end)!;
      if (startAt <= now || originExists.get(stableScheduleId("plan", rule.id, slot.id, date))) continue;
      const visit = { studentId: rule.studentId, startAt, endAt };
      if (!rangeFitsHours(startAt, endAt, config.hours) ||
        occupying.some(plan => plan.studentId === rule.studentId && plan.startAt < endAt && plan.endAt > startAt)) {
        conflicts.push(visit);
      } else {
        visits.push({ ...visit, source: "rule" });
        occupying.push(visit);
      }
    }
    return { visits, conflicts };
  }

  private recordException(change: ChangeInput, action: DayExceptionAction, reason: string, now: number) {
    this.db.prepare("INSERT INTO attendance_exceptions VALUES(?,?,?,?,?,?)")
      .run(change.id, change.expectedRevision + 1, change.requestId, action, reason, now);
  }

  private createArrival(change: ChangeInput, durationMinutes: number, window?: FlexWindow): AttendancePlan {
    return this.write("registerArrival", "attendance", change, { durationMinutes, window: window?.id }, now => {
      this.checkRevision(this.attendancePlan(change.id), change);
      const date = shanghaiParts(now).date, startAt = Math.floor(now / minute) * minute;
      const endAt = startAt + durationMinutes * minute;
      if (shanghaiParts(endAt).date !== date) invalid("请缩短预计时长，临时到课须在同日。");
      if (window && (window.date !== date || now < shanghaiMinute(date, window.start)! || now >= shanghaiMinute(date, window.end)!)) {
        conflict("目前不在这个弹性窗口，可登记当日临时到课。");
      }
      if (this.db.prepare(`SELECT 1 FROM attendance_plans WHERE student_id=? AND status NOT IN ('cancelled','absent')
          AND ((status='attended' AND check_out_at IS NULL) OR (start_at<? AND end_at>?)) LIMIT 1`)
          .get(change.studentId, endAt, startAt)) conflict("已有可关联的安排或未签退记录，请打开原安排。");
      const within = rangeFitsHours(startAt, endAt, storedScheduleHours(this.db));
      const reason = window ? "未预约弹性到课" : "当日临时到课";
      this.db.prepare(`INSERT INTO attendance_plans
        (id,student_id,start_at,end_at,kind,status,check_in_at,outside_window,exception_reason,revision,created_at,updated_at)
        VALUES(?,?,?,?,'regular','attended',?,?,?,1,?,?)`)
        .run(change.id, change.studentId, startAt, endAt, now, Number(!within), within ? null : reason, now, now);
      if (window) this.db.prepare("INSERT INTO schedule_origins VALUES(?,?,?,?,?)")
        .run(change.id, window.ruleId, window.revision, window.slotId, window.date);
      this.recordException(change, "walk_in", reason, now);
      return this.attendancePlan(change.id)!;
    });
  }

  saveAttendancePlan(input: SaveAttendancePlanInput, origin?: ScheduleOrigin, confirmedFlex = false): AttendancePlan {
    const change = identity(input), startAt = timestamp(input.startAt), kind = input.kind ?? "regular";
    if (kind !== "regular" && kind !== "whole_day") invalid("到校类型无效。");
    const endAt = timestamp(input.endAt ?? (kind === "regular" ? startAt + 120 * minute : undefined));
    const legacyWindow = planningWindow(startAt, endAt);
    const inWindow = this.recurringEnabled ? rangeFitsHours(startAt, endAt, storedScheduleHours(this.db)) : legacyWindow;
    let exceptionReason: string | null = null;
    if (!inWindow) {
      if (input.exception?.confirmed !== true) invalid("默认时段外的单次排课需要明确确认。");
      exceptionReason = text(input.exception.reason, 500, true);
    }
    const changeReason = this.flexibilityEnabled && input.changeReason !== undefined ? text(input.changeReason, 500, true) : undefined;
    return this.write(confirmedFlex ? "confirmFlex" : origin ? "generateScheduleOccurrence" : "saveAttendancePlan", "attendance", change,
      { startAt, endAt, kind, exceptionReason, ...(origin ? { origin } : {}), ...(changeReason ? { changeReason } : {}) }, now => {
      if (origin && !this.m1.students().some(student => student.id === change.studentId && student.lifecycleStatus === "active")) {
        conflict("该学生已暂停或归档，请人工核对既有安排。");
      }
      const current = this.attendancePlan(change.id);
      this.checkRevision(current, change);
      if (startAt <= now || (current && (current.startAt <= now || !["planned", "confirmed"].includes(current.status)))) {
        conflict("已开始或已发生的到校安排不能改期。");
      }
      if (current && this.db.prepare("SELECT 1 FROM learning_blocks WHERE attendance_plan_id=? AND actual_start IS NOT NULL LIMIT 1")
        .get(change.id)) conflict("已有实际学习记录的到校安排不能改期。");
      if (current && this.db.prepare(`SELECT 1 FROM learning_blocks WHERE attendance_plan_id=?
          AND status<>'cancelled' AND outside_attendance_reason IS NULL AND (planned_start<? OR planned_end>?) LIMIT 1`)
        .get(change.id, startAt, endAt)) conflict("新时段未覆盖已有学习块，请先核对学习块。");
      if (this.db.prepare(`SELECT 1 FROM attendance_plans WHERE student_id=? AND id<>?
          AND status NOT IN ('cancelled','absent') AND start_at<? AND end_at>? LIMIT 1`).get(
        change.studentId, change.id, endAt, startAt)) conflict("同一学生已有重叠的到校安排。");
      this.db.prepare(`INSERT INTO attendance_plans
        (id,student_id,start_at,end_at,kind,status,outside_window,exception_reason,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,
        end_at=excluded.end_at,kind=excluded.kind,outside_window=excluded.outside_window,
        exception_reason=excluded.exception_reason,revision=attendance_plans.revision+1,updated_at=excluded.updated_at`)
        .run(change.id, change.studentId, startAt, endAt, kind, confirmedFlex ? "confirmed" : "planned", Number(!inWindow), exceptionReason, now, now);
      if (origin) this.db.prepare("INSERT INTO schedule_origins VALUES(?,?,?,?,?)")
        .run(change.id, origin.ruleId, origin.revision, origin.slotId, origin.date);
      if (this.flexibilityEnabled && current && (current.startAt !== startAt || current.endAt !== endAt)) {
        this.recordException(change, "rescheduled", changeReason ?? "单次调整", now);
      }
      return this.attendancePlan(change.id)!;
    });
  }

  recordAttendance(input: ChangeInput & {
    action: "confirm" | "checkIn" | "checkOut" | "absent" | "cancel" | "leave"; at?: number; reason?: string;
  }): AttendancePlan {
    const change = identity(input), action = input.action;
    const at = input.at === undefined ? null : timestamp(input.at);
    if (!["confirm", "checkIn", "checkOut", "absent", "cancel", "leave"].includes(action) ||
        (action === "leave" && !this.flexibilityEnabled) ||
        (at !== null && action !== "checkIn" && action !== "checkOut")) invalid("出勤操作无效。");
    const note = action === "leave" ? text(input.reason, 500, true) : action === "cancel" && this.flexibilityEnabled
      ? text(input.reason ?? "单次取消", 500, true) : undefined;
    return this.write("recordAttendance", "attendance", change, { action, at, ...(note ? { note } : {}) }, now => {
      const current = this.attendancePlan(change.id);
      if (!current) invalid("找不到到校安排。");
      this.checkRevision(current, change);
      const actualAt = at ?? now;
      if (actualAt > now) invalid("出勤事实不能发生在未来。");
      const waiting = current.status === "planned" || current.status === "confirmed";
      let status: PlanStatus;
      let { checkInAt, checkOutAt } = current;
      switch (action) {
        case "confirm":
          if (current.status !== "planned" || now >= current.startAt) conflict("该到校安排不能确认。");
          status = "confirmed";
          break;
        case "checkIn":
          if (!waiting || (this.flexibilityEnabled && shanghaiParts(actualAt).date !== shanghaiParts(current.startAt).date)) {
            conflict("该到校安排与实际签到日期或状态不符。");
          }
          status = "attended";
          checkInAt = actualAt;
          break;
        case "checkOut":
          if (current.status !== "attended" || checkInAt === null || checkOutAt !== null || actualAt < checkInAt) {
            conflict("该到校安排不能签退。");
          }
          if (this.hasLearningInProgress(change.id)) conflict("请先结束进行中的学习块，再签退。");
          status = "attended";
          checkOutAt = actualAt;
          break;
        case "absent":
          if (!waiting || now < current.startAt || this.db.prepare(
            "SELECT 1 FROM learning_blocks WHERE attendance_plan_id=? AND actual_start IS NOT NULL LIMIT 1").get(change.id)) {
            conflict("该到校安排不能标记缺席，请核对已有学习或出勤记录。");
          }
          status = "absent";
          break;
        case "leave":
        case "cancel":
          if (!waiting || (action === "cancel" && now >= current.startAt) || this.db.prepare(
            "SELECT 1 FROM learning_blocks WHERE attendance_plan_id=? AND status<>'cancelled' LIMIT 1").get(change.id)) {
            conflict("该到校安排不能取消，请核对已有学习块和出勤。");
          }
          status = "cancelled";
          break;
      }
      this.db.prepare(`UPDATE attendance_plans SET status=?,check_in_at=?,check_out_at=?,revision=revision+1,updated_at=? WHERE id=?`)
        .run(status, checkInAt, checkOutAt, now, change.id);
      if (note) this.recordException(change, action === "leave" ? "leave" : "cancelled", note, now);
      return this.attendancePlan(change.id)!;
    });
  }

  learningBlock(blockId: string): LearningBlock | undefined {
    const row = this.db.prepare("SELECT " + blockColumns + " FROM learning_blocks WHERE id=?").get(id(blockId));
    if (!row) return;
    const tasks = this.db.prepare("SELECT " + taskColumns + " FROM learning_tasks WHERE block_id=? ORDER BY position")
      .all(blockId).map(task => ({ ...task })) as unknown as LearningTask[];
    return { ...row, tasks } as unknown as LearningBlock;
  }

  hasLearningInProgress(planId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM learning_blocks WHERE attendance_plan_id=? AND status='in_progress' LIMIT 1")
      .get(id(planId)));
  }

  learningBlocksForAttendance(planId: string): LearningBlock[] {
    return this.db.prepare("SELECT id FROM learning_blocks WHERE attendance_plan_id=? ORDER BY planned_start,id")
      .all(id(planId)).map(row => this.learningBlock(row.id as string)!);
  }

  saveLearningBlock(input: ChangeInput & {
    attendancePlanId?: string | null; plannedStart: number; plannedEnd: number; outsideAttendanceReason?: string; notes?: string;
  }): LearningBlock {
    const change = identity(input), attendancePlanId = input.attendancePlanId == null ? null : id(input.attendancePlanId);
    const plannedStart = timestamp(input.plannedStart), plannedEnd = timestamp(input.plannedEnd);
    planningWindow(plannedStart, plannedEnd);
    const outsideAttendanceReason = input.outsideAttendanceReason === undefined ? null : text(input.outsideAttendanceReason, 500, true);
    const notes = text(input.notes ?? "", 1000);
    return this.write("saveLearningBlock", "block", change,
      { attendancePlanId, plannedStart, plannedEnd, outsideAttendanceReason, notes }, now => {
        const current = this.learningBlock(change.id);
        this.checkRevision(current, change);
        if (current && (current.status !== "planned" || current.attendancePlanId !== attendancePlanId)) {
          conflict("已执行的学习块不能改写计划或变更所属到校安排。");
        }
        const plan = attendancePlanId === null ? undefined : this.attendancePlan(attendancePlanId);
        if (attendancePlanId !== null && (!plan || plan.studentId !== change.studentId ||
            plan.status === "cancelled" || plan.status === "absent")) invalid("学习块必须关联同一学生的有效到校安排。");
        const outside = plan && (plannedStart < plan.startAt || plannedEnd > plan.endAt);
        if (Boolean(outside) !== (outsideAttendanceReason !== null)) invalid("超出到校安排时须提供原因。");
        this.db.prepare(`INSERT INTO learning_blocks
          (id,student_id,attendance_plan_id,planned_start,planned_end,status,outside_attendance_reason,notes,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,'planned',?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET planned_start=excluded.planned_start,
          planned_end=excluded.planned_end,outside_attendance_reason=excluded.outside_attendance_reason,notes=excluded.notes,
          revision=learning_blocks.revision+1,updated_at=excluded.updated_at`)
          .run(change.id, change.studentId, attendancePlanId, plannedStart, plannedEnd, outsideAttendanceReason, notes, now, now);
        return this.learningBlock(change.id)!;
      });
  }

  saveLearningTasks(input: ChangeInput & { tasks: LearningTaskInput[] }): LearningBlock {
    const change = identity(input);
    if (!Array.isArray(input.tasks) || input.tasks.length > 3) invalid("每个学习块最多三项任务。");
    const tasks = Array.from(input.tasks, task => {
      if (!task || !["foundation", "synchronous", "targeted_test", "home_school"].includes(task.category)) invalid("学习任务类别无效。");
      return { id: id(task.id), category: task.category, content: text(task.content, 1000, true),
        subject: task.subject === undefined ? null : text(task.subject, 100),
        knowledgePoints: task.knowledgePoints === undefined ? null : text(task.knowledgePoints, 1000),
        plannedTarget: task.plannedTarget === undefined ? null : text(task.plannedTarget, 1000) };
    });
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) invalid("学习任务编号重复。");
    return this.write("saveLearningTasks", "block", change, tasks, now => {
      const block = this.requireBlock(change);
      if (block.status !== "planned") conflict("只能编辑尚未开始的任务计划。");
      const other = this.db.prepare("SELECT 1 FROM learning_tasks WHERE id=? AND block_id<>?");
      if (tasks.some(task => other.get(task.id, change.id))) conflict("该任务编号已属于其他学习块。");
      if (block.tasks.some(task=>!tasks.some(next=>next.id===task.id)&&this.m1.hasPlanTaskLink?.(task.id))) {
        conflict("该任务已关联历史规划版本，请保留任务身份。");
      }
      this.db.prepare("DELETE FROM learning_tasks WHERE block_id=?").run(change.id);
      const insert = this.db.prepare(`INSERT INTO learning_tasks
        (id,block_id,position,category,subject,content,knowledge_points,planned_target,status)
        VALUES(?,?,?,?,?,?,?,?,'planned')`);
      tasks.forEach((task, index) => insert.run(task.id, change.id, index + 1, task.category, task.subject, task.content,
        task.knowledgePoints, task.plannedTarget));
      this.advanceBlock(change.id, now);
      return this.learningBlock(change.id)!;
    });
  }

  recordLearningOutcome(input: ChangeInput & { action: "start" | "finish" | "cancel"; at?: number }): LearningBlock {
    const change = identity(input), action = input.action, at = input.at === undefined ? null : timestamp(input.at);
    if (!["start", "finish", "cancel"].includes(action) || (action === "cancel" && at !== null)) invalid("学习块操作无效。");
    return this.write("recordLearningOutcome", "block", change, { action, at }, now => {
      const block = this.requireBlock(change), actualAt = at ?? now;
      if (actualAt > now) invalid("实际学习时间不能发生在未来。");
      if (action === "finish" ? (block.status !== "in_progress" || block.actualStart === null || actualAt <= block.actualStart ||
        block.tasks.some(task => task.completedAt !== null && task.completedAt > actualAt)) : block.status !== "planned") {
        conflict("学习块状态或实际时间不允许此操作。");
      }
      if (action === "start" && block.attendancePlanId !== null) {
        const plan = this.attendancePlan(block.attendancePlanId);
        if (!plan || plan.status === "cancelled" || plan.status === "absent") conflict("关联到校安排不可执行。");
        if (plan.checkOutAt !== null) conflict("本次到校已签退，不能开始学习块。");
      }
      if (action === "finish" && block.tasks.some(task => task.status === "in_progress")) {
        conflict("请先完成或跳过进行中的任务，再结束学习块。");
      }
      const status = action === "start" ? "in_progress" : action === "finish" ? "done" : "cancelled";
      this.db.prepare("UPDATE learning_blocks SET status=?,actual_start=?,actual_end=? WHERE id=?")
        .run(status, action === "start" ? actualAt : block.actualStart, action === "finish" ? actualAt : null, change.id);
      this.advanceBlock(change.id, now);
      return this.learningBlock(change.id)!;
    });
  }

  recordTaskOutcome(input: ChangeInput & {
    taskId: string; status: "in_progress" | "done" | "skipped"; resultNotes?: string;
  }): LearningBlock {
    const change = identity(input), taskId = id(input.taskId), status = input.status;
    const resultNotes = input.resultNotes === undefined ? null : text(input.resultNotes, 1000);
    if (!["in_progress", "done", "skipped"].includes(status)) invalid("任务结果状态无效。");
    return this.write("recordTaskOutcome", "block", change, { taskId, status, resultNotes }, now => {
      const block = this.requireBlock(change);
      const task = block.tasks.find(item => item.id === taskId);
      if (block.status !== "in_progress" || !task || task.status === "done" || task.status === "skipped" ||
          (status === "in_progress" && task.status !== "planned")) conflict("学习任务状态或所属学习块不允许此操作。");
      this.db.prepare("UPDATE learning_tasks SET status=?,result_notes=?,completed_at=? WHERE block_id=? AND id=?")
        .run(status, resultNotes, status === "in_progress" ? null : now, change.id, taskId);
      this.advanceBlock(change.id, now);
      return this.learningBlock(change.id)!;
    });
  }

  private requireBlock(change: ChangeInput): LearningBlock {
    const block = this.learningBlock(change.id);
    if (!block) invalid("找不到学习块。");
    this.checkRevision(block, change);
    return block;
  }

  private checkRevision(current: AttendancePlan | LearningBlock | undefined, change: ChangeInput): void {
    if (current && current.studentId !== change.studentId) conflict("该教务记录属于其他学生。");
    if ((current?.revision ?? 0) !== change.expectedRevision) conflict("教务记录版本已变化，请重新读取。");
  }

  private advanceBlock(blockId: string, now: number): void {
    this.db.prepare("UPDATE learning_blocks SET revision=revision+1,updated_at=? WHERE id=?").run(now, blockId);
  }

  private write<T extends AttendancePlan | LearningBlock>(command: string, entity: "attendance" | "block",
      change: ChangeInput, payload: unknown, apply: (now: number) => T): T {
    const digest = createHash("sha256").update(JSON.stringify({ ...change, payload })).digest("hex");
    return this.transact(() => {
      if (!this.m1.students().some(student => student.id === change.studentId)) invalid("找不到关联的 M1 学生。");
      const prior = this.db.prepare("SELECT command,payload_sha256,result_json FROM operation_requests WHERE request_id=?")
        .get(change.requestId);
      let result: T;
      if (prior) {
        if (prior.command !== command || prior.payload_sha256 !== digest) conflict("该保存编号已用于另一项教务变更。");
        result = JSON.parse(prior.result_json as string) as T;
      } else {
        const now = Date.now();
        result = apply(now);
        const snapshot = JSON.stringify(result);
        this.db.prepare("INSERT INTO operation_requests VALUES(?,?,?,?,?)").run(change.requestId, command, digest, snapshot, now);
        this.db.prepare("INSERT INTO operation_changes VALUES(?,?,?,?,?,?,?)")
          .run(entity, result.id, result.studentId, result.revision, change.requestId, snapshot, now);
      }
      return result;
    });
  }

  private transact<T>(operation: () => T): T {
    if (this.writesBlocked) recovery("教务库结果待确认，请关闭重开。");
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const result = operation();
      committing = true;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        else if (committing) this.writesBlocked = true;
      } catch {
        this.writesBlocked = true;
        committing = true;
      }
      if (committing) throw new WorkspaceFault("unknown", "教务保存结果待确认，请用同一编号重试或重开后核对。");
      throw error;
    }
  }

  receipt(requestId: string, command: string, targetId: string, studentId: string, expectedRevision: number) {
    // Autocommit is required here, even when an uncertain COMMIT has blocked further writes.
    if (this.db.isTransaction) throw new WorkspaceFault("busy", "事务尚未结束，请重开后核对回执。");
    const row = this.db.prepare(`SELECT r.command, c.entity_id, c.student_id, c.revision, r.created_at
      FROM operation_requests r JOIN operation_changes c USING (request_id) WHERE r.request_id=?`).get(requestId);
    if (!row) return null;
    if (row.command !== command || row.entity_id !== targetId || row.student_id !== studentId ||
        row.revision !== expectedRevision + 1) conflict("请求编号与待核对的教务操作不一致。");
    return { revision: row.revision, savedAt: Number(row.created_at) };
  }

  protectionConnection(): DatabaseSync {
    if (this.writesBlocked || this.db.isTransaction) throw new WorkspaceFault("busy", "教务库写入状态尚未确认。");
    return this.db;
  }

  close(): void {
    this.db.close();
    if (this.writesBlocked) throw new WorkspaceFault("unknown", "教务库关闭前的写入状态待确认。");
  }
}
