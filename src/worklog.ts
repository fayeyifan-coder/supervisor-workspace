import { closeSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Failure } from "./contracts";
import { WorkspaceFault } from "./database";

export type WorkStatus = "open" | "done" | "cancelled";
export interface WorkItemInput {
  id: string; title: string; workDate: string; studentId: string | null;
  startedAt: string; notes: string; nextStep: string;
}
export interface WorkItem extends WorkItemInput {
  status: WorkStatus; createdAt: number; updatedAt: number; completedAt: number | null;
}
export interface WorkChange { id: string; itemId: string; changedAt: number; snapshot: WorkItem }

const appId = 0x53574231;
const schemaVersion = 1;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const worklogDdl = `          CREATE TABLE work_items(
            id TEXT PRIMARY KEY, title TEXT NOT NULL, work_date TEXT NOT NULL,
            student_id TEXT, started_at TEXT NOT NULL, notes TEXT NOT NULL, next_step TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
          ) STRICT;
          CREATE INDEX work_items_by_date ON work_items(work_date DESC, updated_at DESC, id DESC);
          CREATE TABLE work_changes(
            id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id),
            changed_at INTEGER NOT NULL, snapshot TEXT NOT NULL
          ) STRICT;
`;

export class WorkLogFault extends WorkspaceFault {
  constructor(code: Failure["code"], message: string) { super(code, message); }
}

function invalid(message: string): never { throw new WorkLogFault("invalid", message); }
function checkDate(value: unknown): string {
  if (typeof value === "string" && /^(?!0000)\d{4}-\d\d-\d\d$/.test(value)) {
    const date = new Date(value + "T00:00:00Z");
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  return invalid("工作日期无效。");
}
function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) {
    return invalid(label + "内容无效。");
  }
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return invalid("工作事项编号无效。");
  return value;
}

