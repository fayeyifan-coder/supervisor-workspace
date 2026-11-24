import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Student, StudentInput } from "./contracts";
import { failure, WorkspaceFault, type WorkspaceDatabase } from "./database";
import type { GrowthFields, GrowthProfileDatabase, GrowthSaveInput } from "./growth-profile";
import { parseIntake, type IntakePreview } from "./intake-format";

export type IntakeFile = { name: string; token: string; source: IntakePreview } | { name: string; error: string };
export type IntakeTarget = { kind: "new" } | { kind: "existing"; studentId: string };
export interface IntakeReview {
  source: IntakePreview;
  target?: IntakeTarget;
  student?: Student;
  existing: GrowthFields;
  proposed: GrowthFields;
  revision: number;
  state: "unbound" | "ready" | "pending" | "review" | "done";
  message?: string;
  pendingId?: string;
  priorFields?: GrowthFields;
}
export interface IntakeConfirm {
  token: string;
  target: IntakeTarget;
  expectedRevision: number;
  student?: Omit<StudentInput, "id">;
  fields: GrowthFields;
  reviewed: true;
  pendingId?: string;
}
export interface IntakeOutcome {
  state: "saved" | "pending" | "review";
  studentId: string;
  studentConfirmed: boolean;
  message: string;
}
export interface IntakeHistoryEntry {
  source: IntakePreview;
  state: "pending" | "review" | "done";
  updatedAt: number;
}

const applicationId = 0x53574931;
const ddl = [
  "CREATE TABLE intake_bindings (code TEXT PRIMARY KEY, student_id TEXT NOT NULL UNIQUE) STRICT",
  "CREATE TABLE intake_jobs (digest TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES intake_bindings(code), source_json TEXT NOT NULL, plan_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','review','done')), student_confirmed INTEGER NOT NULL CHECK(student_confirmed IN (0,1)), updated_at INTEGER NOT NULL) STRICT",
  "CREATE INDEX intake_jobs_by_code ON intake_jobs(code, updated_at)"
] as const;
const objects = [...ddl, "sqlite_autoindex_intake_bindings_1", "sqlite_autoindex_intake_bindings_2", "sqlite_autoindex_intake_jobs_1"].sort();
const growthLimits = {
  learningCharacteristics: 2000, communicationPreferences: 1000,
  currentSituation: 2000, strengths: 1500, weakAreas: 1500,
};
const emptyFields: GrowthFields = {
  learningCharacteristics: "", communicationPreferences: "", currentSituation: "", strengths: "", weakAreas: "",
};
const fieldKeys = Object.keys(growthLimits) as Array<keyof GrowthFields>;
const invalid = (message: string): never => { throw new WorkspaceFault("invalid", message); };
const conflict = (message: string): never => { throw new WorkspaceFault("conflict", message); };
const recovery = (message: string): never => { throw new WorkspaceFault("recovery", message); };

interface Plan {
  target: IntakeTarget;
  newStudent?: StudentInput;
  growth: GrowthSaveInput;
}
interface Job {
  plan: Plan;
  state: IntakeHistoryEntry["state"];
  studentConfirmed: boolean;
}
interface Registered {
  source: IntakePreview;
  digest: string;
  prepared?: { target: IntakeTarget; revision: number };
}

function fileExists(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) recovery("导入数据库路径无效。请保留原文件。");
  return true;
}

