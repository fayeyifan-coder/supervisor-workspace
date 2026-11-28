import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Failure, Lesson, LessonInput, Student, StudentEditFields, StudentEditInput, StudentEditRecord, StudentEditView, StudentInput, StudentWriteCommand } from "./contracts";
import { appendParentFollowUp, concernInput, createParentConcern, followUpInput, parentSchema, parentWriteCommitted, readParentFollowUp, verifyParentFollowUp } from "./parent-follow-up";
import { readStudentRecords, saveStudentRecord, studentRecordCommitted, studentRecordInput, studentRecordSchema, verifyStudentRecords } from "./student-records";
import { changeStudentLifecycle, lifecycleInput, lifecycleReceipt, lifecycleSchema, studentLifecycle, verifyStudentLifecycle } from "./student-lifecycle";
import { planLinkSchema, verifyPlanLinks } from "./study-plan-links";
import { planVersionSchema, verifyPlanVersions } from "./study-plan-versions";
import { studyPlanSchema, studyPlanTables, verifyStudyPlans } from "./study-plans";
import { WorkspaceFault } from "./workspace-fault";
import { dailySchema, saveQuickLesson, verifyDailyRecords } from "./learning-daily";
import { trackingSchema, writeTracking, verifyTracking } from "./learning-tracking";
export { WorkspaceFault } from "./workspace-fault";

const applicationId = 0x53574d31;
export const latestM1Version = 15;
export type M1Version = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export function isM1Version(value: unknown): value is M1Version {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= latestM1Version;
}
const schema = [
  ["students", "table", `CREATE TABLE students (
    id TEXT PRIMARY KEY, alias TEXT NOT NULL, grade TEXT NOT NULL, subjects TEXT NOT NULL,
    goal TEXT NOT NULL, notes TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT`],
  ["learning_records", "table", `CREATE TABLE learning_records (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    study_date TEXT NOT NULL, subject TEXT NOT NULL, task TEXT NOT NULL,
    completion TEXT NOT NULL, assessment TEXT NOT NULL, next_step TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`],
  ["learning_history", "index", `CREATE INDEX learning_history
    ON learning_records(student_id, study_date DESC, created_at DESC, id DESC)`],
] as const;
const editSchema = [
  ["student_edits", "table", `CREATE TABLE student_edits (
    request_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    revision INTEGER NOT NULL CHECK(revision > 0), changed_at INTEGER NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, UNIQUE(student_id, revision)
  ) STRICT`],
  ["student_edit_pending", "table", `CREATE TABLE student_edit_pending (
    student_id TEXT PRIMARY KEY REFERENCES students(id), request_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL
  ) STRICT`],
] as const;
const schemaFor = (version: M1Version) => version >= 3 ? [...schema, ...editSchema, ...parentSchema, ...studentRecordSchema(version), ...(version >= 8 ? [lifecycleSchema] : []), ...(version >= 11 ? studyPlanSchema : []), ...(version >= 12 ? [planVersionSchema] : []), ...(version >= 13 ? [planLinkSchema] : []), ...(version >= 14 ? [dailySchema] : []), ...(version >= 15 ? [trackingSchema] : [])]
  : version === 2 ? [...schema, ...editSchema] : schema;
const markerFor = (version: M1Version) => "mvp-v" + version + "\n";
const studentColumns = "id, alias, grade, subjects, goal, notes, created_at AS createdAt";
const lessonColumns = "id, student_id AS studentId, study_date AS date, subject, task, completion, assessment, next_step AS nextStep, created_at AS createdAt";

export function failure(error: unknown): Failure {
  if (error instanceof WorkspaceFault) return { ok: false, code: error.code, message: error.message };
  const code = (error as { errcode?: number } | null)?.errcode;
  if (typeof code === "number" && [5, 6].includes(code & 255)) {
    return { ok: false, code: "busy", message: "本地数据库正被占用，请稍后重试。" };
  }
  return { ok: false, code: "failed", message: "本地数据库操作失败，输入仍可保留并重试。" };
}

function recover(message: string): never {
  throw new WorkspaceFault("recovery", message);
}

function existsFile(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) recover("MVP 数据文件路径无效。请保留本地目录。");
  return true;
}

function checkHeader(path: string, version: M1Version): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== version) {
      recover("MVP 数据库版本或身份与当前档案不兼容。请保留原目录及侧车文件。");
    }
  } finally {
    closeSync(fd);
  }
}

