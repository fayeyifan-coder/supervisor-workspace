import type { DatabaseSync } from "node:sqlite";
import { shanghaiParts } from "./schedule-calendar";
import { planDate, type PlanDraft, type PlanRecord, type PlanVersion, type PlanVersionInput } from "./study-plan-model";
import { checkPlanBudget, listStudyPlans, planId, planObject, planString, studyPlanSource, validPlan } from "./study-plans";
import { WorkspaceFault } from "./workspace-fault";

export const planVersionSchema = [
 "study_plan_versions","table",`CREATE TABLE study_plan_versions (
   plan_id TEXT NOT NULL REFERENCES study_plans(id), revision INTEGER NOT NULL,
   request_id TEXT NOT NULL UNIQUE, effective_on TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('draft','active','history')), reason TEXT NOT NULL, fields_json TEXT NOT NULL,
   changed_at INTEGER NOT NULL, PRIMARY KEY(plan_id,revision)
 ) STRICT`,
] as const;
const fail=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};

export function versionInput(raw:unknown):PlanVersionInput{
 const value=planObject(raw);
 const state=value.state, expectedRevision=value.expectedRevision;
 if((state!=="draft"&&state!=="history"&&state!=="active")||typeof expectedRevision!=="number"||
  !Number.isSafeInteger(expectedRevision)||expectedRevision<0)return fail("规划执行状态或预期修订无效。");
 const effectiveOn=planString(value.effectiveOn,10,true),startsOn=planString(value.startsOn,10),endsOn=planString(value.endsOn,10);
 if(!planDate(effectiveOn)||!planDate(startsOn)||!planDate(endsOn)||endsOn&&(!startsOn||endsOn<startsOn)||
  state==="active"&&!startsOn)fail("执行期间无效。启用前须指定实际起日，止日可留空。");
 return {studentId:planId(value.studentId),planId:planId(value.planId),requestId:planId(value.requestId),expectedRevision,
  state,effectiveOn,startsOn,endsOn,reason:planString(value.reason,1000,true),fields:validPlan(value.fields)};
}
function decode(row:Record<string,unknown>):PlanVersion{
 return {revision:Number(row.revision),effectiveOn:String(row.effective_on),startsOn:String(row.starts_on),endsOn:String(row.ends_on),
  state:row.state as PlanVersion["state"],reason:String(row.reason),changedAt:Number(row.changed_at),fields:validPlan(JSON.parse(String(row.fields_json)))};
}
export function planVersions(db:DatabaseSync,id:string):PlanVersion[]{
 return db.prepare("SELECT * FROM study_plan_versions WHERE plan_id=? ORDER BY revision DESC").all(planId(id)).map(decode);
}
export function currentPlan(versions:readonly PlanVersion[], date:string){
 const rule=versions.find(row=>row.effectiveOn<=date);
 return rule?.state==="active"&&rule.startsOn<=date&&(!rule.endsOn||rule.endsOn>=date)?rule:undefined;
}
export function studentPlanViews(db:DatabaseSync,studentId:string):PlanRecord[]{
 return listStudyPlans(db,studentId).map(plan=>({...plan,versions:planVersions(db,plan.id)}));
}
export function addManualStudyPlan(db:DatabaseSync,studentId:string,id:string,raw:unknown){
 planId(studentId);planId(id);
 const fields=validPlan(raw), payload=JSON.stringify(fields);
 if(fields.entries.some(entry=>entry.sources.length))fail("手工规划不能引用尚未导入的 Word 原文。");
 if(!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId))fail("找不到该学生。");
 const prior=db.prepare("SELECT * FROM study_plans WHERE id=?").get(id);
 if(prior){if(prior.student_id!==studentId||prior.initial_json!==payload||prior.source_sha256!==null)conflict("规划身份已用于其他内容。");return id;}
 checkPlanBudget(db,Buffer.byteLength(payload));
 db.prepare("INSERT INTO study_plans VALUES(?,?,NULL,?,?)").run(id,studentId,payload,Date.now());
 return id;
}
function activeIntervals(versions:readonly PlanVersion[]){
 const result:{row:PlanVersion;from:string;to:string}[]=[];
 let newerFrom="9999-01-01";
 for(const row of versions){
  const next=newerFrom;
  if(row.effectiveOn>=next)continue;
  newerFrom=row.effectiveOn;
  if(row.state==="active"){
   const from=row.startsOn>row.effectiveOn?row.startsOn:row.effectiveOn;
   // Upper bound from a newer effective date is exclusive.
   const afterLast=row.endsOn?new Date(Date.parse(row.endsOn)+86400000).toISOString().slice(0,10):"9999-01-01";
   const to=afterLast<next?afterLast:next;
   if(from<to)result.push({row,from,to});
  }
 }
 return result;
}
export function savePlanVersion(db:DatabaseSync,raw:unknown,allowRevision:boolean, now=Date.now()):PlanVersion {
 const req=versionInput(raw), json=JSON.stringify(req.fields);
 const base=listStudyPlans(db,req.studentId).find(item=>item.id===req.planId);
 if(!base)return fail("规划不存在或不属于所选学生。");
 const prior=db.prepare("SELECT * FROM study_plan_versions WHERE request_id=?").get(req.requestId);
 if(prior){
  if(prior.plan_id!==req.planId||prior.revision!==req.expectedRevision+1||prior.effective_on!==req.effectiveOn||
    prior.starts_on!==req.startsOn||prior.ends_on!==req.endsOn||prior.state!==req.state||prior.reason!==req.reason||prior.fields_json!==json){
   return conflict("保存编号已用于其他规划修订。");
  }
  return decode(prior);
 }
 const versions=planVersions(db,req.planId), latest=versions[0];
 if((latest?.revision??0)!==req.expectedRevision)conflict("已有更新的规划修订，请刷新后再编辑。");
 const original=latest?.fields??base.initial;
 if(!allowRevision&&JSON.stringify(original)!==json)fail("当前档案版本仅支持发布与执行期间设置。");
 const today=shanghaiParts(now).date;
 if(req.effectiveOn<today)fail("规划设置只影响今天及以后，已发生的学习历史保留。");
 const refs=new Set(base.source?studyPlanSource(db,req.studentId,req.planId).cells.map(cell=>cell.ref):[]);
 if(req.fields.entries.some(entry=>entry.sources.some(ref=>!refs.has(ref))))fail("版本中的原文位置不属于该规划。");
 if(req.state==="active"&&req.fields.entries.some(entry=>!entry.subject))fail("启用前请确认每条任务的学科。");
 const candidate:PlanVersion={revision:req.expectedRevision+1,effectiveOn:req.effectiveOn,startsOn:req.startsOn,endsOn:req.endsOn,
  state:req.state,reason:req.reason,changedAt:now,fields:req.fields};
 const added=activeIntervals([candidate]);
 for(const other of studentPlanViews(db,req.studentId)){
  if(other.id===req.planId)continue;
  if(added.some(left=>activeIntervals(other.versions??[]).some(right=>left.from<right.to&&right.from<left.to&&
    left.row.fields.subjects.some(subject=>right.row.fields.subjects.includes(subject))))) {
    conflict("该学生已有同学科且期间重叠的执行规划。请先明确原规划结束日或归档。");
  }
 }
 checkPlanBudget(db,Buffer.byteLength(json)+Buffer.byteLength(req.reason));
 db.prepare("INSERT INTO study_plan_versions VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(req.planId,candidate.revision,req.requestId,req.effectiveOn,req.startsOn,req.endsOn,req.state,req.reason,json,now);
 return candidate;
}
export function verifyPlanVersions(db:DatabaseSync){
 const students=db.prepare("SELECT id,student_id,source_sha256 FROM study_plans").all();
 for(const plan of students){
  const versions=db.prepare("SELECT * FROM study_plan_versions WHERE plan_id=? ORDER BY revision").all(String(plan.id));
  const refs=new Set(plan.source_sha256?studyPlanSource(db,String(plan.student_id),String(plan.id)).cells.map(cell=>cell.ref):[]);
  for(const [i,row] of versions.entries()){
   const v=decode(row);
   versionInput({...v,planId:plan.id,studentId:plan.student_id,requestId:row.request_id,expectedRevision:i});
   if(v.revision!==i+1||!Number.isSafeInteger(v.changedAt)||v.changedAt<=0||JSON.stringify(v.fields)!==row.fields_json||
     v.fields.entries.some(entry=>entry.sources.some(ref=>!refs.has(ref))))fail("学习规划修订链或原文引用损坏。");
  }
 }
 checkPlanBudget(db,0);
}
