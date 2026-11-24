import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Failure } from "./contracts";
import { WorkspaceFault } from "./database";

export type GoalStatus = "active" | "achieved" | "paused";
export interface GrowthGoalInput {
  id: string; subject: string; targetScore: number; deadline: string; strategy: string; status: GoalStatus;
}
export interface GrowthGoal extends GrowthGoalInput { createdAt: number; updatedAt: number }
export interface GrowthObservationInput { id: string; observedOn: string; content: string }
export interface GrowthObservation extends GrowthObservationInput { createdAt: number }
export interface GrowthFields {
  learningCharacteristics: string;
  communicationPreferences: string;
  currentSituation: string;
  strengths: string;
  weakAreas: string;
}
export interface GrowthSnapshot extends GrowthFields {
  revision: number; updatedAt: number; goals: GrowthGoal[]; observations: GrowthObservation[];
}
export interface GrowthHistory { revision: number; requestId: string; changedAt: number; snapshot: GrowthSnapshot }
export interface GrowthProfileView extends GrowthFields {
  studentId: string; exists: boolean; revision: number; updatedAt: number | null;
  goals: GrowthGoal[]; observations: GrowthObservation[]; history: GrowthHistory[];
}
export interface GrowthSaveInput extends GrowthFields {
  requestId: string; studentId: string; expectedRevision: number;
  goals: GrowthGoalInput[]; observations: GrowthObservationInput[];
}

const applicationId = 0x53574331;
const schemaVersion = 1;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const schema = [
  ["growth_profiles", "table", `CREATE TABLE growth_profiles (
    student_id TEXT PRIMARY KEY, learning_characteristics TEXT NOT NULL,
    communication_preferences TEXT NOT NULL, current_situation TEXT NOT NULL,
    strengths TEXT NOT NULL, weak_areas TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at INTEGER NOT NULL
  ) STRICT`],
  ["growth_goals", "table", `CREATE TABLE growth_goals (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES growth_profiles(student_id),
    subject TEXT NOT NULL, target_score INTEGER NOT NULL CHECK(target_score BETWEEN 0 AND 100),
    deadline TEXT NOT NULL, strategy TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','achieved','paused')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT`],
  ["growth_observations", "table", `CREATE TABLE growth_observations (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES growth_profiles(student_id),
    observed_on TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT`],
  ["growth_requests", "table", `CREATE TABLE growth_requests (
    request_id TEXT PRIMARY KEY, student_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, saved_at INTEGER NOT NULL
  ) STRICT`],
  ["growth_history", "table", `CREATE TABLE growth_history (
    student_id TEXT NOT NULL REFERENCES growth_profiles(student_id), revision INTEGER NOT NULL,
    request_id TEXT NOT NULL REFERENCES growth_requests(request_id), changed_at INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, PRIMARY KEY(student_id, revision)
  ) STRICT`],
  ["growth_goals_by_student", "index", "CREATE INDEX growth_goals_by_student ON growth_goals(student_id, status, deadline, id)"],
  ["growth_observations_by_date", "index", "CREATE INDEX growth_observations_by_date ON growth_observations(student_id, observed_on DESC, created_at DESC, id DESC)"],
] as const;
const profileColumns = "student_id AS studentId, learning_characteristics AS learningCharacteristics, " +
  "communication_preferences AS communicationPreferences, current_situation AS currentSituation, " +
  "strengths, weak_areas AS weakAreas, revision, updated_at AS updatedAt";

export class GrowthProfileFault extends WorkspaceFault {
  constructor(code: Failure["code"], message: string) { super(code, message); }
}

