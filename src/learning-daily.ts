import type { DatabaseSync } from "node:sqlite";
import type { Lesson } from "./contracts";
import { planDate } from "./study-plan-model";
import { listPlanTasks } from "./study-plan-links";
import { currentPlan, studentPlanViews } from "./study-plan-versions";
import { planId, planObject, planString } from "./study-plans";
import { shanghaiMinute, shanghaiParts, shiftDate } from "./schedule-calendar";
import { WorkspaceFault } from "./workspace-fault";

export type DailyCompletion = "complete" | "partial" | "incomplete";
export type Mastery = "good" | "basic" | "review" | "unassessed";
export type DailyPlanRef = { planId: string; revision: number; entryId: string };
export interface DailyInput {
  id: string;
  studentId: string;
  date: string;
  subject: string;
  content: string;
  completion: DailyCompletion | "";
  mastery: Mastery;
  tags: string[];
  problem: string;
  intervention: string;
  next: string;
  source: "attendance" | "other";
  attendanceId: string | null;
  taskId: string | null;
  priorTaskId: string | null;
  planning: DailyPlanRef | null;
}
export interface DailyContext {
  visits: { id: string; start: number }[];
  tasks: { id: string; content: string; subject: string; attendanceId: string | null; used: boolean; planningNeedsReview: boolean }[];
  unfinished: { id: string; content: string; subject: string; date: string }[];
  plans: (DailyPlanRef & { subject: string; content: string })[];
  previous: Pick<Lesson, "date" | "subject" | "task" | "nextStep"> | null;
}
export const dailySchema = ["learning_record_details", "table", "CREATE TABLE learning_record_details (\n" +
  "    lesson_id TEXT PRIMARY KEY REFERENCES learning_records(id), attendance_id TEXT, task_id TEXT UNIQUE,\n" +
  "    prior_task_id TEXT, details_json TEXT NOT NULL CHECK(json_valid(details_json))\n  ) STRICT"] as const;
const invalid = (message: string): never => { throw new WorkspaceFault("invalid", message); };
const conflict = (message: string): never => { throw new WorkspaceFault("conflict", message); };
export const sameSubject = (a: string, b: string) => a.trim().normalize("NFKC") === b.trim().normalize("NFKC");

