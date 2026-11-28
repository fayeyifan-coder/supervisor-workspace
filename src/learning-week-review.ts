import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {readStudentRecords} from "./student-records";
import {listPlanTasks} from "./study-plan-links";
import {currentPlan,studentPlanViews} from "./study-plan-versions";
import {readTracking} from "./learning-tracking";
import type {TrackingFields} from "./learning-tracking";
import type {DailyInput,DailyPlanRef} from "./learning-daily";
import {mondayOf,shanghaiMinute,shiftDate} from "./schedule-calendar";
import {planId,planObject,planString} from "./study-plans";
import {WorkspaceFault} from "./workspace-fault";

export interface ReviewRange {from:string;to:string}
type Event={id:string;date:string;text:string;revision?:number;next?:string};
type Visit={id:string;checkIn:number;checkOut:number|null;revision:number};
type Fact={id:string;date:string;subject:string;content:string;completion:string;recordedAt:number|null;source:"quick"|"history"|"detail";
 attendanceId:string|null;taskId:string|null;mastery?:string;tags?:string[];problem?:string;intervention?:string;next?:string;
 planning?:DailyPlanRef;planningNeedsReview?:boolean};
type Score={id:string;revision:number;date:string;subject:string;title:string;score:number;maximum:number};
type SourcePlan=DailyPlanRef&{subject:string;content:string;from:string;to:string;execution:"recorded"|"incomplete"|"unrecorded"};
export interface WeekFacts {
 studentId:string;range:ReviewRange;visits:Visit[];onSiteMinutes:number|null;visitsWithoutCheckout:number;
 facts:Fact[];pendingTasks:{id:string;subject:string;date:string;content:string;attendanceId:string|null;planningNeedsReview:boolean}[];
 plans:SourcePlan[];tracking:{id:string;revision:number;date:string;fields:TrackingFields}[];
 scores:Score[];scoreChanges:{subject:string;from:string;to:string;ratePoints:number;rawDelta:number|null}[];
 contacts:Event[];followUps:Event[];
}
export interface ReviewNotes {evaluation:string;issues:string;next:string;parent:string}
export interface ReviewSave {studentId:string;range:ReviewRange;requestId:string;expectedRevision:number;sourceDigest:string;
 state:"draft"|"confirmed";notes:ReviewNotes}
export interface ReviewSnapshot extends ReviewSave {revision:number;savedAt:number;facts:WeekFacts}
export interface ReviewView {facts:WeekFacts;sourceDigest:string;outdated:boolean;history:ReviewSnapshot[]}
type Stores={m1:DatabaseSync;ops:DatabaseSync;work:DatabaseSync};

export const reviewSchema=["learning_week_reviews","table","CREATE TABLE learning_week_reviews (\n"+
 "    student_id TEXT NOT NULL REFERENCES students(id), from_on TEXT NOT NULL, to_on TEXT NOT NULL,\n"+
 "    revision INTEGER NOT NULL CHECK(revision>0), request_id TEXT NOT NULL UNIQUE, saved_at INTEGER NOT NULL,\n"+
 "    state TEXT NOT NULL CHECK(state IN ('draft','confirmed')), source_digest TEXT NOT NULL,\n"+
 "    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), notes_json TEXT NOT NULL CHECK(json_valid(notes_json)),\n"+
 "    PRIMARY KEY(student_id,from_on,to_on,revision)\n  ) STRICT"] as const;