function invalid(message: string): never { throw new GrowthProfileFault("invalid", message); }
function recovery(message: string): never { throw new GrowthProfileFault("recovery", message); }
function checkId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !uuid.test(raw)) return invalid(label + "编号无效。");
  return raw;
}
function cleanText(raw: unknown, label: string, max: number, required = false): string {
  if (typeof raw !== "string" || raw.length > max || raw.includes("\0") || (required && !raw.trim())) {
    return invalid(label + (required ? "不能为空" : "内容无效") + "。");
  }
  return raw.trim();
}
function date(raw: unknown, label: string): string {
  if (typeof raw === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(raw + "T00:00:00Z");
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw) return raw;
  }
  return invalid(label + "日期无效。");
}
function fileExists(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) recovery("成长档案数据库路径无效。请保留文件后联系支持。");
  return true;
}
function checkHeader(path: string): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== schemaVersion) {
      recovery("成长档案数据库身份或版本无法确认。请保留原目录及侧车文件。");
    }
  } finally { closeSync(fd); }
}
function checkDatabase(db: DatabaseSync): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId ||
      db.prepare("PRAGMA user_version").get()?.user_version !== schemaVersion) recovery("成长档案数据库身份或版本无法确认。");
  const definitions = db.prepare("SELECT name,type,sql FROM main.sqlite_schema").all();
  const canonical = (sql: string) => sql.replace(/\s+/g, " ");
  const explicit = schema.every(([name, type, sql]) => definitions.some(row =>
    row.name === name && row.type === type && typeof row.sql === "string" && canonical(row.sql) === canonical(sql)));
  const automatic = ["sqlite_autoindex_growth_profiles_1", "sqlite_autoindex_growth_goals_1",
    "sqlite_autoindex_growth_observations_1", "sqlite_autoindex_growth_requests_1", "sqlite_autoindex_growth_history_1"];
  const implicit = automatic.every(name => definitions.some(row => row.name === name && row.type === "index" && row.sql === null));
  if (definitions.length !== schema.length + automatic.length || !explicit || !implicit ||
      db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
    recovery("成长档案数据库结构或完整性检查失败。请保留原目录。");
  }
}
function fields(raw: unknown): GrowthFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("成长档案内容无效。");
  const input = raw as Partial<GrowthFields>;
  return {
    learningCharacteristics: cleanText(input.learningCharacteristics, "学习特点", 2000),
    communicationPreferences: cleanText(input.communicationPreferences, "沟通偏好", 1000),
    currentSituation: cleanText(input.currentSituation, "当前学情", 2000),
    strengths: cleanText(input.strengths, "当前优势", 1500),
    weakAreas: cleanText(input.weakAreas, "当前薄弱项", 1500),
  };
}
function goal(raw: unknown): GrowthGoalInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("提分目标无效。");
  const input = raw as Partial<GrowthGoalInput>;
  if (!Number.isInteger(input.targetScore) || (input.targetScore as number) < 0 || (input.targetScore as number) > 100) {
    invalid("目标分数须为 0 至 100 的整数。");
  }
  if (input.status !== "active" && input.status !== "achieved" && input.status !== "paused") invalid("目标状态无效。");
  return { id: checkId(input.id, "目标"), subject: cleanText(input.subject, "目标学科", 40, true),
    targetScore: input.targetScore as number, deadline: date(input.deadline, "目标期限"),
    strategy: cleanText(input.strategy, "干预策略", 1000, true), status: input.status };
}
function observation(raw: unknown): GrowthObservationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("学习观察无效。");
  const input = raw as Partial<GrowthObservationInput>;
  return { id: checkId(input.id, "观察"), observedOn: date(input.observedOn, "观察"),
    content: cleanText(input.content, "观察记录", 1000, true) };
}
function sortedJson(value: unknown): string { return JSON.stringify(value); }

