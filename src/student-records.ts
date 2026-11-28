import type { DatabaseSync } from "node:sqlite";
import { shanghaiMinute } from "./schedule-calendar";
import { WorkspaceFault } from "./workspace-fault";

export interface RecordField {
  key: string;
  label: string;
  type?: "date" | "number" | "integer" | "textarea";
  options?: readonly string[];
  optional?: boolean;
  limit?: number;
}
interface RecordDefinition {
  table: string;
  version: number;
  label: string;
  item: string;
  fields: readonly RecordField[];
  validate?: (fields: Record<string, string>) => void;
}

export const scoreRankFields: readonly RecordField[] = [
  { key: "classRank", label: "班级排名", type: "integer", optional: true, limit: 16 },
  { key: "classSize", label: "班级参考人数", type: "integer", optional: true, limit: 16 },
  { key: "gradeRank", label: "年级排名", type: "integer", optional: true, limit: 16 },
  { key: "gradeSize", label: "年级参考人数", type: "integer", optional: true, limit: 16 },
];

export const studentRecordDefinitions = {
  enrollment: {
    table: "student_enrollments", version: 4, label: "报名与到期", item: "报名",
    fields: [
      { key: "course", label: "课程名称", limit: 100 },
      { key: "registeredOn", label: "报名日期", type: "date" },
      { key: "startsOn", label: "有效期开始", type: "date" },
      { key: "endsOn", label: "有效期截至（含）", type: "date" },
      { key: "status", label: "报名状态", options: ["有效", "已取消"] },
      { key: "notes", label: "备注", type: "textarea", optional: true },
    ],
    validate(fields) {
      if (fields.startsOn > fields.endsOn) invalid("有效期结束日期不能早于开始日期。");
    },
  },
  score: {
    table: "student_scores", version: 5, label: "成绩趋势", item: "成绩",
    fields: [
      { key: "assessment", label: "考试或测验名称", limit: 100 },
      { key: "subject", label: "学科", limit: 30 },
      { key: "takenOn", label: "考试日期", type: "date" },
      { key: "category", label: "考试类别", options: ["日常测验", "阶段考试", "期中考试", "期末考试", "其他"] },
      { key: "score", label: "得分", type: "number" },
      { key: "maximum", label: "满分", type: "number" },
      { key: "notes", label: "备注", type: "textarea", optional: true },
    ],
    validate(fields) {
      if (Number(fields.maximum) <= 0 || Number(fields.score) > Number(fields.maximum)) {
        invalid("满分必须大于零，得分不能高于满分。");
      }
    },
  },
  improvement: {
    table: "student_improvement_plans", version: 6, label: "提分方案", item: "方案",
    fields: [
      { key: "title", label: "方案名称", limit: 100 },
      { key: "subject", label: "学科", limit: 30 },
      { key: "startsOn", label: "开始日期", type: "date" },
      { key: "targetOn", label: "目标日期", type: "date" },
      { key: "baseline", label: "当前基线与依据", type: "textarea" },
      { key: "target", label: "目标及衡量方式", type: "textarea" },
      { key: "practice", label: "训练与复盘安排", type: "textarea" },
      { key: "status", label: "方案状态", options: ["计划中", "执行中", "已完成", "已停止"] },
    ],
    validate(fields) {
      if (fields.startsOn > fields.targetOn) invalid("目标日期不能早于方案开始日期。");
    },
  },
  training: {
    table: "student_training_results", version: 6, label: "训练效果", item: "训练结果",
    fields: [
      { key: "activity", label: "训练名称", limit: 100 },
      { key: "planId", label: "方案编号", limit: 36 },
      { key: "planRevision", label: "当时的方案版本", limit: 16 },
      { key: "trainedOn", label: "训练日期", type: "date" },
      { key: "sequence", label: "阶段", options: ["基线", "过程", "复测"] },
      { key: "score", label: "训练得分（可选）", type: "number", optional: true },
      { key: "maximum", label: "训练满分（可选）", type: "number", optional: true },
      { key: "result", label: "效果和观察依据", type: "textarea" },
      { key: "nextStep", label: "下一步", type: "textarea", optional: true },
    ],
    validate(fields) {
      uuid(fields.planId);
      if (!/^[1-9][0-9]*$/.test(fields.planRevision) || !Number.isSafeInteger(Number(fields.planRevision))) invalid("方案版本无效。");
      if (Boolean(fields.score) !== Boolean(fields.maximum) ||
          (fields.maximum && (Number(fields.maximum) <= 0 || Number(fields.score) > Number(fields.maximum)))) {
        invalid("可同时留空训练得分与满分。填写时满分须大于零，且得分不能高于满分。");
      }
    },
  },
} satisfies Record<string, RecordDefinition>;

