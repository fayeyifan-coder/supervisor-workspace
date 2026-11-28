import type { DatabaseSync } from "node:sqlite";
import { shanghaiParts } from "./schedule-calendar";
import { planId, planObject, validPlan } from "./study-plans";
import { currentPlan, planVersions } from "./study-plan-versions";
import type { PlanTask,PlanTaskLink } from "./study-plan-model";
import { WorkspaceFault } from "./workspace-fault";

export const planLinkSchema=[
  "study_plan_links","table",`CREATE TABLE study_plan_links (
    task_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    plan_id TEXT NOT NULL, revision INTEGER NOT NULL, entry_id TEXT NOT NULL, linked_at INTEGER NOT NULL,
    FOREIGN KEY(plan_id,revision) REFERENCES study_plan_versions(plan_id,revision)
  ) STRICT`,
] as const;
const taskFields=`SELECT t.id,t.content,t.subject,t.status,b.student_id,b.attendance_plan_id,b.id AS block_id,
  coalesce(b.actual_start,b.planned_start) AS happened_at FROM learning_tasks t JOIN learning_blocks b ON b.id=t.block_id`;
const invalid=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};
const taskDate=(row:Record<string,unknown>)=>shanghaiParts(Number(row.happened_at)).date;
function rowLink(row:Record<string,unknown>):PlanTaskLink{
 return {taskId:String(row.task_id),studentId:String(row.student_id),planId:String(row.plan_id),
   revision:Number(row.revision),entryId:String(row.entry_id),linkedAt:Number(row.linked_at)};
}
export function listPlanTasks(db:DatabaseSync,ops:DatabaseSync,studentId:string):PlanTask[]{
 planId(studentId);
 const links=new Map(db.prepare("SELECT * FROM study_plan_links WHERE student_id=?").all(studentId).map(row=>[String(row.task_id),rowLink(row)]));
 return ops.prepare(taskFields+" WHERE b.student_id=? ORDER BY happened_at DESC,t.id").all(studentId).map(row=>({
   id:String(row.id),date:taskDate(row),subject:String(row.subject??""),content:String(row.content),
   status:row.status as PlanTask["status"],attendanceId:row.attendance_plan_id?String(row.attendance_plan_id):null,
   blockId:String(row.block_id),link:links.get(String(row.id))??null}));
}
export function linkPlanTask(db:DatabaseSync,ops:DatabaseSync,input:unknown,now=Date.now()):PlanTaskLink{
 const raw=planObject(input), studentId=planId(raw.studentId), taskId=planId(raw.taskId), plan=planId(raw.planId), entryId=planId(raw.entryId);
 const revision=raw.revision;
 if(typeof revision!=="number"||!Number.isSafeInteger(revision)||revision<1)return invalid("请选择有效的执行修订。");
 const previous=db.prepare("SELECT * FROM study_plan_links WHERE task_id=?").get(taskId);
 if(previous){
  const saved=rowLink(previous);
  if(saved.planId!==plan||saved.revision!==revision||saved.entryId!==entryId||saved.studentId!==studentId) {
   return conflict("任务已关联原执行版本。已发生的历史关联不能改写。");
  }
  return saved;
 }
 const task=ops.prepare(taskFields+" WHERE t.id=? AND b.student_id=?").get(taskId,studentId);
 if(!task||!db.prepare("SELECT 1 FROM study_plans WHERE id=? AND student_id=?").get(plan,studentId)) {
  return invalid("任务或规划不属于当前学生。");
 }
 const effective=currentPlan(planVersions(db,plan),taskDate(task));
 const entry=effective?.fields.entries.find(row=>row.id===entryId);
 if(!entry||effective?.revision!==revision)return conflict("该版本在学习任务日期未生效，请选择当时有效的规划条目。");
 const date=taskDate(task);
 if(entry.from&&(entry.from>date||(entry.to||entry.from)<date))return conflict("任务日期超出该规划条目的已确认安排。");
 db.prepare("INSERT INTO study_plan_links VALUES(?,?,?,?,?,?)").run(taskId,studentId,plan,revision,entryId,now);
 return {taskId,studentId,planId:plan,revision,entryId,linkedAt:now};
}
export function verifyPlanLinks(db:DatabaseSync,operations?:DatabaseSync){
 const versions=db.prepare(`SELECT v.fields_json FROM study_plan_versions v JOIN study_plans p ON p.id=v.plan_id
   WHERE v.plan_id=? AND v.revision=? AND p.student_id=?`);
 const task=operations?.prepare(taskFields+" WHERE t.id=? AND b.student_id=?");
 for(const row of db.prepare("SELECT * FROM study_plan_links").iterate()){
  const v=rowLink(row);
  planId(v.taskId);planId(v.studentId);planId(v.planId);planId(v.entryId);
  const saved=versions.get(v.planId,v.revision,v.studentId);
  if(!saved||!validPlan(JSON.parse(String(saved.fields_json))).entries.some(entry=>entry.id===v.entryId)||
    !Number.isSafeInteger(v.linkedAt)||v.linkedAt<=0||task&&!task.get(v.taskId,v.studentId)){
   invalid("实际学习任务与原规划版本的关联损坏。");
  }
 }
}
