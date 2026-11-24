import type { StudentInput } from "./contracts";
import { WorkspaceFault } from "./database";
import type { GrowthFields } from "./growth-profile";

export type IntakeJson = string | number | boolean | null | IntakeJson[] | IntakeJsonObject;
export interface IntakeJsonObject { [key: string]: IntakeJson }
export type IntakeCategory = "fact" | "self-report" | "teacher-assessment" | "goal" | "plan" | "warning" | "unknown";
export interface IntakeReviewItem {
  path: string;
  category: IntakeCategory;
  message: string;
  value: IntakeJson;
}
export interface IntakePreview {
  code: string;
  student: Omit<StudentInput, "id">;
  growth: GrowthFields;
  review: IntakeReviewItem[];
  source: IntakeJsonObject;
}

export const maxIntakeBytes = 256 * 1024;
export const intakeCodePattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const fieldLimits = {
  learningCharacteristics: 2000,
  communicationPreferences: 1000,
  currentSituation: 2000,
  strengths: 1500,
  weakAreas: 1500,
} satisfies Record<keyof GrowthFields, number>;

function invalid(path: string, message: string): never {
  throw new WorkspaceFault("invalid", path + " " + message);
}

function isObject(value: IntakeJson): value is IntakeJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? path + "." + key : path + "[" + JSON.stringify(key) + "]";
}

function checkStructure(raw: string): void {
  // JSON.parse accepts repeated object keys and keeps only the last value.
  const scopes: Array<Set<string> | null> = [];
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?|[[\]{}]/g)) {
    const symbol = match[0][0];
    if (symbol === "{") scopes.push(new Set());
    else if (symbol === "[") scopes.push(null);
    else if (symbol === "]" || symbol === "}") scopes.pop();
    else if (match[1] !== undefined) {
      const key = JSON.parse(match[0].slice(0, -match[1].length)) as string;
      const keys = scopes[scopes.length - 1];
      if (keys?.has(key)) invalid("$", "JSON 对象包含重复字段。");
      keys?.add(key);
    }
    if (scopes.length > 20) invalid("$", "JSON 嵌套超过 20 层。");
  }
}

function checkBounds(value: IntakeJson, path: string): void {
  if (typeof value === "string" && (value.length > 4000 || value.includes("\0"))) {
    invalid(path, "文本超出 4000 字或含无效字符。");
  }
  if (typeof value === "number" && !Number.isFinite(value)) invalid(path, "数值超出允许范围。");
  if (Array.isArray(value)) {
    if (value.length > 100) invalid(path, "数组超过 100 项。");
    value.forEach((item, i) => checkBounds(item, path + "[" + i + "]"));
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 80) invalid(path, "对象字段超过 80 项。");
    for (const [key, field] of entries) {
      if (!key || key.length > 80 || /[\u0000-\u001f\u007f]/.test(key)) invalid(path, "存在无效对象字段名。");
      checkBounds(field, childPath(path, key));
    }
  }
}

type Rule = (value: IntakeJson, path: string, review: IntakeReviewItem[]) => void;

function object(fields: Record<string, Rule>, required: string[] = []): Rule {
  return (value, path, review) => {
    if (!isObject(value)) invalid(path, "必须为对象。");
    for (const key of required) {
      if (!Object.hasOwn(value, key)) invalid(childPath(path, key), "是必填字段。");
    }
    for (const [key, field] of Object.entries(value)) {
      const fieldPath = childPath(path, key);
      if (Object.hasOwn(fields, key)) fields[key](field, fieldPath, review);
      else review.push({ path: fieldPath, category: "unknown", message: "未识别字段，保留原值供人工核对。", value: field });
    }
  };
}

function list(rule: Rule, max: number): Rule {
  return (value, path, review) => {
    if (!Array.isArray(value) || value.length > max) invalid(path, "必须为最多 " + max + " 项的数组。");
    value.forEach((item, i) => rule(item, path + "[" + i + "]", review));
  };
}

function nullable(rule: Rule): Rule {
  return (value, path, review) => {
    if (value !== null) rule(value, path, review);
  };
}

function string(max: number, required = false): Rule {
  return (value, path) => {
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
      invalid(path, (required ? "须为非空文本，" : "须为文本，") + "最长 " + max + " 字。");
    }
  };
}

