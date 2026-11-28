import {useCallback,useEffect,useState} from "react";
import type {WorkspaceApi} from "./contracts";
import type {WeeklyManagementQuery,WeeklyManagementRow,WeeklyManagementView} from "./learning-week-overview";
import {WeeklyReviewPanel} from "./WeeklyReviewPanel";
import {mondayOf,shanghaiParts,shiftDate} from "./schedule-calendar";

export type LearningJump={kind:"student"|"history"|"plan"|"score"|"unit"|"task"|"visit"|"work";id?:string;attendanceId?:string|null;revision?:number};
const life={active:"正常跟进",paused:"暂停学习",archived:"已归档",all:"全部"};
const statuses={all:"全部",missing:"到课待登记",unfinished:"未完成或跳过",checks:"待检测或复测",sources:"规划来源待核对",review:"复盘待处理","follow-up":"有跟进事项"};
const reviewLabels={missing:"尚未建立",draft:"草稿",confirmed:"已确认"};
const thisMonday=()=>mondayOf(shanghaiParts(Date.now()).date);
const week=(monday:string)=>({from:monday,to:shiftDate(monday,6)});

export function WeeklyLearningManagement({api,refresh,visible,onJump,onDraft}:{api:WorkspaceApi;refresh:number;visible:boolean;
 onJump:(studentId:string,target:LearningJump,trigger:HTMLButtonElement)=>void;onDraft:(dirty:boolean,busy:boolean)=>void}){
 const [query,setQuery]=useState<WeeklyManagementQuery>(()=>({range:week(thisMonday()),subject:"",lifecycle:"active",status:"all"}));
 const [loaded,setLoaded]=useState<{key:string;view:WeeklyManagementView}>(),[error,setError]=useState(""),[reload,setReload]=useState(0);
 const [selected,setSelected]=useState<WeeklyManagementRow>(),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false);
 const key=JSON.stringify(query);
 const activity=useCallback((dirty:boolean,busy:boolean)=>{setDirty(dirty);setBusy(busy);onDraft(dirty,busy);},[onDraft]);
 useEffect(()=>{
  if(!visible||!query.range.from||!query.range.to)return;
  let alive=true;setError("");
  api.weeklyLearningManagement(query).then(result=>{if(alive){if(result.ok)setLoaded({key,view:result.value});else setError(result.message);}})
    .catch(()=>{if(alive)setError("无法读取学习管理总览。");});
  return()=>{alive=false;};
 },[api,visible,key,query,reload,refresh]);
 const view=loaded?.key===key?loaded.view:undefined;
 function change(next:Partial<WeeklyManagementQuery>){
  if(busy||dirty&&!window.confirm("更改范围后将关闭当前未保存的复盘。"))return;
  setSelected(undefined);setQuery(previous=>({...previous,...next}));
 }
 function choose(row?:WeeklyManagementRow){
  if(busy||dirty&&!window.confirm("切换复盘学生会放弃当前未保存的评价。"))return;
  setSelected(row);
  if(row)requestAnimationFrame(()=>document.querySelector(".weekly-management-editor")?.scrollIntoView({block:"start"}));
 }
 return <section className="schedule-page weekly-management" aria-label="学习管理总览">
  <header className="schedule-heading"><div><h1>学习管理总览</h1><p className="muted">按上海日期查看实际到课、学习登记及每周复盘。</p></div>
   <button type="button" className="secondary" onClick={()=>setReload(v=>v+1)}>刷新总览</button></header>
  <div className="schedule-buttons">
   <button type="button" className="secondary" disabled={!query.range.from||busy} onClick={()=>change({range:week(shiftDate(mondayOf(query.range.from),-7))})}>上一周</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>change({range:week(thisMonday())})}>本周</button>
   <button type="button" className="secondary" disabled={!query.range.from||busy} onClick={()=>change({range:week(shiftDate(mondayOf(query.range.from),7))})}>下一周</button>
  </div>
  <div className="schedule-fields panel">
   <label>复盘起日<input type="date" value={query.range.from} onChange={event=>change({range:{...query.range,from:event.target.value}})}/></label>
   <label>复盘止日<input type="date" value={query.range.to} onChange={event=>change({range:{...query.range,to:event.target.value}})}/></label>
   <label>学科<select value={query.subject} onChange={event=>change({subject:event.target.value})}><option value="">全部学科</option>
    {[...new Set([...(loaded?.view.subjects??[]),...(query.subject?[query.subject]:[])])].map(subject=><option key={subject}>{subject}</option>)}</select></label>
   <label>跟进状态<select value={query.lifecycle} onChange={event=>change({lifecycle:event.target.value as WeeklyManagementQuery["lifecycle"]})}>
    {Object.entries(life).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>记录状态<select value={query.status} onChange={event=>change({status:event.target.value as WeeklyManagementQuery["status"]})}>
    {Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
  </div>
  {error&&<p role="alert">{error}</p>}
  {!error&&!view&&<p role="status">{query.range.from&&query.range.to?"正在读取…":"请选择完整复盘日期。"}</p>}
  {view&&<>
   <p className="muted">{view.rows.length} 名学生 · 实际到课 {view.attendanceStudents} 人 / {view.visits} 人次。到课以签到为准，登记按实际到课身份核对。</p>
   {view.rows.length===0&&<p>当前范围没有符合条件的学生。</p>}
   <ul className="study-board-rows">{view.rows.map(row=><li className="panel" key={row.studentId}>
    <div className="schedule-form-heading"><h2><button type="button" className="schedule-profile-link" onClick={event=>onJump(row.studentId,{kind:"student"},event.currentTarget)}>{row.alias}</button></h2>
     <span>{row.grade} · {life[row.lifecycle]}</span></div>
    <p>到课 {row.recordedVisits}/{row.visits} 次已关联学习事实 · 学习记录 {row.facts} 条 · 规划 {row.planned} 项 · 有执行记录 {row.executed} 项 · 有明确完成记录 {row.completed} 项</p>
    <div className="schedule-buttons">
     <button type="button" className="secondary" onClick={()=>choose(row)}>复盘 · {reviewLabels[row.review.state]}{row.review.outdated?" · 待更新":""}</button>
     {row.planRef&&<button type="button" className="secondary" onClick={event=>onJump(row.studentId,{kind:"plan",id:row.planRef!.planId,revision:row.planRef!.revision},event.currentTarget)}>查看规划版本</button>}
     {row.scoreId&&<button type="button" className="secondary" onClick={event=>onJump(row.studentId,{kind:"score",id:row.scoreId},event.currentTarget)}>查看实际成绩</button>}
    </div>
    {Object.entries({missing:"到课待登记",unfinished:"未完成或跳过",checks:"待检测与复测",sources:"规划来源待核对",followUps:"后续跟进"}).map(([name,label])=>{
     const items=row[name as "missing"|"unfinished"|"checks"|"sources"|"followUps"];
     return items.length>0&&<details key={name}><summary>{label}（{items.length}）</summary><ul>{items.map((item,index)=><li key={item.id+"-"+index}>
      <button type="button" className="schedule-profile-link" onClick={event=>onJump(row.studentId,item,event.currentTarget)}>{item.date&&item.date+" · "}{item.text}</button>
     </li>)}</ul></details>;
    })}
   </li>)}</ul>
  </>}
  {selected&&<div className="weekly-management-editor">
   <div className="schedule-form-heading"><h2>{selected.alias} · 复盘</h2><button type="button" className="secondary" disabled={busy} onClick={()=>choose()}>关闭学生复盘</button></div>
   <WeeklyReviewPanel key={selected.studentId+"/"+key} api={api} studentId={selected.studentId} initialRange={query.range} refresh={refresh}
    onActivity={activity} onSaved={()=>setReload(n=>n+1)}/>
  </div>}
 </section>;
}
