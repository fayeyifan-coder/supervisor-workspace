import { useEffect,useState } from "react";
import type { Student, WorkspaceApi } from "./contracts";
import { emptyPlan, type PlanDraft,type PlanRecord,type PlanSourceCell,type PlanTask,type PlanVersionInput } from "./study-plan-model";
import { shanghaiParts } from "./schedule-calendar";
import { StudyPlanFields } from "./StudyPlanFields";

const displayStatus={active:"执行中",draft:"待核对",history:"历史规划"} as const;
const kinds={month:"月度目标",week:"每周任务",note:"补充事项"} as const;
type Draft={kind:"manual";id:string;fields:PlanDraft}|{kind:"version";input:PlanVersionInput};

export function StudyPlanStudentPanel({api,student,refresh,onActivity,revisionsEnabled,focusPlan}:{api:WorkspaceApi;student:Student;refresh:number;revisionsEnabled:boolean;focusPlan?:{id?:string;revision?:number;sequence:number};
  onActivity:(dirty:boolean,busy:boolean)=>void}){
 const [plans,setPlans]=useState<PlanRecord[]>();
 const [generation,setGeneration]=useState(0);
 const [selected,setSelected]=useState("");
 const [basis,setBasis]=useState(0);
 const [draft,setDraft]=useState<Draft>();
 const [sources,setSources]=useState<{id:string;cells:PlanSourceCell[]}>();
 const [subject,setSubject]=useState("");
 const [month,setMonth]=useState("");
 const [week,setWeek]=useState("");
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState("");
 const [tasks,setTasks]=useState<PlanTask[]>();
 const [entryChoice,setEntryChoice]=useState("");
 const [taskChoice,setTaskChoice]=useState("");
 const id=student.id;
 const date=shanghaiParts(Date.now()).date;
 useEffect(()=>{
  if(focusPlan){setSelected(focusPlan.id??"");setBasis(focusPlan.revision??0);setSubject("");setMonth("");setWeek("");}
 },[focusPlan]);
 useEffect(()=>{
  let active=true;
  api.studyPlans(id).then(result=>{
   if(!active)return;
   if(result.ok&&result.value.every(item=>item.studentId===id))setPlans(result.value);
   else setStatus(result.ok?"读取身份与当前学生不一致。":result.message);
  }).catch(()=>{if(active)setStatus("学习规划读取失败。");});
  return()=>{active=false;};
 },[api,id,refresh,generation]);
 useEffect(()=>{
  if(!revisionsEnabled)return;
  let alive=true;
  api.planTasks(id).then(result=>{if(!alive)return;if(result.ok)setTasks(result.value);else setStatus(result.message);}).catch(()=>{
   if(alive)setStatus("无法读取现有学习任务。");
  });
  return()=>{alive=false;};
 },[api,id,revisionsEnabled,generation,refresh]);
 useEffect(()=>{onActivity(Boolean(draft),busy);return()=>onActivity(false,false);},[draft,busy,onActivity]);
 const current=plans?.find(plan=>plan.id===selected)??plans?.[0];
 const latest=current?.versions?.[0];
 const effective=current?.versions?.find(row=>row.effectiveOn<=date);
 const active=effective?.state==="active"&&effective.startsOn<=date&&(!effective.endsOn||effective.endsOn>=date)?effective:undefined;
 const visibleVersion=basis>0?current?.versions?.find(row=>row.revision===basis):basis===0?active??effective??latest:undefined;
 const shown=visibleVersion?.fields??current?.initial;
 const linked=tasks?.filter(task=>task.link?.planId===current?.id&&task.link?.revision===visibleVersion?.revision)??[];
 const reviewCount=tasks?.filter(task=>task.link?.planId===current?.id&&task.linkState==="review").length??0;
 const linkLabels={planned:"计划关联",historical:"历史关联",review:"来源待核对"} as const;
 const displayed=shown?.entries.filter(row=>(!subject||row.subject===subject)&&(!month||row.month===month)&&(!week||row.week===week))??[];
 const filter=(value:string,set:(value:string)=>void,items:string[],label:string)=><label>{label}<select value={value} onChange={event=>set(event.target.value)}>
  <option value="">全部</option>{[...new Set(items.filter(Boolean))].map(item=><option key={item}>{item}</option>)}
 </select></label>;
 function startVersion(){
  if(!current)return;
  setDraft({kind:"version",input:{studentId:id,planId:current.id,requestId:crypto.randomUUID(),expectedRevision:latest?.revision??0,
   effectiveOn:date,startsOn:latest?.startsOn??"",endsOn:latest?.endsOn??"",state:latest?.state??"active",reason:"",
   fields:revisionsEnabled?(shown??current.initial):latest?.fields??current.initial}});
 }
 async function save(){
  if(!draft||busy)return;
  setBusy(true);setStatus("");
  try{
   const reply=draft.kind==="manual"?await api.createManualPlan({studentId:id,id:draft.id,fields:{
     ...draft.fields,subjects:draft.fields.subjects.map(x=>x.trim()).filter(Boolean)}}):await api.savePlanVersion({...draft.input,fields:{...draft.input.fields,
      subjects:draft.input.fields.subjects.map(x=>x.trim()).filter(Boolean)}});
   if(!reply.ok){setStatus(reply.message);return;}
   if(draft.kind==="manual")setSelected(draft.id);
   setDraft(undefined);setStatus("已保存。");setGeneration(n=>n+1);
  }catch{setStatus("无法确认保存。请保留当前页面并重试相同输入。");}finally{setBusy(false);}
 }
 async function source(download:boolean){
  if(!current||!current.source||busy)return;
  setBusy(true);setStatus("");
  try{
   if(download){
    const reply=await api.exportStudyPlanSource(id,current.id);
    setStatus(reply.ok?(reply.value?"原件副本已保存至 "+reply.value:"已取消保存原件副本。"):reply.message);
   }else{
    const reply=await api.studyPlanSource(id,current.id);
    if(reply.ok)setSources({id:current.id,cells:reply.value.cells});else setStatus(reply.message);
   }
  }catch{setStatus("无法读取或保存原件。");}finally{setBusy(false);}
 }
 async function linkTask(){
  if(busy||!current||!visibleVersion||!entryChoice||!taskChoice)return;
  setBusy(true);setStatus("");
  try{
   const reply=await api.linkPlanTask({studentId:id,planId:current.id,revision:visibleVersion.revision,entryId:entryChoice,taskId:taskChoice});
   if(!reply.ok)setStatus(reply.message);
   else {setTaskChoice("");setEntryChoice("");setGeneration(n=>n+1);setStatus("已确认任务与所选规划版本的关联。");}
  }catch{setStatus("关联结果待核对，可以重试同一任务。");}finally{setBusy(false);}
 }
 function patch(fields:Partial<PlanVersionInput>){
  setDraft(old=>old?.kind==="version"?{...old,input:{...old.input,...fields}}:old);
 }
 return <section className="panel" aria-label="学生学习规划" data-profile-switch-draft={draft||busy?"":undefined}>
  <div className="schedule-form-heading"><h2>学习规划</h2><button type="button" className="secondary" disabled={busy||Boolean(draft)}
   onClick={()=>setDraft({kind:"manual",id:crypto.randomUUID(),fields:emptyPlan()})}>手工新建规划</button></div>
  {status&&<p role="status">{status}</p>}
  {!plans?<p role="status">正在读取学习规划… <button type="button" onClick={()=>setGeneration(n=>n+1)}>重试</button></p>:
   plans.length===0?<p className="muted">尚未建立学习规划。可导入 Word，或在此手工补充。</p>:
   <ul className="student-source-list">{plans.map(plan=>{
    const v=plan.versions?.find(row=>row.effectiveOn<=date);
    const live=v?.state==="active"&&v.startsOn<=date&&(!v.endsOn||v.endsOn>=date);
    return <li key={plan.id}><button type="button" className="schedule-profile-link" aria-pressed={current?.id===plan.id}
     disabled={busy||Boolean(draft)} onClick={()=>{setSelected(plan.id);setBasis(0);setSubject("");setMonth("");setWeek("");setSources(undefined);setTaskChoice("");setEntryChoice("");}}>
     {plan.initial.title}</button><p className="muted">{plan.initial.subjects.join("、")} · {live?"执行中":v?.state==="history"?"历史规划":"待生效或待核对"}
      {v&&" · "+(v.startsOn||"起日待确认")+" 至 "+(v.endsOn||"未设止日")}</p></li>;
   })}</ul>}
  {current&&shown&&<div>
   <div className="schedule-buttons">
    <button type="button" className="secondary" aria-pressed={basis===0} onClick={()=>setBasis(0)}>执行规划</button>
    <button type="button" className="secondary" aria-pressed={basis===-1} onClick={()=>setBasis(-1)}>初始规划</button>
    <button type="button" className="secondary" disabled={busy||Boolean(draft)} onClick={startVersion}>{revisionsEnabled?basis>0?"以此版本建立修订":"新建执行修订":"设置执行期间"}</button>
   </div>
   <p className="muted">{active?"当前执行版本 "+active.revision+" · "+active.startsOn+" 至 "+(active.endsOn||"未设止日"):"当前未启用执行规划。"}
    {shown.term&&" · 原文 "+shown.term}</p>
   {current.versions?.length?<details><summary>历史执行版本（{current.versions.length}）</summary><ol>{current.versions.map(v=>
    <li key={v.revision}><button type="button" className="schedule-profile-link" aria-pressed={basis===v.revision} onClick={()=>setBasis(v.revision)}>
      第 {v.revision} 版 · {v.effectiveOn} · {displayStatus[v.state]}</button> · {v.reason}</li>)}</ol></details>:null}
   {current.source&&<div>
    <p className="muted">原始 Word：{current.source.filename} · {current.source.byteLength} 字节 · {new Date(current.source.importedAt).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"})}</p>
    <div className="schedule-buttons">
     <button type="button" className="secondary" disabled={busy} onClick={()=>void source(false)}>查看原文与来源</button>
     <button type="button" className="secondary" disabled={busy} onClick={()=>void source(true)}>保存 Word 原件副本</button>
    </div>
    {sources?.id===current.id&&<details open><summary>原文位置 · {current.source.sha256}</summary>
     <dl className="study-plan-original">{sources.cells.filter(cell=>cell.text.trim()).map(cell=><div key={cell.ref}><dt>{cell.ref}</dt><dd>{cell.text}</dd></div>)}</dl>
    </details>}
   </div>}
   {(["context","goals","habits","notes"] as const).map((key,index)=>shown[key]&&<details key={key}><summary>{["学情与依据","阶段及半年目标","习惯与干预","规划备注"][index]}</summary>
    <p className="study-plan-text">{shown[key]}</p></details>)}
   {reviewCount>0&&<p className="notice pending" role="status">{reviewCount} 项任务的规划来源待重新核对。可以选择有效日期及同学科条目重新确认。</p>}
   {revisionsEnabled&&visibleVersion&&<details>
    <summary>实际学习任务关联（{linked.length}）</summary>
    <p className="muted">开始前建立计划关联。学习开始后保留已确认的历史来源。来源待核对的任务不计作规划执行依据。</p>
    {linked.length>0?<ul>{linked.map(task=><li key={task.id}>{task.date} · {task.content} ·
      {({planned:"待开始",in_progress:"进行中",done:"已完成",skipped:"已跳过"})[task.status]} · 规划第 {task.link?.revision} 版 · {task.linkState&&linkLabels[task.linkState]}
    </li>)}</ul>:<p className="muted">当前版本尚未关联实际任务。</p>}
    <div className="schedule-fields">
      <label>规划条目<select value={entryChoice} disabled={busy} onChange={event=>setEntryChoice(event.target.value)}>
       <option value="">请选择</option>{visibleVersion.fields.entries.map(item=><option key={item.id} value={item.id}>{item.week||item.month||"日期待确认"} · {item.content}</option>)}
      </select></label>
      <label>现有学习任务<select value={taskChoice} disabled={busy} onChange={event=>setTaskChoice(event.target.value)}>
       <option value="">请选择</option>{tasks?.filter(task=>task.linkable).map(task=><option key={task.id} value={task.id}>{task.date} · {task.subject||"学科未登记"} · {task.content}{task.linkState==="review"?" · 来源待核对":""}</option>)}
      </select></label>
    </div>
    <button type="button" className="secondary" disabled={busy||!taskChoice||!visibleVersion.fields.entries.some(item=>item.id===entryChoice)}
      onClick={()=>void linkTask()}>确认关联至第 {visibleVersion.revision} 版</button>
   </details>}
   <div className="schedule-fields">
    {filter(subject,setSubject,shown.subjects,"按学科")}
    {filter(month,setMonth,shown.entries.map(row=>row.month),"按原始月份")}
    {filter(week,setWeek,shown.entries.map(row=>row.week),"按原始周次")}
   </div>
   {displayed.length?<ol className="student-source-list">{displayed.map(row=><li key={row.id}>
    <h3>{kinds[row.kind]} · {row.subject||"学科待核对"}</h3>
    <p className="muted">{row.month||"月份未注明"} · {row.week||"周次未注明"} · {row.from?row.from+(row.to?" 至 "+row.to:""):"执行日期待确认"}</p>
    <p className="study-plan-text">{row.content}</p><p className="muted">预计时间 {row.estimated||"尚未登记"}{row.sources.length>0&&" · 原文 "+row.sources.join("、")}</p>
   </li>)}</ol>:<p className="muted">当前范围无已登记条目。</p>}
  </div>}
  {draft&&<form onSubmit={event=>{event.preventDefault();void save();}}>
   <h3>{draft.kind==="manual"?"建立初始规划":revisionsEnabled?"修订当前执行规划":"设置执行身份与有效期间"}</h3>
   {draft.kind==="manual"?<StudyPlanFields value={draft.fields} disabled={busy} dates set={fields=>setDraft({...draft,fields})}/>:
    <>
    <fieldset className="schedule-fields" disabled={busy}>
     {revisionsEnabled&&<label>修订生效日<input type="date" required min={date} value={draft.input.effectiveOn}
       onChange={event=>patch({effectiveOn:event.target.value})}/></label>}
     <label>状态<select value={draft.input.state} onChange={event=>patch({state:event.target.value as PlanVersionInput["state"]})}>
      <option value="active">明确启用</option><option value="draft">待核对</option><option value="history">转为历史</option>
     </select></label>
     <label>执行开始<input type="date" value={draft.input.startsOn} onChange={event=>patch({startsOn:event.target.value})}/></label>
     <label>执行结束<input type="date" value={draft.input.endsOn} onChange={event=>patch({endsOn:event.target.value})}/></label>
     <label>设置原因<textarea required maxLength={1000} value={draft.input.reason} onChange={event=>patch({reason:event.target.value})}/></label>
    </fieldset>
    {revisionsEnabled&&<StudyPlanFields value={draft.input.fields} set={fields=>patch({fields})} disabled={busy} dates/>}
    </>}
   <div className="schedule-buttons">
    <button type="submit" className="primary" disabled={busy}>保存规划</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>{setDraft(undefined);setStatus("");}}>放弃本次输入</button>
   </div>
  </form>}
 </section>;
}
