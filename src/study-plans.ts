import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { attachmentBudget, documentLimit, planDate, planTextLimit, planUuid, type PlanDraft, type PlanEntry, type PlanRecord, type PlanSourceCell } from "./study-plan-model";
import { WorkspaceFault } from "./workspace-fault";

export const studyPlanSchema = [
  ["study_plan_sources","table",`CREATE TABLE study_plan_sources (
    sha256 TEXT PRIMARY KEY, filename TEXT NOT NULL, byte_length INTEGER NOT NULL,
    imported_at INTEGER NOT NULL, cells_json TEXT NOT NULL, document_bytes BLOB NOT NULL
  ) STRICT`],
  ["study_plans","table",`CREATE TABLE study_plans (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id),
    source_sha256 TEXT UNIQUE REFERENCES study_plan_sources(sha256),
    initial_json TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT`],
  ["study_plan_student","index","CREATE INDEX study_plan_student ON study_plans(student_id,created_at,id)"],
] as const;
export const studyPlanTables = ["study_plan_sources","study_plans"] as const;
export const digestDocument = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invalid=(message:string):never=>{throw new WorkspaceFault("invalid",message);};
const conflict=(message:string):never=>{throw new WorkspaceFault("conflict",message);};
export function planObject(value:unknown):Record<string, unknown>{
  if(!value || typeof value!=="object" || Array.isArray(value))invalid("规划字段无效。");
  return value as Record<string,unknown>;
}
export function planId(id:unknown):string{
  if(typeof id!=="string"||!planUuid.test(id))return invalid("规划身份无效。");
  return id;
}
export function planString(value:unknown,max:number,required=false):string{
  if(typeof value!=="string"||value.length>max||value.includes("\0")||(required&&!value.trim()))return invalid("规划字段为空或超过长度限制。");
  return value.trim();
}
const reference=/^(?:p[1-9]\d*|t[1-9]\d*:r[1-9]\d*:c[1-9]\d*)$/;
export function validPlan(value:unknown):PlanDraft{
  const x=planObject(value);
  if(!Array.isArray(x.subjects)||!x.subjects.length||x.subjects.length>20||!Array.isArray(x.entries)||x.entries.length>300)return invalid("请确认学科及周任务数量。");
  const subjects=[...new Set(x.subjects.map(v=>planString(v,60,true)))];
  const ids=new Set<string>();
  const entries=x.entries.map((item):PlanEntry=>{
    const e=planObject(item), id=planId(e.id), subject=planString(e.subject,60);
    const kind=e.kind;
    if(ids.has(id)||subject&&!subjects.includes(subject)||kind!=="month"&&kind!=="week"&&kind!=="note")return invalid("任务身份、学科或类型无效。");
    ids.add(id);
    const from=planString(e.from,10),to=planString(e.to,10);
    if(!planDate(from)||!planDate(to)||to&&!from||from&&to&&to<from)return invalid("执行日期范围无效。");
    if(!Array.isArray(e.sources)||e.sources.length>20||e.sources.some(src=>typeof src!=="string"||!reference.test(src)))return invalid("原文位置无效。");
    return {id,subject,month:planString(e.month,60),week:planString(e.week,60),kind,
      content:planString(e.content,12000,true),estimated:planString(e.estimated,160),from,to,sources:[...new Set(e.sources as string[])]};
  });
  const result:PlanDraft={title:planString(x.title,160,true),term:planString(x.term,180),learner:planString(x.learner,120),
    grade:planString(x.grade,80),subjects,context:planString(x.context,15000),goals:planString(x.goals,15000),
    habits:planString(x.habits,15000),notes:planString(x.notes,15000),entries};
  if(Buffer.byteLength(JSON.stringify(result),"utf8")>planTextLimit)invalid("结构化规划超过单份存储上限。");
  return result;
}
interface DocumentInput { filename:string; cells:PlanSourceCell[]; bytes:Buffer; sha256:string }
function checkCells(value:unknown):PlanSourceCell[]{
  if(!Array.isArray(value)||value.length>2000||Buffer.byteLength(JSON.stringify(value),"utf8")>planTextLimit)return invalid("原文超过解析上限。");
  const refs=new Set<string>();
  for(const item of value){
    const c=planObject(item);
    if(typeof c.ref!=="string"||!reference.test(c.ref)||refs.has(c.ref)||typeof c.text!=="string"||
      c.span!==undefined&&(!Number.isInteger(c.span)||Number(c.span)<1||Number(c.span)>128)||
      c.merge!==undefined&&c.merge!=="start"&&c.merge!=="continue")return invalid("原文引用无效。");
    refs.add(c.ref);
  }
  return value;
}
function checkReferences(fields:PlanDraft,cells:PlanSourceCell[]){
  const refs=new Set(cells.map(cell=>cell.ref));
  if(fields.entries.some(entry=>entry.sources.some(id=>!refs.has(id))))invalid("任务引用了原件中不存在的位置。");
}
const checkName=(name:unknown)=>{const title=planString(name,180,true);
  if(/[<>:"/\\|?*\x00-\x1f]/u.test(title)||!/\.docx?$/i.test(title))invalid("Word 文件名无效。");
  return title;
};
function documentRecord(row:Record<string,unknown>){
  return {sha256:String(row.sha256),filename:String(row.filename),byteLength:Number(row.byte_length),importedAt:Number(row.imported_at)};
}
export function planExists(db:DatabaseSync,hash:string):boolean{
  return Boolean(db.prepare("SELECT 1 FROM study_plan_sources WHERE sha256=?").get(hash));
}
export function listStudyPlans(db:DatabaseSync,studentId:string):PlanRecord[]{
  return db.prepare(`SELECT p.id,p.student_id,p.created_at,p.initial_json,s.sha256,s.filename,s.byte_length,s.imported_at
    FROM study_plans p LEFT JOIN study_plan_sources s ON p.source_sha256=s.sha256 WHERE p.student_id=? ORDER BY p.created_at DESC,p.id`)
    .all(planId(studentId)).map(row=>({id:String(row.id),studentId:String(row.student_id),createdAt:Number(row.created_at),
    initial:validPlan(JSON.parse(String(row.initial_json))),source:row.sha256?documentRecord(row):null}));
}
export function studyPlanSource(db:DatabaseSync,studentId:string,id:string){
  const row=db.prepare(`SELECT s.* FROM study_plan_sources s JOIN study_plans p ON p.source_sha256=s.sha256
    WHERE p.student_id=? AND p.id=?`).get(planId(studentId),planId(id));
  if(!row||!(row.document_bytes instanceof Uint8Array)||digestDocument(row.document_bytes)!==row.sha256)return invalid("找不到已校验的原始 Word 文件。");
  return {metadata:documentRecord(row),cells:checkCells(JSON.parse(String(row.cells_json))),bytes:Buffer.from(row.document_bytes)};
}
export function checkPlanBudget(db:DatabaseSync, extra:number){
  const version=Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const revisionBytes=version>=12?" +(SELECT coalesce(sum(length(cast(fields_json AS BLOB))+length(cast(reason AS BLOB))),0) FROM study_plan_versions)":"";
  const used=Number(db.prepare(`SELECT (SELECT coalesce(sum(byte_length+length(cast(cells_json AS BLOB))),0) FROM study_plan_sources)
    +(SELECT coalesce(sum(length(cast(initial_json AS BLOB))),0) FROM study_plans)`+revisionBytes+" AS n").get()?.n??0);
  const pageBytes=Number(db.prepare("PRAGMA page_count").get()?.page_count)*Number(db.prepare("PRAGMA page_size").get()?.page_size);
  if(used+extra>attachmentBudget||extra>0&&pageBytes+extra+1024*1024>32*1024*1024)invalid("规划存储预算不足。现有数据仍可完整备份。");
}
export function addStudyPlan(db:DatabaseSync, studentId:string, raw:unknown, source:DocumentInput, id: string = randomUUID()):{id:string;duplicate:boolean}{
  planId(studentId);planId(id);
  if(!db.prepare("SELECT 1 FROM students WHERE id=?").get(studentId))invalid("请选择现有学生并确认身份。");
  const fields=validPlan(raw), filename=checkName(source.filename), cells=checkCells(source.cells);
  checkReferences(fields,cells);
  if(!source.bytes.length||source.bytes.length>documentLimit||digestDocument(source.bytes)!==source.sha256)invalid("原件摘要或长度不一致。");
  const prior=db.prepare("SELECT id,student_id FROM study_plans WHERE source_sha256=?").get(source.sha256);
  if(prior){if(prior.student_id!==studentId)conflict("原件已与另一份学生档案关联，请人工核对。");return {id:String(prior.id),duplicate:true};}
  const cellsJson=JSON.stringify(cells), payload=JSON.stringify(fields), now=Date.now();
  checkPlanBudget(db,source.bytes.length+Buffer.byteLength(cellsJson)+Buffer.byteLength(payload));
  db.exec("BEGIN IMMEDIATE");
  try{
    db.prepare("INSERT INTO study_plan_sources VALUES(?,?,?,?,?,?)").run(source.sha256,filename,source.bytes.length,now,cellsJson,source.bytes);
    db.prepare("INSERT INTO study_plans VALUES(?,?,?,?,?)").run(id,studentId,source.sha256,payload,now);
    db.exec("COMMIT");
    return {id,duplicate:false};
  }catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}
}
export function verifyStudyPlans(db:DatabaseSync){
  const documents=new Map<string,PlanSourceCell[]>();
  let budget=0;
  for(const row of db.prepare("SELECT * FROM study_plan_sources").iterate()){
    checkName(row.filename);
    if(!(row.document_bytes instanceof Uint8Array)||row.document_bytes.byteLength!==row.byte_length||
      row.document_bytes.byteLength>documentLimit||digestDocument(row.document_bytes)!==row.sha256||
      typeof row.imported_at!=="number"||!Number.isSafeInteger(row.imported_at)||row.imported_at<=0)invalid("规划原件校验失败。");
    documents.set(String(row.sha256),checkCells(JSON.parse(String(row.cells_json))));
    budget+=Number(row.byte_length)+Buffer.byteLength(String(row.cells_json));
  }
  const referenced=new Set<string>();
  for(const row of db.prepare("SELECT * FROM study_plans").iterate()){
    planId(row.id);planId(row.student_id);
    if(typeof row.created_at!=="number"||!Number.isSafeInteger(row.created_at)||row.created_at<=0)invalid("规划的创建时间无效。");
    const serialized=String(row.initial_json), fields=validPlan(JSON.parse(serialized));
    if(JSON.stringify(fields)!==serialized)invalid("初始规划结构无效。");
    const cells=documents.get(String(row.source_sha256));
    if(row.source_sha256!==null&&!cells)invalid("规划原件缺失。");
    checkReferences(fields,cells??[]);
    if(cells)referenced.add(String(row.source_sha256));
    budget+=Buffer.byteLength(serialized);
  }
  if(referenced.size!==documents.size||budget>attachmentBudget)invalid("规划原件关联或备份预算无效。");
}