export class GrowthProfileDatabase {
  private writesBlocked = false;
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, marker: string): GrowthProfileDatabase {
    const exists = fileExists(path), initialized = fileExists(marker);
    const sidecars = ["-wal", "-shm", "-journal"].map(suffix => fileExists(path + suffix));
    if (exists) checkHeader(path);
    else {
      if (initialized || sidecars.some(Boolean)) recovery("成长档案主库缺失但存在初始化状态，请保留文件及侧车文件。");
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "wx"));
    }
    const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 1500 });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
      if (!exists) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const [, , sql] of schema) db.exec(sql);
          db.exec("PRAGMA application_id=" + applicationId + "; PRAGMA user_version=" + schemaVersion);
          checkDatabase(db);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      } else checkDatabase(db);
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") recovery("无法启用成长档案数据库 WAL。");
      if (!initialized) writeFileSync(marker, "growth-profile-v1\n", { flag: "wx", flush: true });
      return new GrowthProfileDatabase(db);
    } catch (error) { db.close(); throw error; }
  }

  load(rawStudentId: unknown): GrowthProfileView {
    const studentId = checkId(rawStudentId, "学生");
    const row = this.db.prepare("SELECT " + profileColumns + " FROM growth_profiles WHERE student_id=?").get(studentId);
    const profile: GrowthFields = row ? {
      learningCharacteristics: row.learningCharacteristics as string,
      communicationPreferences: row.communicationPreferences as string,
      currentSituation: row.currentSituation as string,
      strengths: row.strengths as string,
      weakAreas: row.weakAreas as string,
    } : { learningCharacteristics: "", communicationPreferences: "", currentSituation: "", strengths: "", weakAreas: "" };
    const goals = this.goals(studentId), observations = this.observations(studentId);
    const history = this.historyRows(studentId);
    return { studentId, exists: Boolean(row), revision: row ? row.revision as number : 0,
      updatedAt: row ? row.updatedAt as number : null, ...profile, goals, observations, history };
  }

  save(raw: unknown, studentExists: (studentId: string) => boolean): GrowthProfileView {
    if (this.writesBlocked) throw new GrowthProfileFault("unknown", "成长档案保存状态待确认，请重开应用后核对历史。");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("成长档案保存内容无效。");
    const input = raw as Partial<GrowthSaveInput>;
    const requestId = checkId(input.requestId, "请求"), studentId = checkId(input.studentId, "学生");
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) invalid("档案版本无效。");
    if (!studentExists(studentId)) invalid("关联的 M1 学生档案不存在，请重新选择学生。");
    if (!Array.isArray(input.goals) || input.goals.length > 30 || !Array.isArray(input.observations) || input.observations.length > 500) {
      invalid("目标或观察数量超出允许范围。");
    }
    const profileFields = fields(input), goals = input.goals.map(goal), observations = input.observations.map(observation);
    if (new Set(goals.map(item => item.id)).size !== goals.length || new Set(observations.map(item => item.id)).size !== observations.length) {
      invalid("目标或观察编号重复。");
    }
    const payload = { studentId, expectedRevision: input.expectedRevision, ...profileFields,
      goals: [...goals].sort((a, b) => a.id.localeCompare(b.id)),
      observations: [...observations].sort((a, b) => a.id.localeCompare(b.id)) };
    const payloadHash = createHash("sha256").update(sortedJson(payload)).digest("hex");

    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const priorRequest = this.db.prepare("SELECT student_id AS studentId,payload_hash AS payloadHash,result_json AS resultJson FROM growth_requests WHERE request_id=?")
        .get(requestId);
      if (priorRequest) {
        if (priorRequest.studentId !== studentId || priorRequest.payloadHash !== payloadHash) {
          throw new GrowthProfileFault("conflict", "该请求编号已用于其他内容，请保留当前修改并重新读取。");
        }
        const result = JSON.parse(priorRequest.resultJson as string) as GrowthProfileView;
        committing = true; this.db.exec("COMMIT"); return result;
      }

      const currentRow = this.db.prepare("SELECT revision FROM growth_profiles WHERE student_id=?").get(studentId);
      const currentRevision = currentRow ? currentRow.revision as number : 0;
      if (currentRevision !== input.expectedRevision) throw new GrowthProfileFault("conflict", "档案已被其他操作更新，请重新读取后核对修改。");
      const existingGoals = this.goals(studentId), existingById = new Map(existingGoals.map(item => [item.id, item]));
      const inputGoalIds = new Set(goals.map(item => item.id));
      if (existingGoals.some(item => !inputGoalIds.has(item.id))) invalid("已有目标不能直接删除，请将其状态改为暂停或已完成。");
      for (const item of goals) {
        const existing = this.db.prepare("SELECT student_id AS studentId FROM growth_goals WHERE id=?").get(item.id);
        if (existing && existing.studentId !== studentId) invalid("目标编号属于另一名学生。");
      }
      const existingObservations = new Map(this.observations(studentId).map(item => [item.id, item]));
      for (const item of observations) {
        const existing = this.db.prepare("SELECT student_id AS studentId,observed_on AS observedOn,content FROM growth_observations WHERE id=?").get(item.id);
        if (existing && (existing.studentId !== studentId || existing.observedOn !== item.observedOn || existing.content !== item.content)) {
          invalid("历史观察编号已关联其他学生或内容。");
        }
      }
      const currentProfile = currentRow ? this.load(studentId) : undefined;
      const profileChanged = !currentProfile || Object.keys(profileFields).some(key =>
        profileFields[key as keyof GrowthFields] !== currentProfile[key as keyof GrowthFields]);
      const goalsChanged = goals.some(item => {
        const existing = existingById.get(item.id);
        return !existing || existing.subject !== item.subject || existing.targetScore !== item.targetScore ||
          existing.deadline !== item.deadline || existing.strategy !== item.strategy || existing.status !== item.status;
      });
      const newObservations = observations.filter(item => !existingObservations.has(item.id));
      const changed = profileChanged || goalsChanged || newObservations.length > 0;
      const now = Date.now(), nextRevision = changed ? currentRevision + 1 : currentRevision;
      if (!currentRow) {
        this.db.prepare("INSERT INTO growth_profiles VALUES(?,?,?,?,?,?,?,?)").run(studentId,
          profileFields.learningCharacteristics, profileFields.communicationPreferences, profileFields.currentSituation,
          profileFields.strengths, profileFields.weakAreas, nextRevision, now);
      } else if (changed) {
        this.db.prepare(`UPDATE growth_profiles SET learning_characteristics=?,communication_preferences=?,current_situation=?,
          strengths=?,weak_areas=?,revision=?,updated_at=? WHERE student_id=?`).run(
          profileFields.learningCharacteristics, profileFields.communicationPreferences, profileFields.currentSituation,
          profileFields.strengths, profileFields.weakAreas, nextRevision, now, studentId);
      }
      for (const item of goals) {
        const existing = existingById.get(item.id);
        if (existing && existing.subject === item.subject && existing.targetScore === item.targetScore &&
            existing.deadline === item.deadline && existing.strategy === item.strategy && existing.status === item.status) continue;
        if (existing) this.db.prepare(`UPDATE growth_goals SET subject=?,target_score=?,deadline=?,strategy=?,status=?,updated_at=? WHERE id=? AND student_id=?`)
          .run(item.subject, item.targetScore, item.deadline, item.strategy, item.status, now, item.id, studentId);
        else this.db.prepare("INSERT INTO growth_goals VALUES(?,?,?,?,?,?,?,?,?)")
          .run(item.id, studentId, item.subject, item.targetScore, item.deadline, item.strategy, item.status, now, now);
      }
      for (const item of newObservations) this.db.prepare("INSERT INTO growth_observations VALUES(?,?,?,?,?)")
        .run(item.id, studentId, item.observedOn, item.content, now);

      this.db.prepare("INSERT INTO growth_requests VALUES(?,?,?,?,?)").run(requestId, studentId, payloadHash, "{}", now);
      if (changed) {
        const snapshot = this.load(studentId);
        this.db.prepare("INSERT INTO growth_history VALUES(?,?,?,?,?)")
          .run(studentId, nextRevision, requestId, now, sortedJson(this.toSnapshot(snapshot)));
      }
      const current = this.load(studentId);
      const resultJson = sortedJson(current);
      this.db.prepare("UPDATE growth_requests SET result_json=? WHERE request_id=?").run(resultJson, requestId);
      committing = true; this.db.exec("COMMIT"); return current;
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); }
      catch { this.writesBlocked = true; committing = true; }
      if (committing) throw new GrowthProfileFault("unknown", "保存结果待确认。请使用同一请求编号重试或重开核对历史。");
      throw error;
    }
  }

  private goals(studentId: string): GrowthGoal[] {
    return this.db.prepare(`SELECT id,subject,target_score AS targetScore,deadline,strategy,status,
      created_at AS createdAt,updated_at AS updatedAt FROM growth_goals WHERE student_id=? ORDER BY deadline,id`)
      .all(studentId) as unknown as GrowthGoal[];
  }
  private observations(studentId: string): GrowthObservation[] {
    return this.db.prepare(`SELECT id,observed_on AS observedOn,content,created_at AS createdAt
      FROM growth_observations WHERE student_id=? ORDER BY observed_on DESC,created_at DESC,id DESC`)
      .all(studentId) as unknown as GrowthObservation[];
  }
  private historyRows(studentId: string): GrowthHistory[] {
    return this.db.prepare(`SELECT revision,request_id AS requestId,changed_at AS changedAt,snapshot_json AS snapshotJson
      FROM growth_history WHERE student_id=? ORDER BY revision DESC`).all(studentId).map(row => ({
      revision: row.revision as number, requestId: row.requestId as string, changedAt: row.changedAt as number,
      snapshot: JSON.parse(row.snapshotJson as string) as GrowthSnapshot,
    }));
  }
  private toSnapshot(view: GrowthProfileView): GrowthSnapshot {
    if (view.updatedAt === null) throw new Error("Cannot snapshot an uncreated growth profile");
    const { revision, updatedAt, learningCharacteristics, communicationPreferences, currentSituation,
      strengths, weakAreas, goals, observations } = view;
    return { revision, updatedAt, learningCharacteristics, communicationPreferences, currentSituation,
      strengths, weakAreas, goals, observations };
  }
  close(): void { this.db.close(); if (this.writesBlocked) throw new GrowthProfileFault("unknown", "成长档案数据库状态待确认。"); }
}