export class IntakeStore {
  private writesBlocked = false;
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, marker: string): IntakeStore {
    const exists = fileExists(path);
    const initialized = fileExists(marker);
    const hasSidecar = ["-wal", "-shm", "-journal"].map(suffix => fileExists(path + suffix)).some(Boolean);
    if (exists) {
      const fd = openSync(path, "r");
      try {
        const header = Buffer.alloc(100);
        if (readSync(fd, header, 0, 100, 0) !== 100 ||
            header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
            header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1) {
          recovery("导入数据库身份或版本无法确认。请保留原文件。");
        }
      } finally { closeSync(fd); }
    } else {
      if (initialized || hasSidecar) recovery("导入数据库缺失。请保留初始化标记及侧车文件。");
      closeSync(openSync(path, "wx"));
    }

    const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500 });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
      const store = new IntakeStore(db);
      if (!exists) {
        store.transaction(() => {
          for (const sql of ddl) db.exec(sql);
          db.exec("PRAGMA application_id=" + applicationId + "; PRAGMA user_version=1");
        });
      }
      const schema = db.prepare("SELECT name,sql FROM main.sqlite_schema").all()
        .map(row => (row.sql ?? row.name) as string).sort();
      if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId ||
          db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
          JSON.stringify(schema) !== JSON.stringify(objects) ||
          db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
          db.prepare("PRAGMA foreign_key_check").get()) {
        recovery("导入数据库结构或完整性检查失败。请保留原文件。");
      }
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") recovery("无法启用导入数据库 WAL。");
      if (!initialized) writeFileSync(marker, "student-intake-v1\n", { flag: "wx", flush: true });
      return store;
    } catch (error) { db.close(); throw error; }
  }

  private transaction(action: () => void): void {
    if (this.writesBlocked) recovery("导入保存结果待确认，请重开应用并重新选择原 JSON 核对。");
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      action();
      committing = true;
      this.db.exec("COMMIT");
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); }
      catch { this.writesBlocked = true; committing = true; }
      if (committing) throw new WorkspaceFault("unknown", "导入保存结果待确认。请重试同一份 JSON。");
      throw error;
    }
  }

  binding(code: string): string | undefined {
    return this.db.prepare("SELECT student_id FROM intake_bindings WHERE code=?").get(code)?.student_id as string | undefined;
  }

  job(digest: string): Job | undefined {
    const row = this.db.prepare("SELECT plan_json,state,student_confirmed FROM intake_jobs WHERE digest=?").get(digest);
    return row ? { plan: JSON.parse(row.plan_json as string) as Plan,
      state: row.state as Job["state"], studentConfirmed: row.student_confirmed === 1 } : undefined;
  }

  hasOtherUnfinished(code: string, digest: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM intake_jobs WHERE code=? AND digest<>? AND state<>'done'").get(code, digest));
  }

  freeze(record: Registered, plan: Plan, studentConfirmed: boolean): void {
    const { source, digest } = record;
    const studentId = plan.growth.studentId;
    this.transaction(() => {
      const binding = this.binding(source.code);
      if (binding && binding !== studentId) conflict("该导入代号已绑定另一名学生。");
      const other = this.db.prepare("SELECT code FROM intake_bindings WHERE student_id=?").get(studentId);
      if (other && other.code !== source.code) conflict("该学生已绑定其他导入代号，请核对身份。");
      if (this.hasOtherUnfinished(source.code, digest)) conflict("该学生代号有未完成导入，请先重新选择原 JSON 处理。");
      const previous = this.job(digest);
      if (previous && previous.state !== "review") conflict("导入状态已变化，请重新预览。");
      if (!binding) this.db.prepare("INSERT INTO intake_bindings VALUES(?,?)").run(source.code, studentId);
      this.db.prepare("INSERT INTO intake_jobs VALUES(?,?,?,?, 'pending',?,?) ON CONFLICT(digest) DO UPDATE SET " +
        "plan_json=excluded.plan_json,state='pending',student_confirmed=excluded.student_confirmed,updated_at=excluded.updated_at")
        .run(digest, source.code, JSON.stringify(source), JSON.stringify(plan), Number(studentConfirmed), Date.now());
    });
  }

  update(digest: string, job: Job, state: Job["state"], studentConfirmed: boolean): void {
    this.transaction(() => {
      const current = this.job(digest);
      if (current?.state !== "pending" || current.plan.growth.requestId !== job.plan.growth.requestId) {
        conflict("导入状态已变化，请重新预览。");
      }
      this.db.prepare("UPDATE intake_jobs SET state=?,student_confirmed=?,updated_at=? WHERE digest=?")
        .run(state, Number(studentConfirmed), Date.now(), digest);
    });
  }

  requireWritable(): void {
    if (this.writesBlocked) recovery("导入数据库状态待确认，请重开应用后核对。");
  }

  history(studentId: string): IntakeHistoryEntry[] {
    return this.db.prepare("SELECT source_json,state,updated_at FROM intake_jobs JOIN intake_bindings USING(code) " +
      "WHERE student_id=? ORDER BY updated_at DESC,digest DESC LIMIT 20").all(studentId).map(row => ({
      source: JSON.parse(row.source_json as string) as IntakePreview,
      state: row.state as Job["state"], updatedAt: row.updated_at as number,
    }));
  }

  close(): void { this.db.close(); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map(key => JSON.stringify(key) + ":" + canonical(obj[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function matches(a: IntakeTarget, b: IntakeTarget): boolean {
  return a.kind === "new" ? b.kind === "new" : b.kind === "existing" && a.studentId === b.studentId;
}

function checkedTarget(value: unknown): IntakeTarget {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const target = value as Partial<IntakeTarget>;
    if (target.kind === "new") return { kind: "new" };
    if (target.kind === "existing" && typeof target.studentId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.studentId)) {
      return { kind: "existing", studentId: target.studentId };
    }
  }
  return invalid("请选择新建学生或明确选择一个本地学生档案。");
}

function checkedText(raw: unknown, max: number, label: string, required = false): string {
  if (typeof raw !== "string" || raw.length > max || raw.includes("\0") || (required && !raw.trim())) {
    return invalid(label + "无效，长度上限为 " + max + " 字。");
  }
  return raw.trim();
}

export class StudentIntakeService {
  private readonly files = new Map<string, Registered>();
  constructor(private readonly store: IntakeStore,
    private readonly students: Pick<WorkspaceDatabase, "students" | "createStudent">,
    private readonly growth: Pick<GrowthProfileDatabase, "load" | "save">) {}

  clearFiles(): void { this.files.clear(); }

  register(name: string, raw: string): Extract<IntakeFile, { token: string }> {
    if (this.files.size >= 20) invalid("每批最多预览 20 份 JSON。");
    const source = parseIntake(raw);
    const digest = createHash("sha256").update(canonical(source.source)).digest("hex");
    const token = randomUUID();
    this.files.set(token, { source, digest });
    return { name, token, source };
  }

  private file(token: unknown): Registered {
    const file = typeof token === "string" ? this.files.get(token) : undefined;
    return file ?? invalid("预览已失效，请重新选择 JSON。");
  }

  private student(id: string): Student | undefined {
    return this.students.students().find(student => student.id === id);
  }

  prepare(token: string, requested?: IntakeTarget): IntakeReview {
    const file = this.file(token);
    const { source, digest } = file;
    file.prepared = undefined;
    const job = this.store.job(digest);
    const binding = this.store.binding(source.code);
    const boundStudent = binding ? this.student(binding) : undefined;
    let target = requested === undefined ? undefined : checkedTarget(requested);
    if (binding) {
      const boundTarget = job?.state === "pending" ? job.plan.target
        : boundStudent ? { kind: "existing", studentId: binding } as const : { kind: "new" } as const;
      if (target && !matches(target, boundTarget)) conflict("该导入代号已有绑定，不能切换至其他学生。");
      target = boundTarget;
      if (!boundStudent && job?.studentConfirmed) recovery("已绑定的学生档案缺失，请核对本地数据。");
    }
    const student = target?.kind === "existing" ? this.student(target.studentId) : boundStudent;
    if (target?.kind === "existing" && !student) invalid("找不到所选学生，请重新选择。");
    const view = student ? this.growth.load(student.id) : undefined;
    const existing = { ...emptyFields };
    const proposed = { ...emptyFields };
    for (const key of fieldKeys) {
      existing[key] = view?.[key] ?? "";
      proposed[key] = job?.state === "pending" ? job.plan.growth[key] : existing[key] || source.growth[key];
    }
    const priorFields = job?.state === "review" ? { ...emptyFields } : undefined;
    if (priorFields && job) {
      for (const key of fieldKeys) priorFields[key] = job.plan.growth[key];
    }
    const revision = view?.revision ?? 0;
    if (target) file.prepared = { target, revision };
    const message = job?.state === "review" ? "档案版本发生变化。请核对当前档案后重新确认。"
      : job?.state === "pending" ? (job.studentConfirmed ? "学生档案已确认，成长档案导入尚待确认。" : "导入尚待确认。")
        : undefined;
    return { source, target, student, existing, proposed, revision, message, priorFields,
      state: job?.state ?? (target ? "ready" : "unbound"),
      pendingId: job?.state === "pending" ? job.plan.growth.requestId : undefined,
    };
  }

  confirm(raw: IntakeConfirm): IntakeOutcome {
    this.store.requireWritable();
    if (!raw || typeof raw !== "object" || raw.reviewed !== true) invalid("请先核对身份和导入内容。");
    const file = this.file(raw.token);
    const target = checkedTarget(raw.target);
    const job = this.store.job(file.digest);
    const binding = this.store.binding(file.source.code);
    if (!file.prepared || !matches(file.prepared.target, target)) conflict("导入目标已变化，请重新预览并核对身份。");
    if (job?.state === "done") {
      if (!matches(target, job.plan.target) && (target.kind !== "existing" || target.studentId !== binding)) {
        conflict("这份资料已导入另一个学生档案，请重新预览。");
      }
      return { state: "saved", studentId: job.plan.growth.studentId, studentConfirmed: true, message: "此份资料已导入。" };
    }
    if (job?.state === "pending") {
      if (!matches(target, job.plan.target) || raw.pendingId !== job.plan.growth.requestId) conflict("请重新预览并重试同一笔导入。");
      return this.apply(file.digest, job);
    }

    if (!raw.fields || typeof raw.fields !== "object" || Array.isArray(raw.fields)) invalid("成长内容无效。");
    const fields = { ...emptyFields };
    for (const key of fieldKeys) fields[key] = checkedText(raw.fields[key], growthLimits[key], "成长档案字段");
    let draft: StudentInput | undefined;
    const studentId = target.kind === "existing" ? target.studentId : binding ?? randomUUID();
    if (binding && binding !== studentId) conflict("该导入代号已有绑定，请重新预览。");
    if (target.kind === "new") {
      if (binding && this.student(binding)) conflict("该代号已关联本地档案，请重新预览。");
      if (!raw.student || typeof raw.student !== "object" || Array.isArray(raw.student)) invalid("请填写新学生档案。");
      draft = {
        id: studentId, alias: checkedText(raw.student!.alias, 40, "学生代号", true),
        grade: checkedText(raw.student!.grade, 30, "年级", true),
        subjects: checkedText(raw.student!.subjects, 100, "学科", true),
        goal: checkedText(raw.student!.goal, 300, "学习目标"),
        notes: checkedText(raw.student!.notes, 500, "备注"),
      };
      const aliases = [file.source.code, draft.alias].map(alias => alias.toUpperCase());
      if (this.students.students().some(student => aliases.includes(student.alias.toUpperCase()))) {
        conflict("本地已有相同代号或显示名称。请核对后明确关联已有学生。");
      }
    } else if (!this.student(studentId)) invalid("找不到所选学生，请重新选择。");
    const current = target.kind === "existing" ? this.growth.load(studentId) : undefined;
    if (raw.expectedRevision !== file.prepared!.revision || raw.expectedRevision !== (current?.revision ?? 0)) {
      conflict("成长档案版本已变化，请重新预览并核对修改。");
    }
    const plan: Plan = {
      target, newStudent: draft,
      growth: { requestId: randomUUID(), studentId, expectedRevision: raw.expectedRevision, ...fields,
        goals: current?.goals.map(({ id, subject, targetScore, deadline, strategy, status }) =>
          ({ id, subject, targetScore, deadline, strategy, status })) ?? [],
        observations: [],
      },
    };
    const studentConfirmed = target.kind === "existing";
    this.store.freeze(file, plan, studentConfirmed);
    return this.apply(file.digest, { plan, state: "pending", studentConfirmed });
  }

  private apply(digest: string, job: Job): IntakeOutcome {
    const { plan } = job;
    const studentId = plan.growth.studentId;
    let studentConfirmed = job.studentConfirmed;
    let growthSaved = false;
    try {
      // The frozen M1 UUID and Growth request ID are reused after a lost result or a restart.
      if (!studentConfirmed && plan.newStudent) {
        this.students.createStudent(plan.newStudent);
        studentConfirmed = true;
        this.store.update(digest, job, "pending", true);
      }
      if (!studentConfirmed || !this.student(studentId)) recovery("学生档案缺失，请核对后重试原导入。");
      try {
        this.growth.save(plan.growth, id => id === studentId && Boolean(this.student(id)));
        growthSaved = true;
      } catch (error) {
        const result = failure(error);
        if (result.code === "conflict") {
          this.store.update(digest, job, "review", studentConfirmed);
          return { state: "review", studentId, studentConfirmed,
            message: "学生档案已确认。成长档案有冲突，请重新预览后核对。" };
        }
        throw error;
      }
      this.store.update(digest, job, "done", true);
      return { state: "saved", studentId, studentConfirmed: true, message: "学生档案与成长档案导入已确认。" };
    } catch (error) {
      const result = failure(error);
      const status = growthSaved ? "成长档案已保存，导入凭据尚未确认。"
        : studentConfirmed ? "学生档案已确认，成长档案导入尚未确认。" : "学生档案结果尚未确认。";
      return { state: "pending", studentId, studentConfirmed, message: status + result.message + "请重试同一笔导入。" };
    }
  }

  history(studentId: string): IntakeHistoryEntry[] {
    if (typeof studentId !== "string" || !this.student(studentId)) invalid("找不到所选学生。");
    return this.store.history(studentId);
  }
}