export type StudentRecordKind = keyof typeof studentRecordDefinitions;

const rankedScoreVersion = 7;

export function studentRecordFields(kind: StudentRecordKind, version: number): readonly RecordField[] {
  const fields = studentRecordDefinitions[kind].fields;
  return kind === "score" && version >= rankedScoreVersion ? [...fields, ...scoreRankFields] : fields;
}
export interface StudentRecord {
  id: string;
  studentId: string;
  requestId: string;
  revision: number;
  fields: Record<string, string>;
  savedAt: number;
}
export type StudentRecordInput = Omit<StudentRecord, "revision" | "savedAt"> & {
  kind: StudentRecordKind;
  expectedRevision: number;
};
export interface StudentRecordView { studentId: string; records: StudentRecord[] }

export function enrollmentStatus(fields: Record<string, string>, today: string): string {
  if (fields.status === "已取消") return "已取消";
  if (today < fields.startsOn) return "尚未生效";
  if (today > fields.endsOn) return "已到期";
  const days = (Date.parse(fields.endsOn) - Date.parse(today)) / 86_400_000;
  return days <= 14 ? days === 0 ? "今日到期" : `还有 ${days} 天到期` : "有效期内";
}

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }
function conflict(message: string): never { throw new WorkspaceFault("conflict", message); }

function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid("记录、请求或学生编号无效。");
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("学生记录格式无效。");
  return value as Record<string, unknown>;
}
function fieldsFor(definition: RecordDefinition, raw: unknown, ranked = false): Record<string, string> {
  const input = object(raw);
  const fields: Record<string, string> = {};
  const definitions = ranked ? [...definition.fields, ...scoreRankFields] : definition.fields;
  if (Object.keys(input).some(key => !definitions.some(field => field.key === key))) invalid("学生记录包含未知字段。");
  for (const field of definitions) {
    const present = Object.hasOwn(input, field.key);
    if (!present && field.type === "integer") continue;
    const value = input[field.key];
    if (typeof value !== "string" || value.length > (field.limit ?? 1000) || value.includes("\0") ||
        (!field.optional && !value.trim())) invalid("请检查" + field.label + "。");
    if (value && field.type === "number" && !/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/.test(value)) {
      invalid(field.label + "须为 0 至 99999.99 的数字，最多两位小数。");
    }
    if (field.type === "integer") {
      if (!value.trim()) continue;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(field.label + "须为正整数。");
    }
    if (value && field.type === "date" && shanghaiMinute(value, "00:00") === null) invalid(field.label + "无效。");
    if (field.options && !field.options.includes(value)) invalid(field.label + "无效。");
    fields[field.key] = value.trim();
  }
  definition.validate?.(fields);
  if (ranked) {
    for (const [rank, size, label] of [["classRank", "classSize", "班级"], ["gradeRank", "gradeSize", "年级"]]) {
      if (fields[rank] && fields[size] && Number(fields[rank]) > Number(fields[size])) invalid(label + "排名不能超过参考人数。");
    }
  }
  return fields;
}

function payloadFor(definition: RecordDefinition, fields: Record<string, string>): string {
  return JSON.stringify(definition === studentRecordDefinitions.score && scoreRankFields.some(field => Object.hasOwn(fields, field.key))
    ? { version: 2, fields } : fields);
}
function definitionFor(kind: unknown, version: number): RecordDefinition {
  if (typeof kind !== "string" || !Object.hasOwn(studentRecordDefinitions, kind)) invalid("学生记录类型无效。");
  const definition = studentRecordDefinitions[kind as StudentRecordKind];
  if (definition.version > version) throw new WorkspaceFault("recovery", "当前档案版本尚未启用该功能。");
  return definition;
}