function checkDatabase(db: DatabaseSync, version: M1Version): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId ||
      db.prepare("PRAGMA user_version").get()?.user_version !== version) {
    recover("数据库身份或版本无法确认。");
  }
  const definitions = db.prepare("SELECT name, type, sql FROM main.sqlite_schema").all();
  const canonical = (ddl: string) => ddl.replace(/\s+/g, " ");
  const automatic = ["sqlite_autoindex_students_1", "sqlite_autoindex_learning_records_1"];
  if (version >= 2) automatic.push("sqlite_autoindex_student_edits_1", "sqlite_autoindex_student_edits_2",
    "sqlite_autoindex_student_edit_pending_1", "sqlite_autoindex_student_edit_pending_2");
  if (version >= 3) automatic.push("sqlite_autoindex_parent_concerns_1", "sqlite_autoindex_parent_followups_1", "sqlite_autoindex_parent_followups_2");
  for (const [table] of studentRecordSchema(version)) automatic.push("sqlite_autoindex_" + table + "_1", "sqlite_autoindex_" + table + "_2");
  if (version >= 8) automatic.push("sqlite_autoindex_student_lifecycle_1", "sqlite_autoindex_student_lifecycle_2");
  if (version >= 11) automatic.push("sqlite_autoindex_study_plan_sources_1", "sqlite_autoindex_study_plans_1", "sqlite_autoindex_study_plans_2");
  if (version >= 12) automatic.push("sqlite_autoindex_study_plan_versions_1", "sqlite_autoindex_study_plan_versions_2");
  if (version >= 13) automatic.push("sqlite_autoindex_study_plan_links_1");
  if (version >= 14) automatic.push("sqlite_autoindex_learning_record_details_1", "sqlite_autoindex_learning_record_details_2");
  if (version >= 15) automatic.push("sqlite_autoindex_learning_unit_events_1", "sqlite_autoindex_learning_unit_events_2");
  const expected = schemaFor(version);
  const explicitMatch = expected.every(([name, type, ddl]) => definitions.some(object =>
    object.name === name && object.type === type && typeof object.sql === "string" && canonical(object.sql) === canonical(ddl)));
  const implicitMatch = automatic.every(name => definitions.some(object =>
    object.name === name && object.type === "index" && object.sql === null));
  if (definitions.length !== expected.length + automatic.length || !explicitMatch || !implicitMatch ||
      db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get()) recover("MVP 数据库结构或完整性检查失败。请保留本地目录。");
  if (version >= 2) verifyStudentEdits(db);
  if (version >= 3) verifyParentFollowUp(db);
  if (version >= 4) verifyStudentRecords(db, version);
  if (version >= 8) verifyStudentLifecycle(db);
  if (version >= 11) verifyStudyPlans(db);
  if (version >= 12) verifyPlanVersions(db);
  if (version >= 13) verifyPlanLinks(db);
  if (version >= 14) verifyDailyRecords(db);
  if (version >= 15) verifyTracking(db);
}

function inputObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkspaceFault("invalid", "表单数据无效。");
  }
  return raw as Record<string, unknown>;
}

function identifier(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)) {
    throw new WorkspaceFault("invalid", "保存编号或学生编号无效。");
  }
  return input;
}

function text(raw: unknown, label: string, limit: number, required = false): string {
  const value = typeof raw === "string" && raw.length <= limit ? raw.trim() : undefined;
  if (value === undefined || value.includes("\0") || (required && !value)) {
    throw new WorkspaceFault("invalid", label + (required ? "不能为空，长度上限为 " : "的长度上限为 ") + limit + " 字。");
  }
  return value;
}

function studentFields(raw: unknown): StudentEditFields {
  const input = inputObject(raw);
  return {
    alias: text(input.alias, "学生代号", 40, true),
    grade: text(input.grade, "年级", 30, true),
    subjects: text(input.subjects, "学科", 100, true),
    goal: text(input.goal, "学习目标", 300),
    notes: text(input.notes, "备注", 500),
  };
}

function studentEdit(raw: unknown): StudentEditInput {
  const input = inputObject(raw);
  if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceFault("invalid", "档案版本无效。");
  }
  const fields = studentFields(input.fields);
  if (Object.keys(input).some(key => !["studentId", "requestId", "expectedRevision", "fields"].includes(key)) ||
      Object.keys(inputObject(input.fields)).some(key => !Object.hasOwn(fields, key))) {
    throw new WorkspaceFault("invalid", "包含不可修改的学生字段。");
  }
  return { studentId: identifier(input.studentId), requestId: identifier(input.requestId),
    expectedRevision: input.expectedRevision, fields };
}

