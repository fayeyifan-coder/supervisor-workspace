import type { DatabaseSync } from "node:sqlite";
import { shanghaiParts } from "./schedule-calendar";
import { planId, planObject, validPlan } from "./study-plans";
import { currentPlan, planVersions } from "./study-plan-versions";
import type { PlanTask,PlanTaskLink,PlanVersion } from "./study-plan-model";
import type { LearningBlock } from "./operations";
import { WorkspaceFault } from "./workspace-fault";

export const planLinkSchema=[
  "study_plan_links","table",`CREATE TABLE study_plan_links (
    task_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    plan_id TEXT NOT NULL, revision INTEGER NOT NULL, entry_id TEXT NOT NULL, linked_at INTEGER NOT NULL,
    basis_revision INTEGER NOT NULL CHECK(basis_revision > 0),
    FOREIGN KEY(plan_id,revision) REFERENCES study_plan_versions(plan_id,revision)
  ) STRICT`,
] as const;
const taskFields=`SELECT t.id,t.content,t.subject,t.status,b.student_id,b.attendance_plan_id,b.id AS block_id,
  b.planned_start,b.planned_end,b.actual_start,b.revision AS block_revision,b.status AS block_status,
  coalesce(b.actual_start,b.planned_start) AS happened_at FROM learning_tasks t JOIN learning_blocks b ON b.id=t.block_id`;
const blockHistory=`SELECT snapshot_json,changed_at FROM operation_changes
  WHERE entity_kind='block' AND entity_id=? AND student_id=?`;