function enumValue(...allowed: string[]): Rule {
  return (value, path) => {
    if (typeof value !== "string" || !allowed.includes(value)) invalid(path, "取值无效。");
  };
}

function number(min: number, max: number, integer = false): Rule {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max ||
        (integer && !Number.isSafeInteger(value))) invalid(path, "数值或取值范围无效。");
  };
}

const date: Rule = (value, path) => {
  if (typeof value === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value + "T00:00:00Z");
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return;
  }
  invalid(path, "须为有效的 YYYY-MM-DD 日期，未知可使用 null。");
};

const booleanValue: Rule = (value, path) => {
  if (typeof value !== "boolean") invalid(path, "必须为布尔值。");
};

const codeRule: Rule = (value, path) => {
  if (typeof value !== "string" || value.length > 40 || !intakeCodePattern.test(value)) {
    invalid(path, "学生代号须为 1–40 位大写字母或数字，可用单个连字符分组。");
  }
};

const rowId: Rule = (value, path) => {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(value)) {
    invalid(path, "来源条目编号无效。");
  }
};

const page = number(1, 10000, true);
const pages = list(page, 50);
const subjects = list(string(40, true), 20);
const shortText = nullable(string(150));
const longText = nullable(string(2000));
const score = nullable(number(0, 100000));
const hours = nullable(number(0, 10000));
const freeScore: Rule = (value, path, review) => {
  if (typeof value === "string") string(150, true)(value, path, review);
  else score(value, path, review);
};
const confidence = enumValue("high", "medium", "low", "unknown");
const textList = list(string(500, true), 50);
const evidenceFields = {
  source_page: page,
  source_type: string(60, true),
  original_text: string(4000),
  confidence,
  review_required: booleanValue,
};
const evidence = object(evidenceFields, ["source_page", "source_type", "original_text", "confidence"]);
const sourced = {
  id: rowId,
  source_pages: pages,
  evidence: list(evidence, 30),
  review_required: booleanValue,
  note: longText,
};

const narrative = list(object({ ...sourced, statement: string(1000, true) }, ["id", "statement"]), 60);
const sourceDocuments = list(object({
  doc_id: rowId,
  title: string(200, true),
  doc_type: string(80, true),
  pages,
  date_on_document: nullable(date),
  legibility: confidence,
  identity_fields_present: booleanValue,
  identity_fields_extracted: booleanValue,
  notes: longText,
  page_labels: (value, path, review) => {
    if (!isObject(value)) invalid(path, "必须为对象。");
    for (const [key, label] of Object.entries(value)) {
      if (!/^[1-9]\d{0,4}$/.test(key)) invalid(path, "页码标签的字段名须为页码。");
      page(Number(key), childPath(path, key), review);
      string(100, true)(label, childPath(path, key), review);
    }
  },
  missing_pages: pages,
}, ["doc_id"]), 30);

