import type { DatabaseSync } from "node:sqlite";
import type { Student } from "./contracts";
import { mondayOf, shanghaiMinute, shiftDate } from "./schedule-calendar";
import { currentPlan, studentPlanViews } from "./study-plan-versions";
import { listPlanTasks } from "./study-plan-links";
import { WorkspaceFault } from "./workspace-fault";
import type { PlanBoardEntry,PlanBoardRow } from "./study-plan-model";

export function readPlanBoard(db:DatabaseSync,ops:DatabaseSync,students:Student[],raw:unknown){
 if(typeof raw!=="string"||shanghaiMinute(raw,"00:00")===null)throw new WorkspaceFault("invalid","请选择有效的总览日期。");
 const date=raw,monday=mondayOf(date),weekEnd=shiftDate(monday,6), month=date.slice(0,7)+"-01";
 let monthEnd=month;
 while(shiftDate(monthEnd,1).slice(0,7)===date.slice(0,7))monthEnd=shiftDate(monthEnd,1);
 function range(studentId:string,plans:ReturnType<typeof studentPlanViews>,tasks:ReturnType<typeof listPlanTasks>,from:string,to:string){
  const list=new Map<string,PlanBoardEntry>();
  for(const plan of plans){
   for(let day=from;day<=to;day=shiftDate(day,1)){
    const version=currentPlan(plan.versions??[],day);
    if(!version)continue;
    for(const item of version.fields.entries){
     if(!item.from||item.from>day||(item.to||item.from)<day)continue;
     const key=[plan.id,version.revision,item.id].join("/");
     if(list.has(key))continue;
     const actual=tasks.filter(row=>row.date>=from&&row.date<=to&&row.link?.planId===plan.id&&
       row.link?.revision===version.revision&&row.link?.entryId===item.id);
     list.set(key,{key,studentId,planId:plan.id,planTitle:version.fields.title,revision:version.revision,entry:item,actual});
    }
   }
  }
  return [...list.values()].sort((a,b)=>a.entry.from.localeCompare(b.entry.from)||a.key.localeCompare(b.key));
 }
 const rows:PlanBoardRow[]=students.map(student=>{
  const plans=studentPlanViews(db,student.id);
  const tasks=plans.length?listPlanTasks(db,ops,student.id).filter(row=>row.link):[];
  const active=plans.flatMap(plan=>{const version=currentPlan(plan.versions??[],date);return version?[{plan,version}]:[];});
  const today=active.map(({plan,version})=>({id:plan.id,title:version.fields.title,revision:version.revision,subjects:version.fields.subjects,
    undated:version.fields.entries.filter(entry=>!entry.from).length,unassigned:version.fields.entries.filter(entry=>!entry.subject).length}));
  const pending=plans.filter(plan=>!active.some(record=>record.plan.id===plan.id)&&plan.versions?.[0]?.state!=="history");
  const status=!plans.length?"missing":active.length?"active":pending.length?"review":"history";
  const lookup=new Set(plans.flatMap(plan=>(plan.versions?.[0]?.fields??plan.initial).subjects));
  return {studentId:student.id,alias:student.alias,grade:student.grade,lifecycle:student.lifecycleStatus??"active",status,
    imported:plans.filter(plan=>plan.source).length,plans:plans.length,subjects:[...lookup],today,
    pending:pending.map(plan=>({id:plan.id,title:plan.initial.title})),
    week:range(student.id,plans,tasks,monday,weekEnd),month:range(student.id,plans,tasks,month,monthEnd)};
 });
 const order={active:0,paused:1,archived:2};
 rows.sort((a,b)=>order[a.lifecycle]-order[b.lifecycle]||a.alias.localeCompare(b.alias,"zh-CN")||a.studentId.localeCompare(b.studentId));
 return {date,weekFrom:monday,weekTo:weekEnd,monthFrom:month,monthTo:monthEnd,rows};
}