const invalid=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};
const pendingTaskDate=(row:Record<string,unknown>)=>shanghaiParts(Number(row.happened_at)).date;
function rowLink(row:Record<string,unknown>):PlanTaskLink{
 return {taskId:String(row.task_id),studentId:String(row.student_id),planId:String(row.plan_id),
   revision:Number(row.revision),entryId:String(row.entry_id),linkedAt:Number(row.linked_at),basisRevision:Number(row.basis_revision)};
}
function savedBasis(ops:DatabaseSync,task:Record<string,unknown>,link:PlanTaskLink){
 const row=ops.prepare(blockHistory+" AND revision=?").get(String(task.block_id),link.studentId,link.basisRevision);
 return row?JSON.parse(String(row.snapshot_json)) as LearningBlock:undefined;
}
function firstTaskOutcome(ops:DatabaseSync,task:Record<string,unknown>){
 if(task.status==="planned")return;
 const row=ops.prepare(blockHistory+` AND EXISTS(
   SELECT 1 FROM json_each(snapshot_json,'$.tasks') AS item
   WHERE json_extract(item.value,'$.id')=? AND json_extract(item.value,'$.status')<>'planned')
   ORDER BY revision LIMIT 1`).get(String(task.block_id),String(task.student_id),String(task.id));
 return row?{block:JSON.parse(String(row.snapshot_json)) as LearningBlock,changedAt:Number(row.changed_at)}:undefined;
}
function subjectMatches(left:unknown,right:string){
 return typeof left==="string"&&!!right&&left.trim().normalize("NFKC")===right.trim().normalize("NFKC");
}
function effectiveEntry(versions:PlanVersion[],link:PlanTaskLink,date:string){
 const effective=currentPlan(versions,date);
 return effective?.revision===link.revision?effective.fields.entries.find(row=>row.id===link.entryId):undefined;
}
function entryDateMatches(entry:{from:string;to:string},date:string){
 return !entry.from||entry.from<=date&&(entry.to||entry.from)>=date;
}
function stillMatches(ops:DatabaseSync,task:Record<string,unknown>,link:PlanTaskLink,date:string){
 const basis=savedBasis(ops,task,link), prior=basis?.tasks.find(item=>item.id===link.taskId);
 return !!basis&&!!prior&&basis.plannedStart===task.planned_start&&basis.plannedEnd===task.planned_end&&
   prior.content===task.content&&(prior.subject??"")===(task.subject??"")&&
   shanghaiParts(basis.actualStart??basis.plannedStart).date===date;
}
function pendingSourceMatches(db:DatabaseSync,ops:DatabaseSync,task:Record<string,unknown>,link:PlanTaskLink,date:string){
 const entry=effectiveEntry(planVersions(db,link.planId),link,date);
 return !!entry&&entryDateMatches(entry,date)&&subjectMatches(task.subject,entry.subject)&&stillMatches(ops,task,link,date);
}
function sameSource(source:PlanTaskLink,link:PlanTaskLink){
 return source.taskId===link.taskId&&source.planId===link.planId&&source.revision===link.revision&&
   source.entryId===link.entryId&&source.basisRevision===link.basisRevision&&source.studentId===link.studentId&&source.linkedAt===link.linkedAt;
}
function sourceState(db:DatabaseSync,ops:DatabaseSync,task:Record<string,unknown>,link:PlanTaskLink,
 outcome=firstTaskOutcome(ops,task)):NonNullable<PlanTask["linkState"]>{
 if(task.status!=="planned"){
  const basisTask=savedBasis(ops,task,link)?.tasks.find(item=>item.id===link.taskId);
  const confirmedAtOutcome=outcome?.block.planSourceAtOutcome;
  return basisTask&&basisTask.status!=="planned"||confirmedAtOutcome&&sameSource(confirmedAtOutcome,link)?"historical":"review";
 }
 const pending=task.block_status==="planned"||task.block_status==="in_progress";
 return pending&&pendingSourceMatches(db,ops,task,link,pendingTaskDate(task))?"planned":"review";
}
export function confirmedPlanSourceAtOutcome(db:DatabaseSync,ops:DatabaseSync,studentId:string,taskId:string,at:number){
 const row=db.prepare("SELECT * FROM study_plan_links WHERE task_id=? AND student_id=?").get(taskId,studentId);
 if(!row)return;
 const task=ops.prepare(taskFields+" WHERE t.id=? AND b.student_id=?").get(taskId,studentId),link=rowLink(row);
 if(task&&pendingSourceMatches(db,ops,task,link,shanghaiParts(at).date))return link;
}
export function listPlanTasks(db:DatabaseSync,ops:DatabaseSync,studentId:string,scope?:{attendanceId:string}):PlanTask[]{
 planId(studentId);
 const links=new Map(db.prepare("SELECT * FROM study_plan_links WHERE student_id=?").all(studentId).map(row=>[String(row.task_id),rowLink(row)]));
 const filter=scope?" AND b.attendance_plan_id=?":"";
 const params=scope?[studentId,scope.attendanceId]:[studentId];
 return ops.prepare(taskFields+" WHERE b.student_id=?"+filter+" ORDER BY happened_at DESC,t.id").all(...params).map(row=>{
   const id=String(row.id),link=links.get(id)??null,outcome=firstTaskOutcome(ops,row);
   const linkState=link?sourceState(db,ops,row,link,outcome):null;
   return {id,date:outcome?shanghaiParts(outcome.changedAt).date:pendingTaskDate(row),subject:String(row.subject??""),content:String(row.content),
     status:row.status as PlanTask["status"],attendanceId:row.attendance_plan_id?String(row.attendance_plan_id):null,
     blockId:String(row.block_id),link,linkState,linkable:(row.block_status==="planned"||row.block_status==="in_progress"||row.status!=="planned")&&linkState!=="historical"};
 });
}
export function linkPlanTask(db:DatabaseSync,ops:DatabaseSync,input:unknown,now=Date.now()):PlanTaskLink{
 const raw=planObject(input), studentId=planId(raw.studentId), taskId=planId(raw.taskId), plan=planId(raw.planId), entryId=planId(raw.entryId);
 const revision=raw.revision;
 if(typeof revision!=="number"||!Number.isSafeInteger(revision)||revision<1)return invalid("请选择有效的执行修订。");
 const task=ops.prepare(taskFields+" WHERE t.id=? AND b.student_id=?").get(taskId,studentId);
 if(!task||!db.prepare("SELECT 1 FROM study_plans WHERE id=? AND student_id=?").get(plan,studentId)) {
  return invalid("任务或规划不属于当前学生。");
 }
 const row=db.prepare("SELECT * FROM study_plan_links WHERE task_id=?").get(taskId);
 const saved=row?rowLink(row):undefined;
 const same=saved?.planId===plan&&saved.revision===revision&&saved.entryId===entryId&&saved.studentId===studentId;
 const outcome=firstTaskOutcome(ops,task);
 const state=saved?sourceState(db,ops,task,saved,outcome):null;
 if(state==="historical"){
  if(same)return saved!;
  return conflict("已确认的历史关联不能改写。");
 }
 if(task.block_status==="cancelled"||task.block_status==="done"&&task.status==="planned")return conflict("学习块已结束且任务没有实际记录。");
 if(task.status!=="planned"&&!outcome)return conflict("任务的实际记录时间无法核对。");
 if(same&&state==="planned")return saved!;
 const link={taskId,studentId,planId:plan,revision,entryId,linkedAt:now,basisRevision:Number(task.block_revision)};
 const date=outcome?shanghaiParts(outcome.changedAt).date:pendingTaskDate(task);
 const versions=planVersions(db,plan).filter(version=>!outcome||version.changedAt<=outcome.changedAt);
 const entry=effectiveEntry(versions,link,date);
 if(!entry)return conflict("该版本在学习任务日期未生效，请选择当时有效的规划条目。");
 if(!entryDateMatches(entry,date))return conflict("任务日期超出该规划条目的已确认安排。");
 if(!subjectMatches(task.subject,entry.subject))return conflict("任务与规划条目的学科不一致或尚未登记，请核对学科。");
 if(!savedBasis(ops,task,link)?.tasks.some(item=>item.id===taskId))return conflict("任务当前修订无法核对，请重新读取。");
 db.prepare(`INSERT INTO study_plan_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
   plan_id=excluded.plan_id, revision=excluded.revision, entry_id=excluded.entry_id, linked_at=excluded.linked_at,
   basis_revision=excluded.basis_revision`).run(taskId,studentId,plan,revision,entryId,now,link.basisRevision);
 return link;
}
export function verifyPlanLinks(db:DatabaseSync,operations?:DatabaseSync){
 const versions=db.prepare(`SELECT v.fields_json FROM study_plan_versions v JOIN study_plans p ON p.id=v.plan_id
   WHERE v.plan_id=? AND v.revision=? AND p.student_id=?`);
 const task=operations?.prepare(taskFields+" WHERE t.id=? AND b.student_id=?");
 const links=new Map<string,PlanTaskLink>();
 for(const row of db.prepare("SELECT * FROM study_plan_links").iterate()){
  const v=rowLink(row);
  planId(v.taskId);planId(v.studentId);planId(v.planId);planId(v.entryId);
  const saved=versions.get(v.planId,v.revision,v.studentId);
  const linkedTask=task?.get(v.taskId,v.studentId);
  if(!saved||!validPlan(JSON.parse(String(saved.fields_json))).entries.some(entry=>entry.id===v.entryId)||
    !Number.isSafeInteger(v.linkedAt)||v.linkedAt<=0||!Number.isSafeInteger(v.basisRevision)||v.basisRevision<1||
    operations&&(!linkedTask||!savedBasis(operations,linkedTask,v)?.tasks.some(item=>item.id===v.taskId))){
   invalid("学习任务与原规划版本的关联损坏。");
  }
  links.set(v.taskId,v);
 }
 if(!operations)return;
 const seen=new Set<string>();
 for(const row of operations.prepare(`SELECT snapshot_json FROM operation_changes
   WHERE entity_kind='block' AND json_type(snapshot_json,'$.planSourceAtOutcome') IS NOT NULL`).iterate()){
  const block=JSON.parse(String(row.snapshot_json)) as LearningBlock;
  const source=block.planSourceAtOutcome;
  const saved=source&&links.get(source.taskId);
  const target=source&&block.tasks.find(item=>item.id===source.taskId);
  if(!source||!saved||!sameSource(source,saved)||source.studentId!==block.studentId||source.basisRevision>=block.revision||
    !target||target.status==="planned"||seen.has(target.id))invalid("实际任务的规划来源快照与历史关联不一致。");
  seen.add(target!.id);
 }
}
