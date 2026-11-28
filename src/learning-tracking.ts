import type { DatabaseSync } from "node:sqlite";
import { readStudentRecords } from "./student-records";
import { studentPlanViews } from "./study-plan-versions";
import { planDate } from "./study-plan-model";
import { planId, planObject, planString } from "./study-plans";
import { shanghaiParts } from "./schedule-calendar";
import { sameSubject, type DailyPlanRef } from "./learning-daily";
import { WorkspaceFault } from "./workspace-fault";

export type UnitState="new"|"learning"|"learned"|"waiting"|"tested"|"consolidate";
export type CheckState="pending"|"tested"|"retest"|"cancelled";
export type ResultRef={kind:"score"|"training";id:string;revision:number};
export interface UnitFields {kind:"unit";subject:string;title:string;state:UnitState;basis:string;planning:DailyPlanRef|null}
export interface CheckFields {kind:"check";unitId:string;scope:string;due:string;state:CheckState;result:ResultRef|null;next:string;reminderId:string|null}
export type TrackingFields=UnitFields|CheckFields;
export type TrackingInput={id:string;studentId:string;requestId:string;expectedRevision:number;date:string;fields:TrackingFields};
export type TrackingRecord=TrackingInput&{revision:number;savedAt:number};
export interface TrackingView {
 records:TrackingRecord[]; history:TrackingRecord[];
 results:(ResultRef&{subject:string;date:string;title:string})[];
 reminders:{id:string;title:string;date:string}[];
 plans:(DailyPlanRef&{subject:string;title:string})[];
}
export const trackingSchema=["learning_unit_events","table","CREATE TABLE learning_unit_events (\n"+
 "    entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), request_id TEXT NOT NULL UNIQUE,\n"+
 "    student_id TEXT NOT NULL REFERENCES students(id), changed_on TEXT NOT NULL, saved_at INTEGER NOT NULL,\n"+
 "    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(entity_id,revision)\n  ) STRICT"] as const;
const invalid=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};
const unitStates:UnitState[]=["new","learning","learned","waiting","tested","consolidate"];
const checkStates:CheckState[]=["pending","tested","retest","cancelled"];
const rowSql="SELECT * FROM learning_unit_events";
const decode=(row:Record<string,unknown>):TrackingRecord=>({id:String(row.entity_id),studentId:String(row.student_id),requestId:String(row.request_id),
 revision:Number(row.revision),expectedRevision:Number(row.revision)-1,date:String(row.changed_on),savedAt:Number(row.saved_at),
 fields:JSON.parse(String(row.payload)) as TrackingFields});
