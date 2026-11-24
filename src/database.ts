import { closeSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Failure, Lesson, LessonInput, Student, StudentInput } from "./contracts";

const applicationId = 0x53574d31;
const schemaVersion = 1;
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
const studentColumns = "id, alias, grade, subjects, goal, notes, created_at AS createdAt";
const lessonColumns = "id, student_id AS studentId, study_date AS date, subject, task, completion, assessment, next_step AS nextStep, created_at AS createdAt";

export class WorkspaceFault extends Error {
  constructor(readonly code: Failure["code"], message: string) {
    super(message);
  }
}

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

function checkHeader(path: string): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== schemaVersion) {
      recover("数据库身份或版本无法确认。请保留 MVP 原目录及侧车文件。");
    }
  } finally {
    closeSync(fd);
  }
}

function checkDatabase(db: DatabaseSync): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId ||
      db.prepare("PRAGMA user_version").get()?.user_version !== schemaVersion) {
    recover("数据库身份或版本无法确认。");
  }
  const definitions = db.prepare("SELECT name, type, sql FROM main.sqlite_schema").all();
  const canonical = (ddl: string) => ddl.replace(/\s+/g, " ");
  const automatic = ["sqlite_autoindex_students_1", "sqlite_autoindex_learning_records_1"];
  const explicitMatch = schema.every(([name, type, ddl]) => definitions.some(object =>
    object.name === name && object.type === type && typeof object.sql === "string" && canonical(object.sql) === canonical(ddl)));
  const implicitMatch = automatic.every(name => definitions.some(object =>
    object.name === name && object.type === "index" && object.sql === null));
  if (definitions.length !== schema.length + automatic.length || !explicitMatch || !implicitMatch ||
      db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get()) recover("MVP 数据库结构或完整性检查失败。请保留本地目录。");
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

function studyDate(raw: unknown): string {
  if (typeof raw === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(raw + "T00:00:00Z");
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw) return raw;
  }
  throw new WorkspaceFault("invalid", "请选择有效的学习日期。");
}

export class WorkspaceDatabase {
  private writesBlocked = false;

  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, marker: string): WorkspaceDatabase {
    const exists = existsFile(path);
    const initialized = existsFile(marker);
    const sidecars = ["-wal", "-shm", "-journal"].map(suffix => existsFile(path + suffix));
    if (exists) {
      checkHeader(path);
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
          for (const [, , ddl] of schema) db.exec(ddl);
          db.exec("PRAGMA application_id = " + applicationId + "; PRAGMA user_version = " + schemaVersion);
          checkDatabase(db);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } else {
        checkDatabase(db);
      }
      if (db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode !== "wal") {
        recover("无法启用 SQLite WAL。请保留本地目录。");
      }
      if (!initialized) writeFileSync(marker, "mvp-v1\n", { flag: "wx", flush: true });
      return new WorkspaceDatabase(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  students(): Student[] {
    return this.db.prepare("SELECT " + studentColumns + " FROM students ORDER BY created_at DESC, id DESC")
      .all().map(row => ({ ...row })) as unknown as Student[];
  }

  history(rawStudentId: unknown): Lesson[] {
    const studentId = identifier(rawStudentId);
    return this.db.prepare("SELECT " + lessonColumns + " FROM learning_records WHERE student_id = ?" +
      " ORDER BY study_date DESC, created_at DESC, id DESC").all(studentId).map(row => ({ ...row })) as unknown as Lesson[];
  }

  createStudent(raw: unknown): Student {
    const input = inputObject(raw);
    const draft: StudentInput = {
      id: identifier(input.id),
      alias: text(input.alias, "学生代号", 40, true),
      grade: text(input.grade, "年级", 30, true),
      subjects: text(input.subjects, "学科", 100, true),
      goal: text(input.goal, "学习目标", 300),
      notes: text(input.notes, "备注", 500),
    };
    return this.save(draft, id => this.db.prepare("SELECT " + studentColumns + " FROM students WHERE id = ?")
      .get(id) as unknown as Student | undefined, row => {
      this.db.prepare("INSERT INTO students VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.alias, row.grade, row.subjects, row.goal, row.notes, row.createdAt);
    });
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
    if (this.writesBlocked) recover("数据库状态尚未确认。请重开并核对历史。");
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const previous = lookup(draft.id);
      if (previous && Object.entries(draft).some(([key, value]) => Reflect.get(previous, key) !== value)) {
        throw new WorkspaceFault("conflict", "该保存编号已经关联另一条内容，请核对档案或历史。");
      }
      const row = previous ? { ...previous } : { ...draft, createdAt: Date.now() };
      if (!previous) insert(row);
      committing = true;
      this.db.exec("COMMIT");
      return row;
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

  close(): void {
    this.db.close();
  }
}