function definitionsAt(version: number): RecordDefinition[] {
  return Object.values(studentRecordDefinitions).filter(definition => definition.version <= version);
}

export function studentRecordSchema(version: number) {
  return definitionsAt(version).map(({ table }) => [table, "table", `CREATE TABLE ${table} (
    request_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES students(id),
    revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL, saved_at INTEGER NOT NULL,
    UNIQUE(entity_id, revision)
  ) STRICT`] as const);
}

const columns = "request_id AS requestId, entity_id AS id, student_id AS studentId, revision, payload, saved_at AS savedAt";
function record(row: Record<string, unknown>, definition: RecordDefinition, version: number): StudentRecord {
  const { id, requestId, studentId, revision, savedAt, payload } = row;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0 || typeof payload !== "string") {
    invalid("已有学生记录的版本、时间或内容无法验证。");
  }
  const decoded = object(JSON.parse(payload));
  const ranked = definition === studentRecordDefinitions.score && version >= rankedScoreVersion && decoded.version === 2;
  const fields = fieldsFor(definition, ranked ? decoded.fields : decoded, ranked);
  if (payloadFor(definition, fields) !== payload) invalid("已有学生记录内容不符合格式。");
  return { id: uuid(id), requestId: uuid(requestId), studentId: uuid(studentId), revision, fields, savedAt };
}

function requireStudent(db: DatabaseSync, studentId: string) {
  if (!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId)) invalid("找不到关联的学生。");
}

export function readStudentRecords(db: DatabaseSync, version: number, kind: unknown, rawStudentId: unknown): StudentRecordView {
  const definition = definitionFor(kind, version);
  const studentId = uuid(rawStudentId);
  requireStudent(db, studentId);
  const records = db.prepare(`SELECT ${columns} FROM ${definition.table} saved
    WHERE student_id=? AND NOT EXISTS (SELECT 1 FROM ${definition.table} later
      WHERE later.entity_id=saved.entity_id AND later.revision>saved.revision)
    ORDER BY saved_at DESC, entity_id`).all(studentId).map(row => record(row, definition, version));
  return { studentId, records };
}

function resolveTrainingPlan(db: DatabaseSync, studentId: string, fields: Record<string, string>): StudentRecord {
  const definition = studentRecordDefinitions.improvement;
  const row = db.prepare(`SELECT ${columns} FROM ${definition.table} WHERE entity_id=? AND revision=?`)
    .get(fields.planId, Number(fields.planRevision));
  if (!row || row.studentId !== studentId) invalid("训练结果须关联该学生的已保存方案版本。");
  const plan=record(row,definition,6);
  if (fields.trainedOn < plan.fields.startsOn) invalid("训练日期不能早于所选方案版本的开始日期。");
  return plan;
}

export type DetectionResultRef={kind:"score"|"training";id:string;revision:number};
export type DetectionSource=DetectionResultRef&{subject:string;date:string;title:string;
 plan?:{id:string;revision:number;title:string}};
export function resolveDetectionSource(db:DatabaseSync,studentId:string,ref:DetectionResultRef):DetectionSource|undefined{
  const version=Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const definition=definitionFor(ref.kind,version);
  const row=db.prepare(`SELECT ${columns} FROM ${definition.table} WHERE entity_id=? AND revision=? AND student_id=?`)
    .get(ref.id,ref.revision,studentId);
  if(!row)return;
  const result=record(row,definition,version);
  if(ref.kind==="score")return {...ref,subject:result.fields.subject,date:result.fields.takenOn,title:result.fields.assessment};
  const plan=resolveTrainingPlan(db,studentId,result.fields);
  return {...ref,subject:plan.fields.subject,date:result.fields.trainedOn,title:result.fields.activity,
   plan:{id:plan.id,revision:plan.revision,title:plan.fields.title}};
}