export function dailyInput(raw: unknown): DailyInput {
  const input = planObject(raw);
  const date = planString(input.date, 10, true);
  if (!planDate(date)) return invalid("请选择有效的实际学习日期。");
  const completion = input.completion;
  const mastery = input.mastery;
  if (completion !== "" && completion !== "complete" && completion !== "partial" && completion !== "incomplete") return invalid("完成程度无效。");
  if (mastery !== "good" && mastery !== "basic" && mastery !== "review" && mastery !== "unassessed") return invalid("掌握情况无效。");
  const source = input.source;
  if (source !== "attendance" && source !== "other") return invalid("请选择学习来源。");
  const optionalId = (value: unknown) => value == null || value === "" ? null : planId(value);
  const attendanceId = optionalId(input.attendanceId);
  if ((source === "attendance") !== Boolean(attendanceId)) return invalid("机构学习须选择该日实际到课记录。");
  if (!Array.isArray(input.tags) || input.tags.length > 10) return invalid("最多选择十个标签。");
  const tags = [...new Set(input.tags.map(tag => planString(tag, 20, true)))].sort();
  let planning: DailyPlanRef | null = null;
  if (input.planning != null) {
    const ref = planObject(input.planning);
    if (typeof ref.revision !== "number" || !Number.isSafeInteger(ref.revision) || ref.revision < 1) return invalid("规划版本无效。");
    planning = { planId: planId(ref.planId), revision: ref.revision, entryId: planId(ref.entryId) };
  }
  return { id: planId(input.id), studentId: planId(input.studentId), date, subject: planString(input.subject, 40, true),
    content: planString(input.content, 500, true), completion, mastery, tags,
    problem: planString(input.problem, 500), intervention: planString(input.intervention, 500), next: planString(input.next, 500),
    source, attendanceId, taskId: optionalId(input.taskId), priorTaskId: optionalId(input.priorTaskId), planning };
}
function actualVisits(ops: DatabaseSync, studentId: string, date: string) {
  return ops.prepare("SELECT id,check_in_at AS start FROM attendance_plans WHERE student_id=? AND check_in_at>=? AND check_in_at<? ORDER BY check_in_at")
    .all(studentId, shanghaiMinute(date,"00:00"), shanghaiMinute(shiftDate(date,1),"00:00")) as unknown as DailyContext["visits"];
}
function choices(db: DatabaseSync, studentId: string, date: string) {
  return studentPlanViews(db,studentId).flatMap(plan=>{
    const active=currentPlan(plan.versions??[],date);
    return active?.fields.entries.filter(entry=>entry.subject&&(!entry.from||entry.from<=date&&(entry.to||entry.from)>=date))
      .map(entry=>({planId:plan.id,revision:active.revision,entryId:entry.id,subject:entry.subject,content:entry.content}))??[];
  });
}
export function getDailyContext(db: DatabaseSync, ops: DatabaseSync, id: unknown, day: unknown): DailyContext {
  const studentId=planId(id),date=planString(day,10,true);
  if (!planDate(date)||!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId)) return invalid("学生或学习日期无效。");
  const previous=db.prepare("SELECT study_date AS date,subject,task,next_step AS nextStep FROM learning_records WHERE student_id=? AND study_date<=? ORDER BY study_date DESC,created_at DESC,id DESC LIMIT 1")
    .get(studentId,date) as DailyContext["previous"]|undefined;
  const tasks=listPlanTasks(db,ops,studentId);
  const used=new Set(db.prepare("SELECT d.task_id FROM learning_record_details d JOIN learning_records r ON r.id=d.lesson_id WHERE r.student_id=? AND d.task_id IS NOT NULL").all(studentId).map(row=>row.task_id));
  return {visits:actualVisits(ops,studentId,date),previous:previous??null,plans:choices(db,studentId,date),
    tasks:tasks.filter(task=>task.date===date&&(task.status==="done"||task.status==="skipped")).map(task=>({id:task.id,
      content:task.content,subject:task.subject,attendanceId:task.attendanceId,used:used.has(task.id),planningNeedsReview:task.linkState==="review"})),
    unfinished:tasks.filter(task=>task.date<=date&&(task.status==="planned"||task.status==="in_progress")).slice(0,30)
      .map(({id,content,subject,date})=>({id,content,subject,date}))};
}

