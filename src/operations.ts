import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceFault, type WorkspaceDatabase } from "./database";
import { operationsProtection, verifyOperationsStudentLinks } from "./operations-schema";
import { minute, openingHours, shanghaiParts } from "./schedule-calendar";

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
}

export interface AttendancePlan {
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

function verifySchema(db: DatabaseSync): void {
  const schema = "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name";
  const expected = new DatabaseSync(":memory:");
  try {
    for (const sql of operationsProtection.ddl) expected.exec(sql);
    if (db.prepare("PRAGMA application_id").get()?.application_id !== operationsProtection.applicationId ||
        db.prepare("PRAGMA user_version").get()?.user_version !== operationsProtection.version ||
        JSON.stringify(db.prepare(schema).all()) !== JSON.stringify(expected.prepare(schema).all()) ||
        db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
      recovery("教务数据库身份、Schema 或完整性无法确认。");
    }
  } finally { expected.close(); }
}

function verifyHeader(path: string): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== operationsProtection.applicationId ||
        header.readUInt32BE(60) !== operationsProtection.version) recovery("教务数据库身份无法确认。");
  } finally { closeSync(fd); }
}

// Desktop startup uses this store only in the isolated five-store synthetic mode.
export class OperationsDatabase {
  private writesBlocked = false;

  private constructor(private readonly db: DatabaseSync, private readonly m1: Pick<WorkspaceDatabase, "students">) {}

  static open(dataDirectory: string, m1: Pick<WorkspaceDatabase, "students">, allowInitialize = false): OperationsDatabase {
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
      if (lstatSync(marker).size !== operationsProtection.marker.length ||
          readFileSync(marker, "utf8") !== operationsProtection.marker) recovery("教务库初始化标记无效。");
      verifyHeader(path);
    } else closeSync(openSync(path, "wx"));

    const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500 });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
      if (!exists) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const sql of operationsProtection.ddl) db.exec(sql);
          db.exec(`PRAGMA application_id=${operationsProtection.applicationId}; PRAGMA user_version=${operationsProtection.version}`);
          verifySchema(db);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } else verifySchema(db);
      verifyOperationsStudentLinks(db, new Set(m1.students().map(student => student.id)));
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") recovery("无法启用教务数据库 WAL。");
      if (!initialized) writeFileSync(marker, operationsProtection.marker, { flag: "wx", flush: true });
      return new OperationsDatabase(db, m1);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  attendancePlan(planId: string): AttendancePlan | undefined {
    const row = this.db.prepare("SELECT " + planColumns + " FROM attendance_plans WHERE id=?").get(id(planId));
    return row ? { ...row } as unknown as AttendancePlan : undefined;
  }

  listAttendancePlans(startAt: number, endAt: number, studentId?: string): AttendancePlan[] {
    if (timestamp(startAt) >= timestamp(endAt)) invalid("排课查询区间无效。");
    const criteria = studentId === undefined ? "" : " AND student_id=?";
    const params = studentId === undefined ? [endAt, startAt] : [endAt, startAt, id(studentId)];
    return this.db.prepare("SELECT " + planColumns + " FROM attendance_plans WHERE start_at<? AND end_at>?" +
      criteria + " ORDER BY start_at,id").all(...params).map(row => ({ ...row })) as unknown as AttendancePlan[];
  }

  saveAttendancePlan(input: SaveAttendancePlanInput): AttendancePlan {
    const change = identity(input), startAt = timestamp(input.startAt), kind = input.kind ?? "regular";
    if (kind !== "regular" && kind !== "whole_day") invalid("到校类型无效。");
    const endAt = timestamp(input.endAt ?? (kind === "regular" ? startAt + 120 * minute : undefined));
    const inWindow = planningWindow(startAt, endAt);
    let exceptionReason: string | null = null;
    if (!inWindow) {
      if (input.exception?.confirmed !== true) invalid("默认时段外的单次排课需要明确确认。");
      exceptionReason = text(input.exception.reason, 500, true);
    }
    return this.write("saveAttendancePlan", "attendance", change, { startAt, endAt, kind, exceptionReason }, now => {
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
        VALUES(?,?,?,?,?,'planned',?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,
        end_at=excluded.end_at,kind=excluded.kind,outside_window=excluded.outside_window,
        exception_reason=excluded.exception_reason,revision=attendance_plans.revision+1,updated_at=excluded.updated_at`)
        .run(change.id, change.studentId, startAt, endAt, kind, Number(!inWindow), exceptionReason, now, now);
      return this.attendancePlan(change.id)!;
    });
  }

  recordAttendance(input: ChangeInput & {
    action: "confirm" | "checkIn" | "checkOut" | "absent" | "cancel"; at?: number;
  }): AttendancePlan {
    const change = identity(input), action = input.action;
    const at = input.at === undefined ? null : timestamp(input.at);
    if (!["confirm", "checkIn", "checkOut", "absent", "cancel"].includes(action) ||
        (at !== null && action !== "checkIn" && action !== "checkOut")) invalid("出勤操作无效。");
    return this.write("recordAttendance", "attendance", change, { action, at }, now => {
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
          if (!waiting) conflict("该到校安排不能签到。");
          status = "attended";
          checkInAt = actualAt;
          break;
        case "checkOut":
          if (current.status !== "attended" || checkInAt === null || checkOutAt !== null || actualAt < checkInAt) {
            conflict("该到校安排不能签退。");
          }
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
        case "cancel":
          if (!waiting || now >= current.startAt || this.db.prepare(
            "SELECT 1 FROM learning_blocks WHERE attendance_plan_id=? AND status<>'cancelled' LIMIT 1").get(change.id)) {
            conflict("该到校安排不能取消，请核对已有学习块和出勤。");
          }
          status = "cancelled";
          break;
      }
      this.db.prepare(`UPDATE attendance_plans SET status=?,check_in_at=?,check_out_at=?,revision=revision+1,updated_at=? WHERE id=?`)
        .run(status, checkInAt, checkOutAt, now, change.id);
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
    if (this.writesBlocked) recovery("教务库结果待确认，请关闭重开。");
    const digest = createHash("sha256").update(JSON.stringify({ ...change, payload })).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
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

  protectionConnection(): DatabaseSync {
    if (this.writesBlocked || this.db.isTransaction) throw new WorkspaceFault("busy", "教务库写入状态尚未确认。");
    return this.db;
  }

  close(): void {
    this.db.close();
    if (this.writesBlocked) throw new WorkspaceFault("unknown", "教务库关闭前的写入状态待确认。");
  }
}