export function studentRecordInput(version: number, raw: unknown): StudentRecordInput {
  const input = object(raw), definition = definitionFor(input.kind, version);
  const id = uuid(input.id), studentId = uuid(input.studentId), requestId = uuid(input.requestId);
  const expected = input.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) {
    invalid("保存版本无效。");
  }
  return { kind: input.kind as StudentRecordKind, id, studentId, requestId, expectedRevision: expected,
    fields: fieldsFor(definition, input.fields, input.kind === "score" && version >= rankedScoreVersion) };
}
function recordReceipt(db: DatabaseSync, input: StudentRecordInput, definition: RecordDefinition, version: number): StudentRecord | undefined {
  const existing = db.prepare(`SELECT ${columns} FROM ${definition.table} WHERE request_id=?`).get(input.requestId);
  if (!existing) return;
  if (existing.id !== input.id || existing.studentId !== input.studentId ||
      existing.revision !== input.expectedRevision + 1 || existing.payload !== payloadFor(definition, input.fields)) {
    conflict("此请求编号已用于其他记录。");
  }
  return record(existing, definition, version);
}
export function studentRecordCommitted(db: DatabaseSync, version: number, raw: unknown): boolean {
  const input = studentRecordInput(version, raw);
  return Boolean(recordReceipt(db, input, definitionFor(input.kind, version), version));
}
export function saveStudentRecord(db: DatabaseSync, version: number, raw: unknown): StudentRecord {
  const input = studentRecordInput(version, raw);
  const definition = definitionFor(input.kind, version);
  const { id, studentId, requestId, expectedRevision: expected, fields } = input;
  const payload = payloadFor(definition, fields);
  requireStudent(db, studentId);
  const existing = recordReceipt(db, input, definition, version);
  if (existing) return existing;
  for (const other of definitionsAt(version)) {
    if (other !== definition && db.prepare(`SELECT 1 FROM ${other.table} WHERE request_id=?`).get(requestId)) {
      conflict("此请求编号已用于其他学生记录。");
    }
  }
  const previous = db.prepare(`SELECT student_id, revision, payload FROM ${definition.table}
    WHERE entity_id=? ORDER BY revision DESC LIMIT 1`).get(id);
  if (previous && previous.student_id !== studentId) invalid("记录与当前学生不一致。");
  if ((previous?.revision ?? 0) !== expected) conflict("记录已更新。请重新核对当前版本。");
  if (definition === studentRecordDefinitions.training) {
    if (previous) {
      const original = fieldsFor(definition, JSON.parse(String(previous.payload)));
      if (original.planId !== fields.planId || original.planRevision !== fields.planRevision) invalid("已保存的训练结果不能改绑方案。");
    }
    resolveTrainingPlan(db, studentId, fields);
  }
  const revision = expected + 1, savedAt = Date.now();
  db.prepare(`INSERT INTO ${definition.table} VALUES (?,?,?,?,?,?)`).run(requestId, id, studentId, revision, payload, savedAt);
  return { id, studentId, requestId, revision, fields, savedAt };
}

export function verifyStudentRecords(db: DatabaseSync, version: number): void {
  const requests = new Set<string>();
  for (const definition of definitionsAt(version)) {
    let last: StudentRecord | undefined;
    for (const row of db.prepare(`SELECT ${columns} FROM ${definition.table} ORDER BY entity_id, revision`).iterate()) {
      const next = record(row, definition, version);
      if (requests.has(next.requestId) ||
          (last?.id === next.id ? next.studentId !== last.studentId || next.revision !== last.revision + 1 : next.revision !== 1)) {
        invalid("学生记录的归属、版本或请求编号不一致。");
      }
      if (definition === studentRecordDefinitions.training) {
        if (last?.id === next.id && (last.fields.planId !== next.fields.planId || last.fields.planRevision !== next.fields.planRevision)) {
          invalid("训练结果的方案来源不一致。");
        }
        resolveTrainingPlan(db, next.studentId, next.fields);
      }
      requests.add(next.requestId);
      last = next;
    }
  }
}