const validateSource = object({
  schema_version: enumValue("sw-student-intake-v1"),
  student_code: codeRule,
  source_documents: sourceDocuments,
  student: object({
    grade: nullable(string(30)),
    subjects: nullable(subjects),
    school: shortText,
    class_name: shortText,
    registration_date: nullable(date),
    learning_background: narrative,
  }),
  profile: object({
    interests: list(object({ ...sourced, item: string(500, true) }, ["id", "item"]), 60),
    aspirations: narrative,
    learning_habits: narrative,
    self_reported_difficulties: narrative,
    teacher_observations: narrative,
    strengths: narrative,
    weaknesses: narrative,
  }),
  academic_status: list(object({
    ...sourced,
    subject: string(40, true),
    current_stage: longText,
    mastered: (value, path, review) => Array.isArray(value) ? textList(value, path, review) : longText(value, path, review),
    main_gaps: textList,
    skill_issues: textList,
    method_difficulties: textList,
    interventions_taken: textList,
    planned_modules_next: textList,
  }, ["id", "subject"]), 40),
  score_records: list(object({
    ...evidenceFields,
    id: rowId,
    exam_date: nullable(date),
    subject: nullable(string(40, true)),
    exam_name: shortText,
    score: freeScore,
    full_score: nullable(number(1, 100000)),
    class_rank: nullable(number(1, 100000, true)),
    grade_rank: nullable(number(1, 100000, true)),
    note: longText,
  }, ["id"]), 80),
  score_summaries: list(object({
    ...sourced,
    subject: nullable(string(40, true)),
    summary: string(1000, true),
    highest: freeScore,
    lowest: freeScore,
  }, ["id", "summary"]), 40),
  improvement_goals: list(object({
    ...sourced,
    subject: nullable(string(40, true)),
    baseline: freeScore,
    target_score: freeScore,
    target_display: shortText,
    target_capability: longText,
    deadline: nullable(date),
    full_score: nullable(number(1, 100000)),
    focus_modules: textList,
    interventions: textList,
  }, ["id"]), 40),
  study_plans: list(object({
    ...sourced,
    plan_name: string(200, true),
    subjects,
    period: object({ start: nullable(date), end: nullable(date), period_note: longText }),
    weekly_schedule: list(object({ day: string(24, true), slot: string(120, true), hours }), 30),
    weekly_hours_total: hours,
    modules: list(object({
      month: string(30, true),
      weeks: list(object({ week: string(40, true), items: textList, planned_hours: hours }), 12),
      note: longText,
      planned_hours_per_week_confirmed: hours,
    }), 24),
    planned_hours: object({ per_week: hours, per_month_note: longText, raw: shortText, per_month_min: hours, per_month_max: hours }),
    tuition: object({ amount: nullable(number(0, 10000000)), currency: shortText, cycle: shortText, discount: freeScore }),
    class_time_arrangement: longText,
    review_and_assessment: textList,
    implementation_status: shortText,
    status_note: longText,
  }, ["id", "plan_name"]), 12),
  follow_up_suggestions: list(object({
    id: rowId, suggestion: string(1000, true), related_pages: pages,
  }, ["id", "suggestion"]), 60),
  review_warnings: list(object({
    id: rowId, type: string(80, true), issue: string(1000, true), source_pages: pages, handling: longText,
  }, ["id", "type", "issue"]), 80),
}, ["schema_version", "student_code", "student"]);

function sourceType(value: IntakeJson): IntakeCategory | undefined {
  if (value === "学生自述") return "self-report";
  if (value === "教师观察" || value === "教师评价") return "teacher-assessment";
  if (value === "教学计划") return "plan";
  if (value === "考试记录" || value === "登记表" || value === "事实记录") return "fact";
}

const attribution = {
  fact: "资料记录",
  "self-report": "学生自述",
  "teacher-assessment": "教师评价",
  goal: "学习目标",
  plan: "学习计划",
  warning: "待核对",
  unknown: "未识别",
} satisfies Record<IntakeCategory, string>;

function rows(value: IntakeJson | undefined): IntakeJsonObject[] {
  return Array.isArray(value) ? value as IntakeJsonObject[] : [];
}

