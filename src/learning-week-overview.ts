import type {DatabaseSync} from "node:sqlite";
import type {Student} from "./contracts";
import {shanghaiParts} from "./schedule-calendar";
import {readWeekFacts,reviewRange,fingerprint,hasUnfinishedEvidence,type ReviewRange,type WeekFacts} from "./learning-week-review";
import type {TrackingFields} from "./learning-tracking";
import {planObject,planString} from "./study-plans";
import {WorkspaceFault} from "./workspace-fault";

export type WeeklyQueueStatus="all"|"missing"|"unfinished"|"checks"|"sources"|"review"|"follow-up";
export interface WeeklyManagementQuery {
 range:ReviewRange;subject:string;lifecycle:"active"|"paused"|"archived"|"all";status:WeeklyQueueStatus;
}
type Jump={id:string;text:string;date:string;attendanceId?:string|null;kind:"visit"|"task"|"history"|"unit"|"work"};
export interface WeeklyManagementRow {
 studentId:string;alias:string;grade:string;lifecycle:NonNullable<Student["lifecycleStatus"]>;
 visits:number;recordedVisits:number;facts:number;planned:number;executed:number;completed:number;
 missing:Jump[];unfinished:Jump[];checks:Jump[];sources:Jump[];followUps:Jump[];
 review:{state:"missing"|"draft"|"confirmed";revision:number;outdated:boolean};
 planRef?:{planId:string;revision:number};scoreId?:string;
}
export interface WeeklyManagementView {range:ReviewRange;subjects:string[];rows:WeeklyManagementRow[];attendanceStudents:number;visits:number}
const statusOptions:WeeklyQueueStatus[]=["all","missing","unfinished","checks","sources","review","follow-up"];
export function weeklyManagementQuery(raw:unknown):WeeklyManagementQuery{
 const r=planObject(raw),lifecycle=r.lifecycle as WeeklyManagementQuery["lifecycle"],status=r.status as WeeklyQueueStatus;
 if(!["all","active","paused","archived"].includes(lifecycle)||!statusOptions.includes(status))throw new WorkspaceFault("invalid","请选择有效的总览筛选条件。");
 return {range:reviewRange(r.range),subject:planString(r.subject,40),lifecycle,status};
}
function checkQueue(m1:DatabaseSync,studentId:string,to:string,subject:string):Jump[]{
 const records=m1.prepare("SELECT a.entity_id,a.changed_on,a.payload FROM learning_unit_events a WHERE a.student_id=? AND a.changed_on<=? AND NOT EXISTS(SELECT 1 FROM learning_unit_events b WHERE b.entity_id=a.entity_id AND b.revision>a.revision AND b.changed_on<=?) ORDER BY a.changed_on,a.entity_id").all(studentId,to,to)
  .map(row=>({id:String(row.entity_id),date:String(row.changed_on),fields:JSON.parse(String(row.payload)) as TrackingFields}));
 const units=new Map(records.flatMap(row=>row.fields.kind==="unit"?[[row.id,row.fields.subject] as const]:[]));
 const checks=records.flatMap((row):Jump[]=>{
  const f=row.fields;
  if(f.kind!=="check"||(f.state!=="pending"&&f.state!=="retest")||(f.due&&f.due>to)||(subject&&units.get(f.unitId)!==subject))return [];
  return [{kind:"unit",id:f.unitId,date:f.due||row.date,text:(f.state==="retest"?"待复测 · ":"待检测 · ")+f.scope}];
 });
 const queued=new Set(checks.map(item=>item.id));
 return [...checks,...records.flatMap((row):Jump[]=>row.fields.kind==="unit"&&row.fields.state==="waiting"&&!queued.has(row.id)&&
  (!subject||row.fields.subject===subject)?[{kind:"unit",id:row.id,date:row.date,text:"待检测 · "+row.fields.title}]:[])];
}
function summary(m1:DatabaseSync,student:Student,facts:WeekFacts,subject:string):WeeklyManagementRow{
 const relevant=facts.facts.filter(row=>!subject||row.subject===subject),plans=facts.plans.filter(row=>!subject||row.subject===subject);
 const latest=m1.prepare("SELECT revision,state,source_digest FROM learning_week_reviews WHERE student_id=? AND from_on=? AND to_on=? ORDER BY revision DESC LIMIT 1").get(student.id,facts.range.from,facts.range.to);
 const recorded=new Set(facts.facts.flatMap(row=>row.attendanceId?[row.attendanceId]:[]));
 const jump=(row:WeekFacts["facts"][number]):Jump=>({id:row.taskId??row.id,date:row.date,text:row.content,attendanceId:row.attendanceId,
   kind:row.taskId&&row.attendanceId?"task":"history"});
 const missing=facts.visits.filter(row=>!recorded.has(row.id)).map((row):Jump=>({id:row.id,date:shanghaiParts(row.checkIn).date,text:"实际到课尚无关联登记",attendanceId:row.id,kind:"visit"}));
 const pending=facts.pendingTasks.filter(row=>!subject||row.subject===subject);
 const sources=[...relevant.filter(row=>row.planningNeedsReview).map(jump),...pending.filter(row=>row.planningNeedsReview).map((row):Jump=>({
   id:row.id,date:row.date,text:row.content,attendanceId:row.attendanceId,kind:row.attendanceId?"task":"history"}))];
 const followUps:Jump[]=[...facts.followUps.map((row):Jump=>({id:row.id,date:row.date,text:row.text,kind:"work"})),
  ...relevant.filter(row=>row.next).map((row):Jump=>({...jump(row),text:row.next!}))];
 return {studentId:student.id,alias:student.alias,grade:student.grade,lifecycle:student.lifecycleStatus??"active",visits:facts.visits.length,
   recordedVisits:facts.visits.length-missing.length,facts:relevant.length,planned:plans.length,executed:plans.filter(row=>row.evidence?.executed).length,completed:plans.filter(row=>row.evidence?.completed).length,
   missing,unfinished:relevant.filter(hasUnfinishedEvidence).map(jump),
   checks:checkQueue(m1,student.id,facts.range.to,subject),sources,followUps,
   review:{state:(latest?.state??"missing") as WeeklyManagementRow["review"]["state"],revision:Number(latest?.revision??0),
    outdated:Boolean(latest&&latest.source_digest!==fingerprint(facts))},
   planRef:plans[0]?{planId:plans[0].planId,revision:plans[0].revision}:undefined,
   scoreId:facts.scores.find(row=>!subject||row.subject===subject)?.id};
}
export function readWeeklyManagement(stores:{m1:DatabaseSync;ops:DatabaseSync;work:DatabaseSync},students:Student[],raw:unknown):WeeklyManagementView{
 const {range,subject,lifecycle,status}=weeklyManagementQuery(raw),subjects=new Set<string>(),rows:WeeklyManagementRow[]=[];
 for(const student of students){
  const state=student.lifecycleStatus??"active";
  if(lifecycle!=="all"&&state!==lifecycle)continue;
  const facts=readWeekFacts(stores,student.id,range);
  const own=new Set(student.subjects.split(/[、，,；;\s]+/).filter(Boolean));
  for(const row of [...facts.facts,...facts.pendingTasks,...facts.plans,...facts.scores])if(row.subject)own.add(row.subject);
  for(const item of facts.tracking)if(item.fields.kind==="unit")own.add(item.fields.subject);
  for(const value of own)subjects.add(value);
  if(!subject||own.has(subject))rows.push(summary(stores.m1,student,facts,subject));
 }
 const matches=(row:WeeklyManagementRow)=>status==="all"||
  status==="missing"&&row.missing.length>0||status==="unfinished"&&row.unfinished.length>0||
  status==="checks"&&row.checks.length>0||status==="sources"&&row.sources.length>0||
  status==="review"&&(row.review.state!=="confirmed"||row.review.outdated)||status==="follow-up"&&row.followUps.length>0;
 const filtered=rows.filter(matches).sort((a,b)=>a.alias.localeCompare(b.alias,"zh-CN")||a.studentId.localeCompare(b.studentId));
 return {range,rows:filtered,subjects:[...subjects].sort(),attendanceStudents:filtered.filter(row=>row.visits>0).length,
  visits:filtered.reduce((n,row)=>n+row.visits,0)};
}
