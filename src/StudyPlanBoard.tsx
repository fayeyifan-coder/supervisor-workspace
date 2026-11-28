import { useEffect,useState } from "react";
import type { LearningDayInput,Result,WorkspaceApi } from "./contracts";
import type { PlanBoardData,PlanBoardRow } from "./study-plan-model";
import { shanghaiParts } from "./schedule-calendar";

const stateLabels={active:"已有执行规划",missing:"尚未建立",review:"待确认或待生效",history:"只有历史规划"} as const;
const lifeLabels={active:"正常跟进",paused:"暂停学习",archived:"已归档"} as const;
const taskLabels={planned:"待开始",in_progress:"进行中",done:"已完成",skipped:"已跳过"} as const;

export function StudyPlanBoard({api,refresh,onPlan,onLearning,visible}:{
 api:WorkspaceApi;refresh:number;visible:boolean;
 onPlan:(studentId:string,planId:string|undefined,revision:number|undefined,trigger:HTMLButtonElement)=>void;
 onLearning:(target:LearningDayInput,trigger:HTMLButtonElement,taskId?:string)=>void;
}){
 const [date,setDate]=useState(shanghaiParts(Date.now()).date);
 const [period,setPeriod]=useState<"week"|"month">("week");
 const [life,setLife]=useState("active");
 const [student,setStudent]=useState("");
 const [subject,setSubject]=useState("");
 const [status,setStatus]=useState("");
 const [reload,setReload]=useState(0);
 const [loaded,setLoaded]=useState<{date:string;result:Result<PlanBoardData>}>();
 useEffect(()=>{
  if(!date||!visible)return;
  let alive=true;
  api.studyPlanBoard(date).then(result=>{if(alive)setLoaded({date,result});}).catch(()=>{
   if(alive)setLoaded({date,result:{ok:false,code:"failed",message:"无法读取规划总览。"}});
  });
  return()=>{alive=false;};
 },[api,date,refresh,reload,visible]);
 const response=loaded?.date===date?loaded.result:undefined;
 const board=response?.ok?response.value:undefined;
 const matches=(row:PlanBoardRow)=> (!student||row.studentId===student)&&(!subject||row.subjects.includes(subject))&&
  (life==="all"||row.lifecycle===life)&&(!status||(status==="not-imported"?row.imported===0:
   status==="needs-review"?row.status==="review"||row.pending.length>0||row.today.some(plan=>plan.undated>0||plan.unassigned>0):row.status===status));
 const rows=board?.rows.filter(matches)??[];
 const subjects=[...new Set(board?.rows.flatMap(row=>row.subjects)??[])];
 const itemCount=(key:"week"|"month")=>rows.reduce((n,row)=>n+row[key].filter(item=>!subject||item.entry.subject===subject).length,0);
 return <section className="schedule-page study-plan-board" aria-labelledby="study-plan-overview-title">
  <header className="schedule-heading">
   <div><h1 id="study-plan-overview-title">学习规划总览</h1><p className="muted">查看学生规划、确认日期及已关联的学习记录。</p></div>
   <button type="button" className="secondary" onClick={()=>setReload(n=>n+1)}>刷新总览</button>
  </header>
  <div className="panel schedule-fields">
   <label>参考日期<input type="date" value={date} onChange={event=>setDate(event.target.value)}/></label>
   <label>跟进状态<select value={life} onChange={event=>setLife(event.target.value)}>
    <option value="all">全部</option>{Object.entries(lifeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
   <label>学生<select value={student} onChange={event=>setStudent(event.target.value)}>
    <option value="">全部学生</option>{board?.rows.map(row=><option key={row.studentId} value={row.studentId}>{row.alias} · {row.grade}</option>)}
   </select></label>
   <label>学科<select value={subject} onChange={event=>setSubject(event.target.value)}>
    <option value="">全部学科</option>{subjects.map(item=><option key={item}>{item}</option>)}
   </select></label>
   <label>规划状态<select value={status} onChange={event=>setStatus(event.target.value)}>
    <option value="">全部</option><option value="not-imported">未导入 Word</option><option value="needs-review">有待核对事项</option>
    {Object.entries(stateLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
  </div>
  {!date?<p className="muted">请选择参考日期。</p>:!response?<p role="status">正在读取…</p>:!response.ok?
   <p role="alert">{response.message}</p>:board&&<>
   <dl className="attendance-overview" aria-label="规划范围汇总">
    <div><dt>学生</dt><dd>{rows.length} 人</dd></div>
    <div><dt>尚未建立规划</dt><dd>{rows.filter(row=>row.status==="missing").length} 人</dd></div>
    <div><dt>未导入 Word</dt><dd>{rows.filter(row=>row.imported===0).length} 人</dd></div>
    <div><dt>本周已定日条目</dt><dd>{itemCount("week")}</dd></div>
    <div><dt>本月已定日条目</dt><dd>{itemCount("month")}</dd></div>
   </dl>
   <div className="schedule-buttons">
    <button type="button" className="secondary" aria-pressed={period==="week"} onClick={()=>setPeriod("week")}>本周规划</button>
    <button type="button" className="secondary" aria-pressed={period==="month"} onClick={()=>setPeriod("month")}>本月规划</button>
    <p className="muted">{period==="week"?board.weekFrom+" 至 "+board.weekTo:board.monthFrom+" 至 "+board.monthTo}</p>
   </div>
   {!rows.length&&<p className="muted">当前没有符合筛选条件的学生。</p>}
   <ul className="study-board-rows">{rows.map(row=>{
    const items=row[period].filter(item=>!subject||item.entry.subject===subject);
    return <li className="panel" key={row.studentId}>
     <div className="schedule-form-heading">
      <h2><button type="button" className="schedule-profile-link" onClick={event=>onPlan(row.studentId,undefined,undefined,event.currentTarget)}>{row.alias}</button></h2>
      <span>{row.grade} · {lifeLabels[row.lifecycle]} · {stateLabels[row.status]}</span>
     </div>
     <p className="muted">{row.plans} 份规划 · 已导入 {row.imported} 份 Word</p>
     {row.today.map(plan=><p key={plan.id}><button type="button" className="schedule-profile-link" onClick={event=>
      onPlan(row.studentId,plan.id,plan.revision,event.currentTarget)}>{plan.title} · 第 {plan.revision} 版</button>
      {plan.undated>0&&" · 日期待核对 "+plan.undated+" 项"}
      {plan.unassigned>0&&" · 学科待核对 "+plan.unassigned+" 项"}</p>)}
     {row.pending.map(plan=><p key={plan.id}><button type="button" className="schedule-profile-link" onClick={event=>
      onPlan(row.studentId,plan.id,undefined,event.currentTarget)}>{plan.title}</button> · 待确认执行身份或生效</p>)}
     {!items.length?<p className="muted">当前范围尚未登记已确认日期的条目。</p>:
       <details open={Boolean(student)}><summary>期间规划 · {items.length} 项</summary><ol>{items.map(item=><li key={item.key}>
        <p><button type="button" className="schedule-profile-link" onClick={event=>onPlan(row.studentId,item.planId,item.revision,event.currentTarget)}>
         {item.entry.from} · {item.entry.subject||"学科待核对"} · {item.entry.content}</button></p>
        <p className="muted">{item.planTitle} · 第 {item.revision} 版 · {item.entry.estimated||"预计时长尚未登记"}</p>
        {item.actual.length?item.actual.map(task=><p key={task.id}>{task.attendanceId?<button type="button" className="schedule-profile-link"
          onClick={event=>onLearning({studentId:row.studentId,attendanceId:task.attendanceId!},event.currentTarget,task.id)}>{task.content}</button>:task.content}
          {" · "+taskLabels[task.status]}</p>):<p className="muted">实际学习任务尚未关联。</p>}
       </li>)}</ol></details>}
    </li>;
   })}</ul>
  </>}
 </section>;
}