const editConflict = (message: string): never => { throw new WorkspaceFault("conflict", message); };
const editColumns = "request_id, student_id, revision, changed_at, before_json, after_json";
function editRecord(row: Record<string, unknown>): StudentEditRecord {
  return { requestId: String(row.request_id), revision: Number(row.revision), changedAt: Number(row.changed_at),
    before: JSON.parse(String(row.before_json)), after: JSON.parse(String(row.after_json)) };
}
function matchesEdit(row: Record<string, unknown>, input: StudentEditInput): boolean {
  return row.student_id === input.studentId && row.revision === input.expectedRevision + 1 &&
    row.after_json === JSON.stringify(input.fields);
}

export function verifyStudentEdits(db: DatabaseSync): void {
  const latest = new Map<string, { revision: number; after: string }>();
  for (const row of db.prepare("SELECT " + editColumns + " FROM student_edits ORDER BY student_id,revision").iterate()) {
    const studentId = identifier(row.student_id);
    identifier(row.request_id);
    const record = editRecord(row);
    const previous = latest.get(studentId);
    const before = JSON.stringify(studentFields(record.before)), after = JSON.stringify(studentFields(record.after));
    if (record.revision !== (previous?.revision ?? 0) + 1 || !Number.isSafeInteger(record.changedAt) ||
        record.changedAt < 0 || !Number.isFinite(new Date(record.changedAt).getTime()) ||
        before !== row.before_json || after !== row.after_json || before === after ||
        (previous && previous.after !== before)) recover("学生资料修改历史不连续或无效。");
    latest.set(studentId, { revision: record.revision, after });
  }
  const readStudent = db.prepare("SELECT " + studentColumns + " FROM students WHERE id=?");
  for (const [id, record] of latest) {
    if (JSON.stringify(studentFields(readStudent.get(id))) !== record.after) recover("学生资料与修改历史不一致。");
  }
  const receipt = db.prepare("SELECT " + editColumns + " FROM student_edits WHERE request_id=?");
  for (const row of db.prepare("SELECT student_id, request_id, payload FROM student_edit_pending").iterate()) {
    const pending = studentEdit(JSON.parse(String(row.payload)));
    const stored = receipt.get(pending.requestId);
    if (pending.studentId !== row.student_id || pending.requestId !== row.request_id ||
        JSON.stringify(pending) !== row.payload || (stored ? !matchesEdit(stored, pending)
          : pending.expectedRevision !== (latest.get(pending.studentId)?.revision ?? 0))) {
      recover("学生资料待核对请求与档案不一致。");
    }
  }
}

function studyDate(raw: unknown): string {
  if (typeof raw === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(raw + "T00:00:00Z");
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw) return raw;
  }
  throw new WorkspaceFault("invalid", "请选择有效的学习日期。");
}

export class WorkspaceDatabase {
  private writesBlocked = false;

  private constructor(private readonly db: DatabaseSync, readonly version: M1Version) {}

