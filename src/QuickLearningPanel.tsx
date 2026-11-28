import { useEffect,useState } from "react";
import type { Student,WorkspaceApi } from "./contracts";
import type { DailyContext,DailyInput } from "./learning-daily";
import { shanghaiParts } from "./schedule-calendar";

const commonTags=["专注","主动提问","草稿清晰","笔记完整","审题需提醒","错题已整理","作业已完成","作业待补"];
export function QuickLearningPanel({api,student,attendanceId,onClose,onSaved}:{api:WorkspaceApi;student:Student;attendanceId?:string;onClose:()=>void;onSaved:()=>void}){
 const today=shanghaiParts(Date.now()).date;
 const empty=():DailyInput=>({id:crypto.randomUUID(),studentId:student.id,date:today,subject:"",content:"",
  completion:"",mastery:"unassessed",tags:[],problem:"",intervention:"",next:"",attendanceId:attendanceId??null,
  source:attendanceId?"attendance":"other",taskId:null,priorTaskId:null,planning:null});
 const [draft,setDraft]=useState(empty),[key,setKey]=useState(""),[dirty,setDirty]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [loaded,setLoaded]=useState<{date:string;data:DailyContext}>();
 useEffect(()=>{
  let alive=true;
  api.activationStatus().then(reply=>{
   if(!alive||!reply.ok)return;
   const key="quick-learning-v1:"+reply.value.location+"/"+student.id;
   try{
    const stored=localStorage.getItem(key);
    if(stored){
     const saved=JSON.parse(stored) as DailyInput;
     if(saved.studentId===student.id){setDraft(saved);setDirty(true);}
    }
    setKey(key);
   }catch{setKey(key);setMessage("无法读取上次草稿。当前输入仍可保存。");}
  }).catch(()=>{if(alive)setMessage("无法确认档案身份，请关闭后重试。");});
  return()=>{alive=false;};
 },[api,student.id]);
 useEffect(()=>{
  if(!draft.date)return;
  let alive=true;
  api.dailyContext(student.id,draft.date).then(reply=>{
   if(!alive)return;
   if(reply.ok)setLoaded({date:draft.date,data:reply.value});else setMessage(reply.message);
  }).catch(()=>{if(alive)setMessage("无法读取到课和规划来源。");});
  return()=>{alive=false;};
 },[api,draft.date,student.id]);
 const context=loaded?.date===draft.date?loaded.data:undefined;
 function patch(fields:Partial<DailyInput>){
  const next={...draft,...fields};setDraft(next);setDirty(true);
  if(key)try{localStorage.setItem(key,JSON.stringify(next));}catch{setMessage("本机草稿暂无法落盘，请保持窗口开启。");}
 }
 async function save(){
  if(busy||!key||!context)return;
  setBusy(true);setMessage("");
  try{
   const result=await api.addQuickLesson(draft);
   if(!result.ok){setMessage(result.message);return;}
   try{localStorage.removeItem(key);}catch{}
   onSaved();onClose();
  }catch{setMessage("保存结果待核对。请保留当前草稿并重试同一请求。");}
  finally{setBusy(false);}
 }
 function close(){
  if(!dirty||window.confirm("关闭后会保留这名学生的本机草稿。"))onClose();
 }
 const planKey=(value:DailyInput["planning"])=>value?[value.planId,value.revision,value.entryId].join("/"):"";
 return <section className="panel schedule-page quick-learning" aria-label="快速学习登记" data-profile-switch-draft={dirty||busy?"":undefined}>
  <header className="schedule-form-heading"><h2>快速学习登记 · {student.alias}</h2>
   <button type="button" className="secondary" disabled={busy} onClick={close}>关闭登记</button></header>
  {message&&<p role="status">{message}</p>}
  <form onSubmit={event=>{event.preventDefault();void save();}}>
   <fieldset className="schedule-fields" disabled={busy||!key}>
    <label>实际学习日期<input required type="date" max={today} value={draft.date} onChange={event=>patch({date:event.target.value,attendanceId:null,taskId:null,priorTaskId:null,planning:null,source:"other"})}/></label>
    <label>学习来源<select value={draft.source} onChange={event=>patch({source:event.target.value==="attendance"?"attendance":"other",attendanceId:null,taskId:null})}>
      <option value="other">其他学习</option><option value="attendance">机构实际到课</option></select></label>
    {draft.source==="attendance"&&<label>实际到课<select required value={draft.attendanceId??""} onChange={event=>patch({attendanceId:event.target.value||null,taskId:null})}>
      <option value="">请选择当天签到</option>{context?.visits.map(visit=><option key={visit.id} value={visit.id}>{shanghaiParts(visit.start).time} 签到</option>)}</select></label>}
    <label>学科<input required maxLength={40} value={draft.subject} onChange={event=>patch({subject:event.target.value,taskId:null,planning:null})}/></label>
    <label>完成程度<select value={draft.completion} onChange={event=>patch({completion:event.target.value as DailyInput["completion"]})}>
     <option value="">未登记</option><option value="complete">完成</option><option value="partial">部分完成</option><option value="incomplete">未完成</option></select></label>
    <label>掌握情况<select value={draft.mastery} onChange={event=>patch({mastery:event.target.value as DailyInput["mastery"]})}>
     <option value="unassessed">未评估</option><option value="good">较好</option><option value="basic">基本掌握</option><option value="review">需巩固</option></select></label>
   </fieldset>
   <fieldset className="schedule-fields" disabled={busy||!key}>
    <label>实际学习内容<textarea required maxLength={500} rows={3} value={draft.content} onChange={event=>patch({content:event.target.value})}/></label>
    <label>学习问题<textarea maxLength={500} rows={3} value={draft.problem} onChange={event=>patch({problem:event.target.value})}/></label>
    <label>教师观察与干预<textarea maxLength={500} rows={3} value={draft.intervention} onChange={event=>patch({intervention:event.target.value})}/></label>
    <label>下次学习安排<textarea maxLength={500} rows={3} value={draft.next} onChange={event=>patch({next:event.target.value})}/></label>
   </fieldset>
   <fieldset className="schedule-fields" disabled={busy||!context||!key}>
    <label>已有详细任务<select value={draft.taskId??""} onChange={event=>{
     const task=context?.tasks.find(item=>item.id===event.target.value);
     patch(task?{taskId:task.id,subject:task.subject,content:task.content,planning:null}:{taskId:null});
    }}><option value="">独立学习登记</option>{context?.tasks.filter(item=>item.attendanceId===draft.attendanceId).map(item=><option key={item.id} value={item.id} disabled={item.used&&item.id!==draft.taskId}>{item.subject} · {item.content}{item.used?" · 已登记":""}</option>)}</select></label>
    <label>引用未完任务<select value={draft.priorTaskId??""} onChange={event=>patch({priorTaskId:event.target.value||null})}>
     <option value="">不引用</option>{context?.unfinished.map(item=><option key={item.id} value={item.id}>{item.date} · {item.subject} · {item.content}</option>)}</select></label>
    <label>当日有效规划<select value={planKey(draft.planning)} onChange={event=>{
     const match=context?.plans.find(item=>planKey(item)===event.target.value);
     patch({planning:match?{planId:match.planId,revision:match.revision,entryId:match.entryId}:null});
    }}><option value="">不关联规划</option>{context?.plans.filter(item=>!draft.subject||draft.subject.trim()===item.subject).map(item=><option key={planKey(item)} value={planKey(item)}>{item.subject} · 第 {item.revision} 版 · {item.content}</option>)}</select></label>
   </fieldset>
   {context?.previous&&<details><summary>上次学习记录</summary><p>{context.previous.date} · {context.previous.subject} · {context.previous.task}</p>{context.previous.nextStep&&<p>下次安排 {context.previous.nextStep}</p>}</details>}
   <fieldset className="schedule-fields" disabled={busy||!key}><legend>学习表现标签</legend>{commonTags.map(tag=><label className="schedule-check" key={tag}>
    <input type="checkbox" checked={draft.tags.includes(tag)} onChange={event=>patch({tags:event.target.checked?[...draft.tags,tag]:draft.tags.filter(item=>item!==tag)})}/>{tag}</label>)}</fieldset>
   <p className="muted">登记时间自动记录。学习开始、结束与时长缺少事实时保持未知。</p>
   <button type="submit" className="primary" disabled={busy||!key||!context}>{busy?"正在保存…":"保存快速登记"}</button>
   {dirty&&!busy&&<button type="button" className="secondary" onClick={()=>{if(window.confirm("确认丢弃当前快速登记草稿？")){try{localStorage.removeItem(key);}catch{}onClose();}}}>放弃草稿</button>}
  </form>
 </section>;
}
