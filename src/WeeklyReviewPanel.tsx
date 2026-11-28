import {useEffect,useState} from "react";
import type {WorkspaceApi} from "./contracts";
import type {ReviewNotes,ReviewRange,ReviewSave,ReviewView,WeekFacts} from "./learning-week-review";
import {mondayOf,shanghaiParts,shiftDate} from "./schedule-calendar";

const blank:ReviewNotes={evaluation:"",issues:"",next:"",parent:""};
const completeness:Record<string,string>={complete:"完成",partial:"部分完成",incomplete:"未完成",in_progress:"已开始",skipped:"已跳过",done:"详细任务已登记完成"};
const mastery:Record<string,string>={good:"较好",basic:"基本掌握",review:"需巩固",unassessed:"未评估"};
const execution={recorded:"已有完成记录",incomplete:"已有未完成或部分完成记录",unrecorded:"尚无已确认执行依据"};
const trackingState:Record<string,string>={new:"尚未开始",learning:"学习中",learned:"学习完成",waiting:"待检测",tested:"已检测",consolidate:"待巩固",pending:"待检测",retest:"待复测",cancelled:"取消"};
function courseWeek(work=false):ReviewRange{
 const monday=mondayOf(shanghaiParts(Date.now()).date);
 return {from:shiftDate(monday,work?1:0),to:shiftDate(monday,6)};
}
function FactSources({facts:f}:{facts:WeekFacts}){
 return <div className="weekly-review-facts">
  <p><strong>实际到课 {f.visits.length} 次</strong> · 在校时长 {f.onSiteMinutes===null?"未登记":f.onSiteMinutes+" 分钟"}
   {f.visitsWithoutCheckout>0&&" · "+f.visitsWithoutCheckout+" 次缺少签退"}</p>
  <details open><summary>实际学习与教师干预（{f.facts.length}）</summary>
   {!f.facts.length?<p>尚未登记学习事实。</p>:<ul className="student-source-list">{f.facts.map(row=><li key={row.id}>
    <strong>{row.date} · {row.subject||"学科未登记"} · {row.content}</strong>
    <p>{completeness[row.completion]??row.completion} · {row.source==="quick"?"快速登记":row.source==="detail"?"详细任务":"学习历史"}
      {row.mastery&&" · "+(mastery[row.mastery]??row.mastery)}{row.planning&&" · 规划第 "+row.planning.revision+" 版"}
      {row.planningNeedsReview&&" · 规划来源待核对"}</p>
    {row.tags?.length?<p>学习表现 {row.tags.join("、")}</p>:null}
    {row.problem&&<p>问题与观察 {row.problem}</p>}{row.intervention&&<p>教师干预 {row.intervention}</p>}{row.next&&<p>下次安排 {row.next}</p>}
   </li>)}</ul>}
  </details>
  <details><summary>计划与偏差（{f.plans.length}）</summary>
   {!f.plans.length?<p>本范围没有已定日的规划。</p>:<ul>{f.plans.map(row=><li key={row.planId+"/"+row.revision+"/"+row.entryId}>
    {row.from} · {row.subject} · {row.content} · 第 {row.revision} 版 · {execution[row.execution]}</li>)}</ul>}
   {f.pendingTasks.map(row=><p key={row.id}>{row.date} · {row.subject} · {row.content} · 详细任务尚未开始</p>)}
  </details>
  <details><summary>考试与单元检测（{f.scores.length+f.tracking.length}）</summary>
   {!f.scores.length&&!f.tracking.length&&<p>本范围尚无成绩或单元检测记录。</p>}
   {f.scores.map(row=><p key={row.id}>{row.date} · {row.subject} · {row.title} · {row.score}/{row.maximum} · 第 {row.revision} 版</p>)}
   {f.scoreChanges.map(row=><p key={row.subject}>{row.subject} 区间得分率变化 {row.ratePoints.toFixed(1)} 个百分点
    {row.rawDelta!==null&&" · 原始分数变化 "+row.rawDelta}。各考试难度与适用范围需人工核对。</p>)}
   {f.tracking.map(row=><p key={row.id}>{row.date} · {row.fields.kind==="unit"?row.fields.title:row.fields.scope}
    {" · "+trackingState[row.fields.state]+" · 第 "+row.revision+" 版"}
    {row.fields.kind==="check"&&row.fields.result&&" · 结果已关联第 "+row.fields.result.revision+" 版"}</p>)}
  </details>
  <details><summary>家长沟通与后续事项（{f.contacts.length+f.followUps.length}）</summary>
   {!f.contacts.length&&!f.followUps.length&&<p>尚无已登记的沟通或待办。</p>}
   {[...f.contacts,...f.followUps].map(row=><p key={row.id}>{row.date} · {row.text}{row.next&&" · "+row.next}</p>)}
  </details>
  <p className="muted">有效学习时间、占比、健康度、作业完成率、前后正确率及掌握百分比均为未登记。</p>
 </div>;
}
export function WeeklyReviewPanel({api,studentId,initialRange,refresh=0,onActivity,onSaved}:{api:WorkspaceApi;studentId:string;initialRange?:ReviewRange;
 refresh?:number;onActivity:(dirty:boolean,busy:boolean)=>void;onSaved?:()=>void}){
 const [range,setRange]=useState(initialRange??courseWeek()),[view,setView]=useState<ReviewView>();
 const [draft,setDraft]=useState<ReviewNotes>(),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const [seen,setSeen]=useState<string>();
 const [requestId,setRequestId]=useState<string>(),[historical,setHistorical]=useState(0);
 useEffect(()=>{
  let alive=true;
  if(!range.from||!range.to)return;
  api.weeklyReview(studentId,range).then(r=>{if(!alive)return;if(r.ok){setView(r.value);setMessage("");}else{setView(undefined);setMessage(r.message);}})
   .catch(()=>{if(alive)setMessage("无法读取周复盘。");});
  return()=>{alive=false;};
 },[api,studentId,range,refresh,reload]);
 useEffect(()=>{onActivity(Boolean(draft),busy);return()=>onActivity(false,false);},[draft,busy,onActivity]);
 const validView=view?.facts.range.from===range.from&&view.facts.range.to===range.to?view:undefined;
 const latest=validView?.history[0],display=validView?.history.find(row=>row.revision===historical);
 function changeRange(next:ReviewRange){
  if(draft&&!window.confirm("切换复盘日期将放弃当前未保存评价。"))return;
  setRange(next);setDraft(undefined);setHistorical(0);setSeen(undefined);setRequestId(undefined);
 }
 function start(){
  if(!validView)return;
  setDraft(latest?.notes??blank);setSeen(validView.sourceDigest);setRequestId(crypto.randomUUID());setHistorical(0);
 }
 async function save(state:ReviewSave["state"]){
  if(!draft||!validView||seen!==validView.sourceDigest||!requestId||busy)return;
  setBusy(true);
  try{
   const reply=await api.saveWeeklyReview({studentId,range,state,requestId,sourceDigest:seen,notes:draft,expectedRevision:latest?.revision??0});
   if(!reply.ok){setMessage(reply.message);return;}
   setDraft(undefined);setRequestId(undefined);setSeen(undefined);setReload(n=>n+1);onSaved?.();setMessage("已保存复盘新版本。");
  }catch{setMessage("保存结果待核对。保留当前评价并重试同一编号。");}
  finally{setBusy(false);}
 }
 return <section className="panel weekly-review" aria-label="每周学习复盘" data-profile-switch-draft={draft||busy?"":undefined}>
  <header className="schedule-form-heading"><h2>每周学习复盘</h2><button type="button" className="secondary" disabled={busy} onClick={()=>setReload(n=>n+1)}>刷新事实</button></header>
  <div className="schedule-buttons"><button type="button" className="secondary" disabled={busy} onClick={()=>changeRange(courseWeek())}>本自然周 · 周一至周日</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>changeRange(courseWeek(true))}>本工作周 · 周二至周日</button></div>
  <div className="schedule-fields"><label>起始日期<input type="date" disabled={busy} value={range.from} onChange={event=>changeRange({...range,from:event.target.value})}/></label>
   <label>截止日期<input type="date" disabled={busy} value={range.to} onChange={event=>changeRange({...range,to:event.target.value})}/></label></div>
  {message&&<p role="status">{message}</p>}
  {latest&&<p>最新第 {latest.revision} 版 · {latest.state==="confirmed"?"已确认":"草稿"}</p>}
  {validView?.outdated&&<p className="notice pending" role="status">事实来源已变化，已保存快照保留。请核对当前事实后创建新版本。</p>}
  {validView&&<><label>查看来源快照<select value={historical} disabled={Boolean(draft)||busy} onChange={event=>setHistorical(Number(event.target.value))}>
   <option value={0}>当前事实</option>{validView.history.map(row=><option key={row.revision} value={row.revision}>第 {row.revision} 版 · {row.state==="confirmed"?"已确认":"草稿"}</option>)}</select></label>
   <FactSources facts={display?.facts??validView.facts}/>
   {!draft&&<><dl>{Object.entries(display?.notes??latest?.notes??blank).filter(([,value])=>value).map(([field,value])=><div key={field}>
    <dt>{{evaluation:"人工评价",issues:"问题判断",next:"下周干预",parent:"家长沟通重点"}[field]}</dt><dd>{value}</dd></div>)}</dl>
    <button type="button" className="primary" disabled={busy} onClick={start}>{latest?"开始新复盘版本":"开始本周复盘"}</button></>}
  </>}
  {draft&&<><h3>人工评价与下周建议</h3><fieldset className="schedule-fields" disabled={busy}>
   {Object.entries({evaluation:"人工评价",issues:"问题判断",next:"下周干预",parent:"家长沟通重点"} as const).map(([field,label])=>
    <label key={field}>{label}<textarea maxLength={1500} rows={3} value={draft[field as keyof ReviewNotes]} onChange={event=>setDraft({...draft,[field]:event.target.value})}/></label>)}
   </fieldset>
   {validView&&seen!==validView.sourceDigest&&<p className="notice pending">事实已更新。核对后<button type="button" className="secondary" disabled={busy}
    onClick={()=>{setRequestId(crypto.randomUUID());setSeen(validView.sourceDigest);}}>采用当前事实</button></p>}
   <div className="schedule-buttons"><button type="button" className="secondary" disabled={busy||!validView||seen!==validView.sourceDigest} onClick={()=>void save("draft")}>保存草稿版本</button>
    <button type="button" className="primary" disabled={busy||!validView||seen!==validView.sourceDigest} onClick={()=>void save("confirmed")}>确认并保存快照</button>
    <button type="button" className="secondary" disabled={busy} onClick={()=>setDraft(undefined)}>关闭评价</button></div>
  </>}
 </section>;
}