const completionLabels:Record<DailyCompletion,string>={complete:"完成",partial:"部分完成",incomplete:"未完成"};
export function saveQuickLesson(db:DatabaseSync,ops:DatabaseSync,raw:unknown,now=Date.now()):Lesson {
  const input=dailyInput(raw);
  const prior=db.prepare("SELECT details_json FROM learning_record_details WHERE lesson_id=?").get(input.id);
  if(prior){
    if(prior.details_json!==JSON.stringify(input))return conflict("该保存编号已用于其他登记。请保留原记录并重新读取。");
  }else{
    if(input.date>shanghaiParts(now).date)return invalid("实际学习日期不能在未来。");
    const context=getDailyContext(db,ops,input.studentId,input.date);
    if(input.attendanceId&&!context.visits.some(visit=>visit.id===input.attendanceId))return invalid("到课记录不属于该学生的实际学习日。");
    if(input.priorTaskId&&!context.unfinished.some(task=>task.id===input.priorTaskId))return invalid("引用任务已变化或不属于该学生。");
    if(input.taskId){
      const task=context.tasks.find(task=>task.id===input.taskId);
      if(!task||task.attendanceId!==input.attendanceId||!sameSubject(task.subject,input.subject))return invalid("详细任务的日期、学生、到课或学科不一致。");
      if(task.used)return conflict("该详细任务已有快速登记，请从学习历史查看。");
      if(input.planning&&task.planningNeedsReview)return conflict("请先核对详细任务原有的规划来源。");
      const detail=listPlanTasks(db,ops,input.studentId).find(row=>row.id===input.taskId);
      if(input.planning&&detail?.linkState==="historical"&&
        (input.planning.planId!==detail.link?.planId||input.planning.revision!==detail.link.revision||input.planning.entryId!==detail.link.entryId))
        return conflict("该详细任务的历史规划来源已经固定。");
    }else if(context.tasks.some(task=>task.attendanceId===input.attendanceId&&sameSubject(task.subject,input.subject)&&task.content.trim()===input.content)){
      return conflict("同一次学习已有详细任务。选中该任务后补充登记。");
    }
    const ref=input.planning;
    if(ref&&!context.plans.some(plan=>plan.planId===ref.planId&&plan.revision===ref.revision&&plan.entryId===ref.entryId&&sameSubject(plan.subject,input.subject)))
      return conflict("规划条目或学科已变化，请重新核对当日生效版本。");
    if(db.prepare("SELECT 1 FROM learning_records WHERE id=?").get(input.id))return conflict("登记编号已经用于既有学习记录。");
    db.prepare("INSERT INTO learning_records VALUES(?,?,?,?,?,?,?,?,?)")
      .run(input.id,input.studentId,input.date,input.subject,input.content,input.completion?completionLabels[input.completion]:"未登记",
        [input.problem,input.intervention].filter(Boolean).join("\n"),input.next,now);
    db.prepare("INSERT INTO learning_record_details VALUES(?,?,?,?,?)")
      .run(input.id,input.attendanceId,input.taskId,input.priorTaskId,JSON.stringify(input));
  }
  return db.prepare("SELECT id,student_id AS studentId,study_date AS date,subject,task,completion,assessment,next_step AS nextStep,created_at AS createdAt FROM learning_records WHERE id=?")
    .get(input.id) as unknown as Lesson;
}

export function verifyDailyRecords(db:DatabaseSync,ops?:DatabaseSync){
  for(const row of db.prepare("SELECT d.*,r.student_id,r.subject,r.study_date,r.task FROM learning_record_details d JOIN learning_records r ON r.id=d.lesson_id").iterate()){
    const input=dailyInput(JSON.parse(String(row.details_json)));
    if(JSON.stringify(input)!==row.details_json||input.id!==row.lesson_id||input.studentId!==row.student_id||input.date!==row.study_date||
      input.subject!==row.subject||input.content!==row.task||input.attendanceId!==row.attendance_id||input.taskId!==row.task_id||input.priorTaskId!==row.prior_task_id)
      return invalid("快速登记与原学习事实的对应关系不完整。");
    if(input.planning){
      const ref=input.planning;
      const snapshot=db.prepare("SELECT v.fields_json FROM study_plan_versions v JOIN study_plans p ON p.id=v.plan_id WHERE v.plan_id=? AND v.revision=? AND p.student_id=?").get(ref.planId,ref.revision,input.studentId);
      if(!snapshot||!JSON.parse(String(snapshot.fields_json)).entries.some((entry:{id:string;subject:string})=>entry.id===ref.entryId&&sameSubject(entry.subject,input.subject)))
        return invalid("原规划条目身份不可核验。");
    }
    if(!ops)continue;
    if(input.attendanceId&&!actualVisits(ops,input.studentId,input.date).some(visit=>visit.id===input.attendanceId))return invalid("快速登记到课来源不可核验。");
    if(input.taskId||input.priorTaskId){
      const tasks=listPlanTasks(db,ops,input.studentId);
      if(input.taskId&&!tasks.some(task=>task.id===input.taskId&&task.date===input.date&&task.attendanceId===input.attendanceId&&sameSubject(task.subject,input.subject)))
        return invalid("快速登记详细任务来源不可核验。");
      if(input.priorTaskId&&!tasks.some(task=>task.id===input.priorTaskId)){
        const old=ops.prepare("SELECT 1 FROM operation_changes WHERE student_id=? AND entity_kind='block' AND EXISTS(SELECT 1 FROM json_each(snapshot_json,'$.tasks') WHERE json_extract(value,'$.id')=?) LIMIT 1").get(input.studentId,input.priorTaskId);
        if(!old)return invalid("快速登记引用的未完任务来源不可核验。");
      }
    }
  }
}