  static open(path: string, marker: string, version: M1Version = 1): WorkspaceDatabase {
    const exists = existsFile(path);
    const initialized = existsFile(marker);
    const sidecars = ["-wal", "-shm", "-journal"].map(suffix => existsFile(path + suffix));
    if (exists) {
      checkHeader(path, version);
      if (version >= 2 && (!initialized || readFileSync(marker, "utf8") !== markerFor(version))) {
        recover("新版学生档案的初始化标记缺失或无效。");
      }
    } else {
      if (initialized || sidecars.some(Boolean)) recover("MVP 主库缺失。请保留初始化标记及侧车文件。");
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "wx"));
    }

    const db = new DatabaseSync(path, {
      allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500,
    });
    try {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL");
      if (!exists) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const [, , ddl] of schemaFor(version)) db.exec(ddl);
          db.exec("PRAGMA application_id = " + applicationId + "; PRAGMA user_version = " + version);
          checkDatabase(db, version);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } else {
        checkDatabase(db, version);
      }
      if (db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode !== "wal") {
        recover("无法启用 SQLite WAL。请保留本地目录。");
      }
      if (!initialized) writeFileSync(marker, markerFor(version), { flag: "wx", flush: true });
      return new WorkspaceDatabase(db, version);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  students(): Student[] {
    if (this.version >= 2) this.protectionConnection();
    const status = this.version >= 8 ? `, coalesce((SELECT status FROM student_lifecycle
      WHERE student_id=students.id ORDER BY revision DESC LIMIT 1), 'active') AS lifecycleStatus` : "";
    return this.db.prepare("SELECT " + studentColumns + status + " FROM students ORDER BY created_at DESC, id DESC")
      .all().map(row => ({ ...row })) as unknown as Student[];
  }

  history(rawStudentId: unknown): Lesson[] {
    if (this.version >= 2) this.protectionConnection();
    const studentId = identifier(rawStudentId);
    return this.db.prepare("SELECT " + lessonColumns + " FROM learning_records WHERE student_id = ?" +
      " ORDER BY study_date DESC, created_at DESC, id DESC").all(studentId).map(row => ({ ...row })) as unknown as Lesson[];
  }

  createStudent(raw: unknown): Student {
    const input = inputObject(raw);
    const draft: StudentInput = {
      id: identifier(input.id),
      ...studentFields(input),
    };
    return this.save(draft, id => {
      const current = this.student(id);
      if (this.version === 1 || !current) return current;
      const first = this.db.prepare("SELECT before_json FROM student_edits WHERE student_id=? AND revision=1").get(id);
      return first ? { ...current, ...studentFields(JSON.parse(String(first.before_json))) } : current;
    }, row => {
      this.db.prepare("INSERT INTO students VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.alias, row.grade, row.subjects, row.goal, row.notes, row.createdAt);
    });
  }

  private student(id: string): Student | undefined {
    return this.db.prepare("SELECT " + studentColumns + " FROM students WHERE id=?").get(id) as Student | undefined;
  }

  private requireEditSupport(): void {
    if (this.version < 2) recover("新版编辑仅在已验证的五库合成档案中可用。");
  }

  private requireParentSupport(): void {
    if (this.version < 3) recover("家长诉求仅在已验证的新版五库合成档案中可用。");
  }

  parentFollowUp(rawStudentId: unknown) {
    this.requireParentSupport();
    return readParentFollowUp(this.protectionConnection(), rawStudentId);
  }

  createParentConcern(raw: unknown) {
    this.requireParentSupport();
    return this.write(() => createParentConcern(this.db, raw));
  }

  appendParentFollowUp(raw: unknown) {
    this.requireParentSupport();
    return this.write(() => appendParentFollowUp(this.db, raw));
  }

  studentRecords(kind: unknown, studentId: unknown) {
    return readStudentRecords(this.protectionConnection(), this.version, kind, studentId);
  }

  saveStudentRecord(raw: unknown) {
    return this.write(() => saveStudentRecord(this.db, this.version, raw));
  }

  private requireLifecycleSupport() {
    if (this.version < 8) recover("当前档案尚未启用学生跟进状态管理。");
  }

  studentLifecycle(studentId: unknown) {
    this.requireLifecycleSupport();
    return studentLifecycle(this.protectionConnection(), studentId);
  }

  saveStudentLifecycle(raw: unknown) {
    this.requireLifecycleSupport();
    return this.write(() => changeStudentLifecycle(this.db, raw));
  }

  studentWriteCommand(kind: StudentWriteCommand["kind"], raw: unknown): StudentWriteCommand {
    if (kind === "lifecycle") {
      this.requireLifecycleSupport();
      return { kind, input: lifecycleInput(raw) };
    }
    if (kind === "record") return { kind, input: studentRecordInput(this.version, raw) };
    this.requireParentSupport();
    return kind === "concern" ? { kind, input: concernInput(raw) } : { kind, input: followUpInput(raw) };
  }

  studentWriteCommitted(command: StudentWriteCommand): boolean {
    const db = this.protectionConnection();
    if (command.kind === "lifecycle") return Boolean(lifecycleReceipt(db, command.input));
    return command.kind === "record" ? studentRecordCommitted(db, this.version, command.input)
      : parentWriteCommitted(db, command.kind, command.input);
  }

  private editState(studentId: string) {
    const student = this.student(studentId);
    if (!student) throw new WorkspaceFault("invalid", "找不到所选学生。");
    const revision = Number(this.db.prepare("SELECT max(revision) AS revision FROM student_edits WHERE student_id=?").get(studentId)?.revision ?? 0);
    return { student: { ...student }, revision };
  }

  private editReceipt(requestId: string) {
    return this.db.prepare("SELECT " + editColumns + " FROM student_edits WHERE request_id=?").get(requestId);
  }

  hasPendingStudentEdits(): boolean {
    return this.version >= 2 && Boolean(this.db.prepare("SELECT 1 FROM student_edit_pending LIMIT 1").get());
  }

  studentEditView(rawStudentId: unknown): StudentEditView {
    this.requireEditSupport();
    this.protectionConnection();
    const studentId = identifier(rawStudentId);
    const state = this.editState(studentId);
    const history = this.db.prepare("SELECT " + editColumns + " FROM student_edits WHERE student_id=? ORDER BY revision DESC")
      .all(studentId).map(editRecord);
    const row = this.db.prepare("SELECT payload FROM student_edit_pending WHERE student_id=?").get(studentId);
    return { ...state, history, pending: row ? studentEdit(JSON.parse(String(row.payload))) : null };
  }

  saveStudentEdit(raw: unknown): StudentEditRecord {
    this.requireEditSupport();
    const input = studentEdit(raw);
    const { studentId, requestId, expectedRevision, fields } = input;
    const payload = JSON.stringify(input);
    const before = () => {
      const state = this.editState(studentId);
      if (state.revision !== expectedRevision) editConflict("学生资料版本已变化，请重新读取后核对。");
      const values = JSON.stringify(studentFields(state.student));
      if (values === JSON.stringify(fields)) editConflict("学生资料没有变化。");
      return values;
    };
    const known = this.write(() => {
      const existing = this.editReceipt(requestId);
      if (existing) {
        if (!matchesEdit(existing, input)) editConflict("请求编号已保存为其他内容。");
        return editRecord(existing);
      }
      const staged = this.db.prepare("SELECT payload FROM student_edit_pending WHERE student_id=? OR request_id=?")
        .all(studentId, requestId);
      if (staged.length) {
        if (staged.length !== 1 || staged[0].payload !== payload) editConflict("该学生或请求编号已有待核对内容。");
      } else {
        before();
        this.db.prepare("INSERT INTO student_edit_pending VALUES (?,?,?)").run(studentId, requestId, payload);
      }
    });
    if (known) return known;
    return this.write(() => {
      const staged = this.db.prepare("SELECT payload FROM student_edit_pending WHERE student_id=?").get(studentId);
      if (staged?.payload !== payload) return recover("待核对的学生资料请求无法确认。");
      const existing = this.editReceipt(requestId);
      if (existing) {
        if (!matchesEdit(existing, input)) editConflict("请求编号已保存为其他内容。");
        return editRecord(existing);
      }
      const prior = before();
      const revision = expectedRevision + 1, changedAt = Date.now();
      this.db.prepare("UPDATE students SET alias=?, grade=?, subjects=?, goal=?, notes=? WHERE id=?")
        .run(fields.alias, fields.grade, fields.subjects, fields.goal, fields.notes, studentId);
      this.db.prepare("INSERT INTO student_edits VALUES (?,?,?,?,?,?)")
        .run(requestId, studentId, revision, changedAt, prior, JSON.stringify(fields));
      return { requestId, revision, changedAt, before: JSON.parse(prior), after: fields };
    });
  }

  finishStudentEdit(raw: unknown): null {
    this.requireEditSupport();
    const input = inputObject(raw);
    const studentId = identifier(input.studentId), requestId = identifier(input.requestId);
    if (input.discard !== undefined && typeof input.discard !== "boolean") {
      throw new WorkspaceFault("invalid", "结束待核对请求的参数无效。");
    }
    return this.write(() => {
      const applied = this.editReceipt(requestId)?.student_id === studentId;
      if (applied && input.discard === true) return editConflict("这笔修改已经保存，请重新读取并确认结果。");
      const pending = this.db.prepare("SELECT request_id FROM student_edit_pending WHERE student_id=?").get(studentId);
      if (!pending) return null;
      if (pending.request_id !== requestId) return editConflict("请求编号与待核对编辑不一致。");
      if (!applied && input.discard !== true) {
        throw new WorkspaceFault("unknown", "尚未确认提交。请重试同一请求，或核对后放弃。");
      }
      this.db.prepare("DELETE FROM student_edit_pending WHERE student_id=? AND request_id=?").run(studentId, requestId);
      return null;
    });
  }

  saveLearningTracking(work: DatabaseSync, raw: unknown) {
    if(this.version<15)throw new WorkspaceFault("invalid","当前档案不支持学科单元。");
    return this.write(()=>writeTracking(this.db,work,raw));
  }

  addQuickLesson(ops: DatabaseSync, raw: unknown): Lesson {
    if (this.version < 14) throw new WorkspaceFault("invalid", "当前档案尚不支持快速学习登记。");
    return this.write(() => saveQuickLesson(this.db, ops, raw));
  }

  addLesson(raw: unknown): Lesson {
    const input = inputObject(raw);
    const draft: LessonInput = {
      id: identifier(input.id),
      studentId: identifier(input.studentId),
      date: studyDate(input.date),
      subject: text(input.subject, "学科", 40, true),
      task: text(input.task, "学习任务", 500, true),
      completion: text(input.completion, "实际完成情况", 500, true),
      assessment: text(input.assessment, "测验与观察", 500),
      nextStep: text(input.nextStep, "下一步建议", 500),
    };
    return this.save(draft, id => this.db.prepare("SELECT " + lessonColumns + " FROM learning_records WHERE id = ?")
      .get(id) as unknown as Lesson | undefined, row => {
      if (!this.db.prepare("SELECT 1 FROM students WHERE id = ?").get(row.studentId)) {
        throw new WorkspaceFault("invalid", "找不到所选学生，请重新读取档案。");
      }
      this.db.prepare("INSERT INTO learning_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.studentId, row.date, row.subject, row.task, row.completion, row.assessment, row.nextStep, row.createdAt);
    });
  }

  // M1 creates immutable rows. The row ID is also the retry key and the committed row is the receipt.
  private save<T extends { id: string }>(
    draft: T, lookup: (id: string) => (T & { createdAt: number }) | undefined,
    insert: (row: T & { createdAt: number }) => void,
  ): T & { createdAt: number } {
    return this.write(() => {
      const previous = lookup(draft.id);
      if (previous && Object.entries(draft).some(([key, value]) => Reflect.get(previous, key) !== value)) {
        throw new WorkspaceFault("conflict", "该保存编号已经关联另一条内容，请核对档案或历史。");
      }
      const row = previous ? { ...previous } : { ...draft, createdAt: Date.now() };
      if (!previous) insert(row);
      return row;
    });
  }

  private write<T>(operation: () => T): T {
    if (this.writesBlocked) recover("数据库状态尚未确认。请重开并核对历史。");
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
      } catch {
        this.writesBlocked = true;
        committing = true;
      }
      if (committing) throw new WorkspaceFault("unknown", "保存结果待确认，请用同一编号重试或重开核对历史。");
      throw error;
    }
  }

  hasPlanTaskLink(taskId: string): boolean {
    return this.version >= 13 && Boolean(this.protectionConnection().prepare("SELECT 1 FROM study_plan_links WHERE task_id=?").get(taskId));
  }

  protectionConnection(): DatabaseSync {
    if (this.writesBlocked || this.db.isTransaction) throw new WorkspaceFault("busy", "本地数据库写入状态仍待确定，无法导出。");
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

export const m1Protection = {
  key: "mvp", marker: markerFor(1), applicationId: applicationId, version: 1,
  tables: ["students", "learning_records"], ddl: schema.map(entry => entry[2]),
};
export const m1EditProtection = {
  ...m1Protection, marker: markerFor(2), version: 2,
  tables: [...m1Protection.tables, "student_edits", "student_edit_pending"],
  ddl: schemaFor(2).map(entry => entry[2]),
};
const m1ParentProtection = {
  ...m1EditProtection, marker: markerFor(3), version: 3,
  tables: [...m1EditProtection.tables, "parent_concerns", "parent_followups"],
  ddl: schemaFor(3).map(entry => entry[2]),
};
export function m1ProtectionLayout(version: M1Version) {
  if (version <= 3) return version === 3 ? m1ParentProtection : version === 2 ? m1EditProtection : m1Protection;
  return { ...m1ParentProtection, version, marker: markerFor(version),
    tables: [...m1ParentProtection.tables, ...studentRecordSchema(version).map(entry => entry[0]), ...(version >= 8 ? [lifecycleSchema[0]] : []), ...(version >= 11 ? studyPlanTables : []), ...(version >= 12 ? [planVersionSchema[0]] : []), ...(version >= 13 ? [planLinkSchema[0]] : []), ...(version >= 14 ? [dailySchema[0]] : []), ...(version >= 15 ? [trackingSchema[0]] : [])],
    ddl: schemaFor(version).map(entry => entry[2]) };
}
