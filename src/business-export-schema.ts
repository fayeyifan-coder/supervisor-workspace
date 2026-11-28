export type ExportRole = "business" | "history" | "internal";
const table = (store: string, name: string, sheet: string, columns: string, role: ExportRole = "business") =>
  ({ store, name, sheet, columns: columns.split(","), role });

// Whitelists for the supported five-store layouts. Unknown tables or fields fail export.
export const exportTables = [
  table("mvp", "students", "学生档案", "id,alias,grade,subjects,goal,notes,created_at"),
  table("mvp", "learning_records", "学习历史", "id,student_id,study_date,subject,task,completion,assessment,next_step,created_at"),
  table("mvp", "student_edits", "档案修订", "request_id,student_id,revision,changed_at,before_json,after_json", "history"),
  table("mvp", "student_edit_pending", "待确认编辑", "student_id,request_id,payload", "internal"),
  table("mvp", "parent_concerns", "家长诉求", "request_id,student_id,reported_on,role,category,concern,next_on,recorded_at"),
  table("mvp", "parent_followups", "家长跟进", "request_id,concern_id,revision,followed_on,status,note,next_on,recorded_at", "history"),
  ...["enrollments", "scores", "improvement_plans", "training_results"].map((name, index) =>
    table("mvp", "student_" + name, ["报名与到期", "考试成绩", "提分方案", "训练结果"][index], "request_id,entity_id,student_id,revision,payload,saved_at")),
  table("worklog", "work_items", "工作事项", "id,title,work_date,student_id,started_at,notes,next_step,status,created_at,updated_at,completed_at"),
  table("worklog", "work_changes", "工作事项历史", "id,item_id,changed_at,snapshot", "history"),
  table("growth", "growth_profiles", "成长档案", "student_id,learning_characteristics,communication_preferences,current_situation,strengths,weak_areas,revision,updated_at"),
  table("growth", "growth_goals", "成长目标", "id,student_id,subject,target_score,deadline,strategy,status,created_at,updated_at"),
  table("growth", "growth_observations", "成长观察", "id,student_id,observed_on,content,created_at"),
  table("growth", "growth_requests", "成长幂等回执", "request_id,student_id,payload_hash,result_json,saved_at", "internal"),
  table("growth", "growth_history", "成长修订", "student_id,revision,request_id,changed_at,snapshot_json", "history"),
  table("student-intake", "intake_bindings", "导入身份绑定", "code,student_id"),
  table("student-intake", "intake_jobs", "导入来源与状态", "digest,code,source_json,plan_json,state,student_confirmed,updated_at"),
  table("operations", "attendance_plans", "预计到校与考勤", "id,student_id,start_at,end_at,kind,status,check_in_at,check_out_at,outside_window,exception_reason,revision,created_at,updated_at"),
  table("operations", "learning_blocks", "学习块", "id,student_id,attendance_plan_id,planned_start,planned_end,actual_start,actual_end,status,outside_attendance_reason,notes,revision,created_at,updated_at"),
  table("operations", "learning_tasks", "学习任务", "id,block_id,position,category,subject,content,knowledge_points,planned_target,status,result_notes,completed_at"),
  table("operations", "operation_requests", "教务幂等回执", "request_id,command,payload_sha256,result_json,created_at", "internal"),
  table("operations", "operation_changes", "教务修订", "entity_kind,entity_id,student_id,revision,request_id,snapshot_json,changed_at", "history"),
] as const;

const lifecycleTable = table("mvp", "student_lifecycle", "学生跟进状态历史", "request_id,student_id,revision,previous_status,status,reason,changed_at", "history");
const recurringTables = [
  table("operations", "schedule_rule_revisions", "周期排课修订", "id,revision,student_id,request_id,definition_json,changed_at", "history"),
  table("operations", "schedule_hours_revisions", "营业时段修订", "revision,request_id,definition_json,changed_at", "history"),
  table("operations", "schedule_origins", "单次安排来源", "plan_id,rule_id,rule_revision,slot_id,occurrence_date"),
];
const attendanceExceptionTable = table("operations", "attendance_exceptions", "单日调整历史", "plan_id,revision,request_id,action,reason,changed_at", "history");
const studyPlanTables = [
  table("mvp", "study_plan_sources", "半年规划原件目录", "sha256,filename,byte_length,imported_at,cells_json,document_bytes"),
  table("mvp", "study_plans", "半年初始规划", "id,student_id,source_sha256,initial_json,created_at", "history"),
];
export const exportTablesFor = (version: number) =>
  [...exportTables, ...(version >= 8 ? [lifecycleTable] : []), ...(version >= 9 ? recurringTables : []), ...(version >= 10 ? [attendanceExceptionTable] : []), ...(version >= 11 ? studyPlanTables : [])];

export const columnLabels: Record<string, string> = {
 sha256: "原件 SHA256", filename: "原件文件名", byte_length: "原件字节数", imported_at: "导入时间戳",
 cells_json: "原文位置与文本", document_bytes: "Word 二进制原件", source_sha256: "关联原件 SHA256", initial_json: "不可变初始规划",
 id: "记录身份", entity_id: "实体身份", request_id: "请求身份", student_id: "学生UUID", alias: "学生代号",
 grade: "年级", subjects: "学科", goal: "学习目标", notes: "备注", created_at: "创建时间戳", revision: "修订版本",
 changed_at: "变更时间戳", saved_at: "保存时间戳", updated_at: "更新时间戳", study_date: "学习日期",
 task: "学习任务", completion: "实际完成", assessment: "测验观察", next_step: "后续跟进", subject: "学科",
 reported_on: "诉求日期", role: "家长身份", category: "类别", concern: "诉求内容", next_on: "下次跟进日",
 recorded_at: "登记时间戳", concern_id: "关联诉求", followed_on: "跟进日期", status: "原始状态", note: "跟进内容",
 payload: "完整原始业务字段", before_json: "变更前原值", after_json: "变更后原值", snapshot: "历史快照",
 snapshot_json: "历史完整快照", item_id: "关联工作事项", title: "事项", work_date: "工作日期", started_at: "开始时间",
 completed_at: "完成时间", learning_characteristics: "学习特点", communication_preferences: "沟通偏好",
 current_situation: "当前情况", strengths: "优势", weak_areas: "薄弱点", target_score: "目标成绩",
 deadline: "目标期限", strategy: "教学措施", observed_on: "观察日期", content: "内容", code: "来源代号",
 action: "单日处理方式", definition_json: "原规则内容", plan_id: "单日安排身份", rule_id: "来源规则", rule_revision: "来源规则版本",
 slot_id: "来源时段身份", occurrence_date: "规则日期",
 previous_status: "变更前状态", reason: "状态变更原因",
 digest: "来源摘要", source_json: "导入原文", plan_json: "已确认导入方案", state: "导入原状态",
 student_confirmed: "身份已确认", start_at: "预计开始", end_at: "预计结束", kind: "安排类型",
 check_in_at: "实际签到", check_out_at: "实际签退", outside_window: "超出预计时段", exception_reason: "例外原因",
 attendance_plan_id: "关联预计安排", planned_start: "计划开始", planned_end: "计划结束", actual_start: "实际开始",
 actual_end: "实际结束", outside_attendance_reason: "非预计到校原因", block_id: "关联学习块", position: "任务顺序",
 knowledge_points: "知识点", planned_target: "任务目标", result_notes: "任务结果", entity_kind: "实体类型",
};