export class WorkLogDatabase {
  private writesBlocked = false;
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, marker: string): WorkLogDatabase {
    const exists = lstatSync(path, { throwIfNoEntry: false });
    const initialized = lstatSync(marker, { throwIfNoEntry: false });
    if (exists && (!exists.isFile() || exists.isSymbolicLink() || exists.nlink !== 1)) {
      throw new WorkLogFault("recovery", "工作日志数据库路径无效，请保留文件并联系支持。");
    }
    if (initialized && (!initialized.isFile() || initialized.isSymbolicLink() || initialized.nlink !== 1)) {
      throw new WorkLogFault("recovery", "工作日志初始化标记无效。");
    }
    const hasSidecars = ["-wal", "-shm", "-journal"].map(suffix => {
      const sidecar = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (!sidecar) return false;
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1) {
        throw new WorkLogFault("recovery", "工作日志 SQLite 侧车身份无效。请保留原文件。");
      }
      return true;
    }).some(Boolean);
    if (exists) {
      const fd = openSync(path, "r");
      try {
        const header = Buffer.alloc(100);
        if (readSync(fd, header, 0, 100, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
            header.readUInt32BE(68) !== appId || header.readUInt32BE(60) !== schemaVersion) {
          throw new WorkLogFault("recovery", "工作日志数据库身份或版本无法确认，请保留文件。");
        }
      } finally { closeSync(fd); }
    } else {
      if (initialized || hasSidecars) {
        throw new WorkLogFault("recovery", "工作日志主库缺失但存在初始化状态，请保留文件。");
      }
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "wx"));
    }
    const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500 });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
      if (!exists) {
        db.exec(`BEGIN IMMEDIATE;${worklogDdl}PRAGMA application_id=${appId}; PRAGMA user_version=${schemaVersion}; COMMIT;`);
      } else if (db.prepare("PRAGMA application_id").get()?.application_id !== appId ||
          db.prepare("PRAGMA user_version").get()?.user_version !== schemaVersion ||
          db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
        throw new WorkLogFault("recovery", "工作日志数据库结构或完整性检查失败，请保留文件。");
      }
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") throw new Error("WAL unavailable");
      if (!initialized) writeFileSync(marker, "worklog-v1\n", { flag: "wx", flush: true });
      return new WorkLogDatabase(db);
    } catch (error) { db.close(); throw error; }
  }

  list(today: string): WorkItem[] {
    const day = checkDate(today);
    return this.db.prepare("SELECT * FROM work_items WHERE status='open' AND work_date<=? ORDER BY work_date, created_at, id")
      .all(day).map(row => this.toItem(row));
  }

  search(from: string, to: string, query = ""): WorkItem[] {
    const start = checkDate(from), end = checkDate(to);
    if (start > end) invalid("查询日期范围无效。");
    const q = cleanText(query, "查询", 100);
    return this.db.prepare(`SELECT * FROM work_items WHERE work_date BETWEEN ? AND ? AND
      (title LIKE ? OR notes LIKE ? OR next_step LIKE ?) ORDER BY work_date DESC, updated_at DESC LIMIT 500`)
      .all(start, end, "%" + q + "%", "%" + q + "%", "%" + q + "%").map(row => this.toItem(row));
  }

  history(itemId: unknown): WorkChange[] {
    const key = id(itemId);
    return this.db.prepare("SELECT id,item_id AS itemId,changed_at AS changedAt,snapshot FROM work_changes WHERE item_id=? ORDER BY changed_at,id")
      .all(key).map(row => ({ id: row.id as string, itemId: row.itemId as string, changedAt: row.changedAt as number,
        snapshot: JSON.parse(row.snapshot as string) as WorkItem }));
  }

  save(raw: unknown, studentExists: (studentId: string) => boolean): WorkItem {
    this.assertWritesAllowed();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("工作事项无效。");
    const input = raw as Partial<WorkItemInput>;
    const itemId = id(input.id);
    const studentId = input.studentId === null ? null : id(input.studentId);
    if (studentId && !studentExists(studentId)) invalid("关联的学生档案不存在。");
    const values = {
      id: itemId, title: cleanText(input.title, "标题", 160, true), workDate: checkDate(input.workDate), studentId,
      startedAt: cleanText(input.startedAt, "执行时间", 30), notes: cleanText(input.notes, "备注", 1000),
      nextStep: cleanText(input.nextStep, "下一步", 500),
    };
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const prior = this.db.prepare("SELECT * FROM work_items WHERE id=?").get(itemId);
      if (prior && this.matchesInput(prior, values)) {
        committing = true; this.db.exec("COMMIT"); return this.toItem(prior);
      }
      const item: WorkItem = prior ? { ...this.toItem(prior), ...values, updatedAt: now } : {
        ...values, status: "open", createdAt: now, updatedAt: now, completedAt: null,
      };
      this.db.prepare(`INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,work_date=excluded.work_date,student_id=excluded.student_id,started_at=excluded.started_at,
        notes=excluded.notes,next_step=excluded.next_step,updated_at=excluded.updated_at`).run(
        item.id,item.title,item.workDate,item.studentId,item.startedAt,item.notes,item.nextStep,item.status,item.createdAt,item.updatedAt,item.completedAt);
      this.appendChange(item);
      committing = true; this.db.exec("COMMIT"); return item;
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); } catch { this.writesBlocked = true; committing = true; }
      if (committing) throw new WorkLogFault("unknown", "保存结果待确认，请重开并核对工作历史。");
      throw error;
    }
  }

  setStatus(rawId: unknown, status: WorkStatus): WorkItem {
    this.assertWritesAllowed();
    const itemId = id(rawId);
    if (!["open", "done", "cancelled"].includes(status)) invalid("工作状态无效。");
    this.db.exec("BEGIN IMMEDIATE"); let committing = false;
    try {
      const row = this.db.prepare("SELECT * FROM work_items WHERE id=?").get(itemId);
      if (!row) invalid("找不到工作事项。");
      const prior = this.toItem(row);
      if (prior.status === status && (status !== "done" || prior.completedAt !== null)) {
        committing = true; this.db.exec("COMMIT"); return prior;
      }
      const now = Date.now();
      const item = { ...prior, status, updatedAt: now,
        completedAt: status === "done" ? (prior.completedAt ?? now) : null };
      this.db.prepare("UPDATE work_items SET status=?,updated_at=?,completed_at=? WHERE id=?")
        .run(status, now, item.completedAt, itemId);
      this.appendChange(item); committing = true; this.db.exec("COMMIT"); return item;
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); } catch { this.writesBlocked = true; committing = true; }
      if (committing) throw new WorkLogFault("unknown", "状态保存结果待确认。"); throw error;
    }
  }

  private appendChange(item: WorkItem): void {
    this.db.prepare("INSERT INTO work_changes VALUES(?,?,?,?)")
      .run(crypto.randomUUID(), item.id, Date.now(), JSON.stringify(item));
  }
  private matchesInput(row: Record<string, unknown>, input: WorkItemInput): boolean {
    return row.id === input.id && row.title === input.title && row.work_date === input.workDate &&
      row.student_id === input.studentId && row.started_at === input.startedAt && row.notes === input.notes &&
      row.next_step === input.nextStep;
  }
  private assertWritesAllowed(): void {
    if (this.writesBlocked) throw new WorkLogFault("unknown", "工作日志状态待确认，请重开应用后核对记录。");
  }
  private toItem(row: Record<string, unknown>): WorkItem {
    return { id: row.id as string, title: row.title as string, workDate: row.work_date as string,
      studentId: row.student_id as string | null, startedAt: row.started_at as string, notes: row.notes as string,
      nextStep: row.next_step as string, status: row.status as WorkStatus, createdAt: row.created_at as number,
      updatedAt: row.updated_at as number, completedAt: row.completed_at as number | null };
  }
  protectionConnection(): DatabaseSync {
    if (this.writesBlocked || this.db.isTransaction) throw new WorkspaceFault("busy", "本地数据库写入状态仍待确定，无法导出。");
    return this.db;
  }

  close(): void {
    const blocked = this.writesBlocked;
    this.db.close();
    if (blocked) throw new WorkLogFault("unknown", "工作日志状态待确认。");
  }
}

export const worklogProtection = {
  key: "worklog", marker: "worklog-v1\n", applicationId: appId, version: schemaVersion,
  tables: ["work_items", "work_changes"], ddl: [worklogDdl],
};