const fail=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};
export const fingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function reviewRange(raw:unknown):ReviewRange {
 const r=planObject(raw),from=planString(r.from,10,true),to=planString(r.to,10,true);
 if(shanghaiMinute(from,"00:00")===null||shanghaiMinute(to,"00:00")===null||to<from||to>shiftDate(from,30))return fail("请选择 1 至 31 天的复盘日期。");
 return {from,to};
}
export function periodOf(date:string,workWeek:boolean):ReviewRange{
 const monday=mondayOf(date);
 return {from:shiftDate(monday,workWeek?1:0),to:shiftDate(monday,6)};
}
const inRange=(date:string,{from,to}:ReviewRange)=>date>=from&&date<=to;
const sourceKey=(ref:DailyPlanRef)=>[ref.planId,ref.revision,ref.entryId].join("/");
const qualify=(field:string)=>field==="complete"||field==="完成"||field==="已完成";
const partial=(field:string)=>field==="partial"||field==="incomplete"||field==="部分完成"||field==="未完成"||field==="skipped";
function minutes(visits:Visit[],start:number,end:number){
 const intervals=visits.filter(v=>v.checkOut!==null).map(v=>[Math.max(start,v.checkIn),Math.min(end,v.checkOut!)])
  .filter(([a,b])=>a<=b).sort(([a],[b])=>a-b);
 if(!intervals.length)return null;
 let current=intervals[0],ms=0;
 for(const range of intervals.slice(1)){
  if(range[0]<=current[1])current[1]=Math.max(current[1],range[1]);
  else{ms+=current[1]-current[0];current=range;}
 }
 return Math.floor((ms+current[1]-current[0])/60000);
}
function recordFacts({m1,ops}:Stores,studentId:string,range:ReviewRange){
 const tasks=listPlanTasks(m1,ops,studentId),byTask=new Map(tasks.map(task=>[task.id,task]));
 const rows=m1.prepare("SELECT l.*, d.details_json FROM learning_records l LEFT JOIN learning_record_details d ON d.lesson_id=l.id WHERE l.student_id=? AND study_date BETWEEN ? AND ? ORDER BY study_date,l.created_at,l.id").all(studentId,range.from,range.to);
 const attached=new Set<string>();
 const facts=rows.map((row):Fact=>{
  const detail=row.details_json?JSON.parse(String(row.details_json)) as DailyInput:undefined;
  const task=detail?.taskId?byTask.get(detail.taskId):undefined;
  if(detail?.taskId)attached.add(detail.taskId);
  const inherited=task?.linkState==="historical"&&task.link?{planId:task.link.planId,revision:task.link.revision,entryId:task.link.entryId}:undefined;
  return {id:String(row.id),date:String(row.study_date),subject:String(row.subject),content:String(row.task),completion:detail?.completion||String(row.completion),
   recordedAt:Number(row.created_at),source:detail?"quick":"history",attendanceId:detail?.attendanceId??null,taskId:detail?.taskId??null,
   mastery:detail?.mastery,tags:detail?.tags,problem:detail?.problem??String(row.assessment),intervention:detail?.intervention,next:String(row.next_step),
   planning:task?.linkState==="review"?undefined:detail?.planning??inherited,planningNeedsReview:task?.linkState==="review"};
 });
 const factsById=new Map(ops.prepare("SELECT id,completed_at,result_notes FROM learning_tasks WHERE block_id IN(SELECT id FROM learning_blocks WHERE student_id=?)").all(studentId).map(row=>[row.id,row]));
 for(const task of tasks){
  if(attached.has(task.id)||!inRange(task.date,range)||task.status==="planned")continue;
  const row=factsById.get(task.id);
  const link=task.linkState==="historical"?task.link:undefined;
  facts.push({id:task.id,date:task.date,subject:task.subject,content:task.content,completion:task.status,
    recordedAt:typeof row?.completed_at==="number"?row.completed_at:null,source:"detail",attendanceId:task.attendanceId,taskId:task.id,
    problem:row?.result_notes?String(row.result_notes):undefined,
    planning:link?{planId:link.planId,revision:link.revision,entryId:link.entryId}:undefined,planningNeedsReview:task.linkState==="review"});
 }
 facts.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 return {facts,tasks};
}
function plannedEntries(db:DatabaseSync,studentId:string,range:ReviewRange,facts:Fact[]){
 const map=new Map<string,SourcePlan>();
 const bySource=new Map<string,Fact[]>();
 for(const fact of facts)if(fact.planning){
  const key=sourceKey(fact.planning);
  bySource.set(key,[...(bySource.get(key)??[]),fact]);
 }
 for(const plan of studentPlanViews(db,studentId)){
  const versions=plan.versions??[];
  for(let day=range.from;day<=range.to;day=shiftDate(day,1)){
   const version=currentPlan(versions,day);
   if(!version)continue;
   for(const entry of version.fields.entries){
    if(!entry.from||entry.from>day||(entry.to||entry.from)<day)continue;
    const ref={planId:plan.id,revision:version.revision,entryId:entry.id};
    const key=sourceKey(ref);
    if(map.has(key))continue;
    const evidence=bySource.get(key)??[];
    map.set(key,{...ref,subject:entry.subject,content:entry.content,from:entry.from,to:entry.to,
      execution:evidence.some(f=>qualify(f.completion))?"recorded":evidence.some(f=>partial(f.completion))?"incomplete":"unrecorded"});
   }
  }
 }
 return [...map.values()];
}
export function readWeekFacts(stores:Stores,studentId:string,range:ReviewRange):WeekFacts{
 const {m1,ops,work}=stores;
 if(!m1.prepare("SELECT 1 FROM students WHERE id=?").get(studentId))return fail("找不到该学生。");
 const start=shanghaiMinute(range.from,"00:00")!,end=shanghaiMinute(shiftDate(range.to,1),"00:00")!;
 const visits=ops.prepare("SELECT id,check_in_at AS checkIn,check_out_at AS checkOut,revision FROM attendance_plans WHERE student_id=? AND check_in_at>=? AND check_in_at<? ORDER BY check_in_at,id").all(studentId,start,end) as unknown as Visit[];
 const {facts,tasks}=recordFacts(stores,studentId,range);
 const pendingTasks=tasks.filter(t=>inRange(t.date,range)&&t.status==="planned")
  .map(({id,subject,date,content,attendanceId,linkState})=>({id,subject,date,content,attendanceId,planningNeedsReview:linkState==="review"}));
 const plans=plannedEntries(m1,studentId,range,facts);
 const version=Number(m1.prepare("PRAGMA user_version").get()?.user_version);
 const scores=readStudentRecords(m1,version,"score",studentId).records
  .filter(record=>inRange(record.fields.takenOn,range)).map(({id,revision,fields})=>({
   id,revision,date:fields.takenOn,subject:fields.subject,title:fields.assessment,score:Number(fields.score),maximum:Number(fields.maximum)
  })).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 const scoreChanges=[...new Set(scores.map(score=>score.subject))].flatMap(subject=>{
  const rows=scores.filter(x=>x.subject===subject),first=rows[0],last=rows.at(-1)!;
  return rows.length>1&&first.date!==last.date?[{subject,from:first.id,to:last.id,
    ratePoints:(last.score/last.maximum-first.score/first.maximum)*100,
    rawDelta:last.maximum===first.maximum?last.score-first.score:null}]:[];
 });
 const tracking=readTracking(m1,work,studentId).history.filter(record=>record.date<=range.to);
 const inPeriod=tracking.filter(record=>inRange(record.date,range)||record.fields.kind==="check"&&inRange(record.fields.due,range));
 const units=[...new Map(inPeriod.slice().reverse().map(record=>[record.id,record])).values()].map(({id,revision,date,fields})=>({id,revision,date,fields}));
 const [from,to]=[range.from,range.to];
 const contacts=m1.prepare("SELECT request_id AS id,reported_on AS date,concern AS text,next_on AS next FROM parent_concerns WHERE student_id=? AND reported_on BETWEEN ? AND ? UNION ALL SELECT f.request_id,f.followed_on,f.note,f.next_on FROM parent_followups f JOIN parent_concerns c ON c.request_id=f.concern_id WHERE c.student_id=? AND f.followed_on BETWEEN ? AND ? ORDER BY date,id").all(studentId,from,to,studentId,from,to) as unknown as Event[];
 const followUps=work.prepare("SELECT id,work_date AS date,title AS text,next_step AS next FROM work_items WHERE student_id=? AND status='open' AND work_date<=? ORDER BY work_date,id").all(studentId,to) as unknown as Event[];
 return {studentId,range,visits,onSiteMinutes:minutes(visits,start,end),visitsWithoutCheckout:visits.filter(v=>v.checkOut===null).length,
  facts,pendingTasks,plans,tracking:units,scores,scoreChanges,contacts,followUps};
}
function notes(raw:unknown):ReviewNotes{
 const row=planObject(raw);
 return {evaluation:planString(row.evaluation,1500),issues:planString(row.issues,1500),next:planString(row.next,1500),parent:planString(row.parent,1500)};
}
function decode(row:Record<string,unknown>):ReviewSnapshot{
 const revision=Number(row.revision);
 return {studentId:String(row.student_id),range:{from:String(row.from_on),to:String(row.to_on)},requestId:String(row.request_id),
  revision,expectedRevision:revision-1,savedAt:Number(row.saved_at),state:row.state as ReviewSave["state"],sourceDigest:String(row.source_digest),
  facts:JSON.parse(String(row.snapshot_json)) as WeekFacts,notes:JSON.parse(String(row.notes_json)) as ReviewNotes};
}
function history(m1:DatabaseSync,studentId:string,range:ReviewRange){
 return m1.prepare("SELECT * FROM learning_week_reviews WHERE student_id=? AND from_on=? AND to_on=? ORDER BY revision DESC").all(studentId,range.from,range.to).map(decode);
}
export function readReview(stores:Stores,id:unknown,raw:unknown):ReviewView{
 const studentId=planId(id),range=reviewRange(raw),facts=readWeekFacts(stores,studentId,range);
 const sourceDigest=fingerprint(facts),saved=history(stores.m1,studentId,range);
 return {facts,sourceDigest,outdated:Boolean(saved[0]&&saved[0].sourceDigest!==sourceDigest),history:saved};
}
export function saveReview(stores:Stores,raw:unknown,now=Date.now()):ReviewSnapshot{
 const row=planObject(raw),studentId=planId(row.studentId),range=reviewRange(row.range),requestId=planId(row.requestId);
 const expectedRevision=row.expectedRevision,state=row.state,sourceDigest=row.sourceDigest,words=notes(row.notes);
 if(typeof expectedRevision!=="number"||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER||
  (state!=="draft"&&state!=="confirmed")||typeof sourceDigest!=="string"||!/^[a-f0-9]{64}$/.test(sourceDigest))return fail("请选择有效复盘版本。");
 const receipt=stores.m1.prepare("SELECT * FROM learning_week_reviews WHERE request_id=?").get(requestId);
 if(receipt){
  const saved=decode(receipt);
  if(saved.studentId!==studentId||saved.range.from!==range.from||saved.range.to!==range.to||saved.expectedRevision!==expectedRevision||
   saved.state!==state||saved.sourceDigest!==sourceDigest||JSON.stringify(saved.notes)!==JSON.stringify(words))return conflict("保存编号已用于其他复盘。");
  return saved;
 }
 const view=readReview(stores,studentId,range),latest=view.history[0];
 if((latest?.revision??0)!==expectedRevision||view.sourceDigest!==sourceDigest)return conflict("事实来源或复盘版本已变化，请重新核对当前材料。");
 const snapshot=JSON.stringify(view.facts);
 if(Buffer.byteLength(snapshot)>192*1024)return fail("本次复盘范围内事实过多，请缩短日期范围后重新核对。");
 const revision=expectedRevision+1;
 stores.m1.prepare("INSERT INTO learning_week_reviews VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(studentId,range.from,range.to,revision,requestId,now,state,sourceDigest,snapshot,JSON.stringify(words));
 return {studentId,range,requestId,expectedRevision,revision,state,sourceDigest,notes:words,savedAt:now,facts:JSON.parse(snapshot) as WeekFacts};
}
export function verifyReviewSnapshots(m1:DatabaseSync){
 let before="",revision=0;
 for(const row of m1.prepare("SELECT * FROM learning_week_reviews ORDER BY student_id,from_on,to_on,revision").iterate()){
  const saved=decode(row),range=reviewRange(saved.range),studentId=planId(saved.studentId);
  planId(saved.requestId);
  const key=[studentId,range.from,range.to].join("/");
  if(key!==before){before=key;revision=0;}
  if(saved.revision!==++revision||saved.facts.studentId!==studentId||saved.facts.range.from!==range.from||saved.facts.range.to!==range.to||
    !Number.isSafeInteger(saved.savedAt)||saved.savedAt<=0||fingerprint(saved.facts)!==saved.sourceDigest||
    JSON.stringify(notes(saved.notes))!==row.notes_json)return fail("每周复盘历史快照校验失败。");
 }
}