function buildPreview(source: IntakeJsonObject, review: IntakeReviewItem[]): IntakePreview {
  const code = source.student_code as string;
  const basic = source.student as IntakeJsonObject;
  const profile = (source.profile ?? {}) as IntakeJsonObject;
  const student: IntakePreview["student"] = {
    alias: code,
    grade: typeof basic.grade === "string" ? basic.grade.trim() : "",
    subjects: Array.isArray(basic.subjects) ? basic.subjects.map(subject => (subject as string).trim()).join("、") : "",
    goal: "",
    notes: "",
  };
  const growth: GrowthFields = {
    learningCharacteristics: "", communicationPreferences: "", currentSituation: "", strengths: "", weakAreas: "",
  };

  const add = (path: string, category: IntakeCategory, message: string, value: IntakeJson) =>
    review.push({ path, category, message, value });
  if (!student.grade) add("$.student.grade", "warning", "缺少年级。若要新建学生，请在预览中补充。", basic.grade ?? null);
  if (student.subjects.length > 100) {
    add("$.student.subjects", "warning", "合并学科超出 M1 的 100 字限制，请在预览中修正。", basic.subjects);
    student.subjects = "";
  } else if (!student.subjects) {
    add("$.student.subjects", "warning", "缺少学科。若要新建学生，请在预览中补充。", basic.subjects ?? null);
  }
  for (const key of ["school", "class_name", "registration_date"]) {
    if (Object.hasOwn(basic, key)) add("$.student." + key, "fact", "基础资料保留供核对，M1 无对应字段。", basic[key]);
  }

  function project(items: IntakeJsonObject[], path: string, field: keyof GrowthFields | undefined, contentKey: string,
                   preferred?: IntakeCategory, only?: IntakeCategory) {
    items.forEach((item, i) => {
      const at = path + "[" + i + "]";
      const evidence = rows(item.evidence);
      const types = new Set(evidence.map(row => sourceType(row.source_type)));
      const category = types.size === 1 ? types.values().next().value : undefined;
      const rowCategory = preferred ?? category ?? "warning";
      const reviewMessage = "仅保留来源供核对。";
      const clean = item.review_required !== true && evidence.length > 0 &&
        evidence.every(row => row.review_required !== true && row.confidence === "high" &&
          typeof row.original_text === "string" && Boolean(row.original_text.trim()));
      if (!field || !clean || !category || (only && category !== only) ||
          category === "plan" || typeof item[contentKey] !== "string" || !item[contentKey].trim()) {
        add(at, rowCategory, reviewMessage, item);
        return;
      }
      const subject = typeof item.subject === "string" ? item.subject.trim() + " · " : "";
      const line = attribution[category] + "：" + subject + item[contentKey].trim();
      const next = growth[field] ? growth[field] + "\n" + line : line;
      if (next.length > fieldLimits[field]) {
        add(at, rowCategory, "超出成长档案字段长度，整条保留供人工核对。", item);
        return;
      }
      growth[field] = next;
      add(at, rowCategory, "已生成档案建议，保留原始依据。", item);
    });
  }

  rows(source.source_documents).forEach((doc, i) => {
    const path = "$.source_documents[" + i + "]";
    add(path, "fact", "来源文档与页码。", doc);
    if (doc.identity_fields_extracted === true) {
      add(path + ".identity_fields_extracted", "warning", "来源标记了已提取身份字段，请核对档案代号和资料范围。", true);
    }
  });
  project(rows(basic.learning_background), "$.student.learning_background", "currentSituation", "statement");
  project(rows(profile.interests), "$.profile.interests", "learningCharacteristics", "item", "self-report", "self-report");
  project(rows(profile.aspirations), "$.profile.aspirations", undefined, "statement", "goal");
  project(rows(profile.learning_habits), "$.profile.learning_habits", "learningCharacteristics", "statement");
  project(rows(profile.self_reported_difficulties), "$.profile.self_reported_difficulties", "weakAreas", "statement", "self-report", "self-report");
  project(rows(profile.teacher_observations), "$.profile.teacher_observations", "currentSituation", "statement", "teacher-assessment", "teacher-assessment");
  project(rows(profile.strengths), "$.profile.strengths", "strengths", "statement");
  project(rows(profile.weaknesses), "$.profile.weaknesses", "weakAreas", "statement");
  const academia = rows(source.academic_status);
  project(academia, "$.academic_status", "currentSituation", "current_stage");
  academia.forEach((item, i) => {
    if (Array.isArray(item.planned_modules_next) && item.planned_modules_next.length) {
      add("$.academic_status[" + i + "].planned_modules_next", "plan", "计划中的学科模块，保留供核对。", item.planned_modules_next);
    }
  });

  function keep(key: string, category: IntakeCategory, message: string) {
    rows(source[key]).forEach((item, i) => add("$." + key + "[" + i + "]", category, message, item));
  }
  keep("score_records", "fact", "分数仅保留原始口径；不推算满分、百分制分数或排名。");
  keep("score_summaries", "fact", "分数摘要保留供人工核对。");
  keep("improvement_goals", "goal", "目标供人工核对；保留原始分数范围、期限和策略。");
  keep("study_plans", "plan", "学习安排保留供核对，执行情况以实际记录为准。");
  keep("follow_up_suggestions", "plan", "跟进建议保留供核对。");
  keep("review_warnings", "warning", "来源提取时标记的待核对事项。");
  return { code, student, growth, review, source };
}

export function parseIntake(raw: string): IntakePreview {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxIntakeBytes) {
    invalid("$", "请选择不超过 256 KiB 的 UTF-8 JSON 文件。");
  }
  const content = raw.replace(/^\uFEFF/, "");
  let source: IntakeJson;
  try { source = JSON.parse(content) as IntakeJson; }
  catch { invalid("$", "无法解析 JSON，请检查文件格式和 UTF-8 编码。"); }
  checkStructure(content);
  checkBounds(source, "$");
  const review: IntakeReviewItem[] = [];
  validateSource(source, "$", review);
  return buildPreview(source as IntakeJsonObject, review);
}