function validRevision(value:unknown,min:number){
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>=Number.MAX_SAFE_INTEGER)return invalid("修订号无效。");
 return value;
}
function validDate(value:unknown,require=false){
 const date=planString(value,10,require);
 if(!planDate(date))return invalid("日期无效。");
 return date;
}
function input(raw:unknown):TrackingInput{
 const req=planObject(raw),data=planObject(req.fields);
 let fields:TrackingFields;
 if(data.kind==="unit"){
  const state=data.state as UnitState;
  if(!unitStates.includes(state))return invalid("单元状态无效。");
  const ref=data.planning==null?null:planObject(data.planning);
  fields={kind:"unit",subject:planString(data.subject,40,true),title:planString(data.title,150,true),state,basis:planString(data.basis,400,true),
   planning:ref&&{planId:planId(ref.planId),revision:validRevision(ref.revision,1),entryId:planId(ref.entryId)}};
 }else if(data.kind==="check"){
  const state=data.state as CheckState;
  if(!checkStates.includes(state))return invalid("检测状态无效。");
  const ref=data.result==null?null:planObject(data.result);
  if(ref&&ref.kind!=="score"&&ref.kind!=="training")return invalid("检测结果来源无效。");
  if((state==="tested"||state==="retest")&&!ref)return invalid("已检测或待复测需要关联真实检测结果。");
  fields={kind:"check",unitId:planId(data.unitId),scope:planString(data.scope,250,true),due:validDate(data.due),
   state,result:ref&&{kind:ref.kind as ResultRef["kind"],id:planId(ref.id),revision:validRevision(ref.revision,1)},
   next:planString(data.next,400),reminderId:data.reminderId==null?null:planId(data.reminderId)};
 }else return invalid("请选择单元或检测记录。");
 return {id:planId(req.id),studentId:planId(req.studentId),requestId:planId(req.requestId),
   expectedRevision:validRevision(req.expectedRevision,0),date:validDate(req.date,true),fields};
}
function resultDetails(db:DatabaseSync,studentId:string,ref:ResultRef){
 const table=ref.kind==="score"?"student_scores":"student_training_results";
 const row=db.prepare("SELECT payload FROM "+table+" WHERE entity_id=? AND revision=? AND student_id=?").get(ref.id,ref.revision,studentId);
 if(!row)return;
 const payload=JSON.parse(String(row.payload));return payload.version===2?payload.fields as Record<string,string>:payload as Record<string,string>;
}
function unitRecord(db:DatabaseSync,id:string,studentId:string){
 const row=db.prepare(rowSql+" WHERE entity_id=? AND student_id=? ORDER BY revision DESC LIMIT 1").get(id,studentId);
 const record=row?decode(row):undefined;
 return record?.fields.kind==="unit"?record.fields:undefined;
}
function checkReferences(db:DatabaseSync,work:DatabaseSync|undefined,record:TrackingInput){
 const {studentId,fields}=record;
 if(fields.kind==="unit"){
  const ref=fields.planning;
  if(!ref)return;
  const plan=studentPlanViews(db,studentId).find(row=>row.id===ref.planId);
  const entry=plan?.versions?.find(version=>version.revision===ref.revision)?.fields.entries.find(item=>item.id===ref.entryId);
  if(!entry||!sameSubject(entry.subject,fields.subject))return invalid("学习规划来源不属于该学生及学科。");
 }else{
  const unit=unitRecord(db,fields.unitId,studentId);
  if(!unit)return invalid("请选择该学生的学科单元。");
  if(fields.result){
   const result=resultDetails(db,studentId,fields.result);
   if(!result||!sameSubject(unit.subject,result.subject)||((result.takenOn||result.trainedOn)>record.date))
     return invalid("检测结果须来自这名学生的同学科已发生记录。");
  }
  if(fields.reminderId&&work&&!work.prepare("SELECT 1 FROM work_items WHERE id=? AND student_id=?").get(fields.reminderId,studentId))
    return invalid("工作提醒不属于该学生。");
 }
}
export function readTracking(db:DatabaseSync,work:DatabaseSync,id:unknown):TrackingView{
 const studentId=planId(id),version=Number(db.prepare("PRAGMA user_version").get()?.user_version);
 if(!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId))return invalid("找不到该学生。");
 const history=db.prepare(rowSql+" WHERE student_id=? ORDER BY revision DESC,entity_id").all(studentId).map(decode);
 const records=[...new Map(history.slice().reverse().map(row=>[row.id,row])).values()];
 const results=(["score","training"] as const).flatMap(kind=>readStudentRecords(db,version,kind,studentId).records.map(record=>({
  kind,id:record.id,revision:record.revision,subject:record.fields.subject,date:record.fields.takenOn||record.fields.trainedOn,title:record.fields.assessment||record.fields.activity
 })));
 const reminders=work.prepare("SELECT id,title,work_date AS date FROM work_items WHERE student_id=? ORDER BY work_date DESC LIMIT 100").all(studentId) as unknown as TrackingView["reminders"];
 const plans=studentPlanViews(db,studentId).flatMap(plan=>(plan.versions??[]).slice(0,1).flatMap(version=>
  version.fields.entries.map(entry=>({planId:plan.id,revision:version.revision,entryId:entry.id,subject:entry.subject,title:entry.content}))));
 return {records,history,results,reminders,plans};
}
export function writeTracking(db:DatabaseSync,work:DatabaseSync,raw:unknown,now=Date.now()):TrackingRecord{
 const req=input(raw),json=JSON.stringify(req.fields);
 const receipt=db.prepare(rowSql+" WHERE request_id=?").get(req.requestId);
 if(receipt){
  const prior=decode(receipt);
  if(prior.id!==req.id||prior.studentId!==req.studentId||prior.expectedRevision!==req.expectedRevision||prior.date!==req.date||receipt.payload!==json)
   return conflict("保存编号已用于其他单元记录。");
  return prior;
 }
 if(req.date>shanghaiParts(now).date)return invalid("实际状态变化日期不能在未来。");
 if(!db.prepare("SELECT 1 FROM students WHERE id=?").get(req.studentId))return invalid("找不到该学生。");
 const existing=db.prepare(rowSql+" WHERE entity_id=? ORDER BY revision DESC LIMIT 1").get(req.id);
 const latest=existing?decode(existing):undefined;
 if((latest?.revision??0)!==req.expectedRevision||latest&&latest.studentId!==req.studentId)return conflict("单元版本已变化，请重新读取。");
 if(latest&&(latest.fields.kind!==req.fields.kind||req.date<latest.date))return invalid("保留既有类型及状态变化顺序。");
 if(latest?.fields.kind==="unit"&&req.fields.kind==="unit"&&!sameSubject(latest.fields.subject,req.fields.subject))
  return conflict("单元学科已经固定。不同学科请新建单元。");
 if(latest?.fields.kind==="check"&&req.fields.kind==="check"&&latest.fields.unitId!==req.fields.unitId)
  return conflict("已登记的检测不能转到另一个单元。");
 checkReferences(db,work,req);
 if(req.fields.kind==="check"&&req.fields.reminderId&&db.prepare("SELECT 1 FROM learning_unit_events a WHERE a.entity_id<>? AND json_extract(a.payload,'$.reminderId')=? AND NOT EXISTS(SELECT 1 FROM learning_unit_events b WHERE b.entity_id=a.entity_id AND b.revision>a.revision)").get(req.id,req.fields.reminderId))
   return conflict("此工作事项已关联另一项检测。");
 if(req.fields.kind==="unit"&&req.fields.state==="tested"&&!db.prepare("SELECT 1 FROM learning_unit_events WHERE student_id=? AND json_extract(payload,'$.unitId')=? AND json_extract(payload,'$.result') IS NOT NULL LIMIT 1").get(req.studentId,req.id))
  return invalid("请先为本单元登记真实检测结果。");
 const revision=req.expectedRevision+1;
 db.prepare("INSERT INTO learning_unit_events VALUES(?,?,?,?,?,?,?)").run(req.id,revision,req.requestId,req.studentId,req.date,now,json);
 return {...req,revision,savedAt:now};
}
export function verifyTracking(db:DatabaseSync,work?:DatabaseSync){
 const last=new Map<string,TrackingRecord>();
 for(const row of db.prepare(rowSql+" ORDER BY entity_id,revision").iterate()){
  const record=decode(row),valid=input(record),old=last.get(record.id);
  if(record.revision!==(old?.revision??0)+1||!Number.isSafeInteger(record.savedAt)||record.savedAt<=0||
   JSON.stringify(valid.fields)!==row.payload||old&&(old.studentId!==record.studentId||old.fields.kind!==record.fields.kind||old.date>record.date))
    return invalid("单元或检测修订历史不完整。");
  checkReferences(db,work,record);last.set(record.id,record);
 }
}
