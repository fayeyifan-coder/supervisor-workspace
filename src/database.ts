import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DatabaseDetails, SampleRecord, SaveSample } from "./contracts";

const applicationId = 0x53575031;
const migrations = [
  `CREATE TABLE sample_record (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;`,
];

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateSample(input: unknown): SaveSample {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("记录格式无效。");
  }
  const { content, expectedRevision } = input as Partial<SaveSample>;
  if (typeof content !== "string") throw new Error("请输入虚构测试内容。");
  const text = content.length <= 400 ? content.trim() : "";
  if (!text || Array.from(text).length > 200 || text.includes("\0")) {
    throw new Error("测试内容需为 1 至 200 个字符。");
  }
  if (expectedRevision !== null && (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
  )) {
    throw new Error("记录版本无效，请重开窗口。");
  }
  return { content: text, expectedRevision };
}

export class SampleDatabase {
  private readonly readRecord: StatementSync;

  private constructor(
    private readonly db: DatabaseSync,
    readonly details: DatabaseDetails,
  ) {
    this.readRecord = db.prepare(`SELECT content, revision,
      created_at AS createdAt, updated_at AS updatedAt
      FROM sample_record WHERE id = 1`);
  }

  static open(databasePath: string, initializedMarker: string): SampleDatabase {
    const exists = entryExists(databasePath);
    if (exists) {
      const entry = lstatSync(databasePath);
      if (!entry.isFile() || entry.size === 0) {
        throw new Error("数据路径不是有效数据库文件。");
      }
    } else {
      const traces = [initializedMarker, databasePath + "-wal", databasePath + "-shm",
        databasePath + "-journal"];
      if (traces.some(entryExists)) throw new Error("已初始化的数据库文件缺失。");
      mkdirSync(dirname(databasePath), { recursive: true });
      closeSync(openSync(databasePath, "wx"));
    }

    const db = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 1500,
    });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      if (exists) {
        if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId) {
          throw new Error("数据库应用标识不匹配。");
        }
        if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
          throw new Error("数据库一致性检查失败。");
        }
      }
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (!Number.isInteger(version) || version > migrations.length || (exists && version < 1)) {
        throw new Error("数据库版本不受支持。");
      }
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      if (version < migrations.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(`PRAGMA application_id = ${applicationId}`);
          for (const migration of migrations.slice(version)) db.exec(migration);
          db.exec(`PRAGMA user_version = ${migrations.length}; COMMIT`);
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      }
      const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS value").get()?.value);
      const store = new SampleDatabase(db, { databasePath, schemaVersion: migrations.length, sqliteVersion });
      if (!entryExists(initializedMarker)) writeFileSync(initializedMarker, "1\n", { flag: "wx" });
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  read(): SampleRecord | null {
    return this.readRecord.get() as unknown as SampleRecord | undefined ?? null;
  }

  save(input: unknown): SampleRecord {
    const { content, expectedRevision } = validateSample(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new Error("记录版本已变化，请重开窗口后再保存。");
      }
      if (current) {
        this.db.prepare(`UPDATE sample_record SET content = ?, revision = revision + 1,
          updated_at = ? WHERE id = 1`).run(content, Math.max(Date.now(), current.updatedAt));
      } else {
        const now = Date.now();
        this.db.prepare(`INSERT INTO sample_record
          (id, content, revision, created_at, updated_at) VALUES (1, ?, 1, ?, ?)`)
          .run(content, now, now);
      }
      const saved = this.read();
      if (!saved) throw new Error("保存后未读到记录。");
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
