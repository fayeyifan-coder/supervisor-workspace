import type { PlanDraft, PlanEntry } from "./study-plan-model";

const narrative=[["context","学科现状与规划依据"],["goals","阶段及半年目标"],["habits","学习习惯与教学干预"],["notes","备注与人工补充"]] as const;

export function StudyPlanFields({value,set,disabled=false,dates=false}:{value:PlanDraft;set:(plan:PlanDraft)=>void;disabled?:boolean;dates?:boolean}){
  function change<K extends keyof PlanDraft>(key:K,next:PlanDraft[K]){set({...value,[key]:next});}
  function item(id:string,fields:Partial<PlanEntry>){change("entries",value.entries.map(row=>row.id===id?{...row,...fields}:row));}
  return <fieldset className="study-plan-fields" disabled={disabled}>
    <div className="schedule-fields">
      <label>规划标题<input value={value.title} onChange={event=>change("title",event.target.value)} required maxLength={160}/></label>
      <label>原规划学年或学期<input value={value.term} onChange={event=>change("term",event.target.value)} maxLength={180}/></label>
      <label>原文学生身份<input value={value.learner} onChange={event=>change("learner",event.target.value)} maxLength={120}/></label>
      <label>原文年级<input value={value.grade} onChange={event=>change("grade",event.target.value)} maxLength={80}/></label>
      <label>学科（以逗号分隔）<input key="subjects" value={value.subjects.join("，")} onChange={event=>
        change("subjects",event.target.value.split(/[，,]/))}/></label>
    </div>
    <div className="schedule-fields">
      {narrative.map(([key,label])=><label key={key}>{label}<textarea rows={3} maxLength={15000} value={value[key]}
        onChange={event=>change(key,event.target.value)}/></label>)}
    </div>
    <h3>月度目标与每周任务</h3>
    {value.entries.map((row,index)=><div className="study-plan-entry" key={row.id}>
      <div className="schedule-fields">
        <label>条目 {index+1} 类型<select value={row.kind} onChange={event=>item(row.id,{kind:event.target.value as PlanEntry["kind"]})}>
          <option value="month">月度目标</option><option value="week">每周任务</option><option value="note">补充事项</option>
        </select></label>
        <label>所属学科<select value={row.subject} onChange={event=>item(row.id,{subject:event.target.value})}>
          <option value="">待核对</option>{[...new Set(value.subjects.map(v=>v.trim()).filter(Boolean))].map(subject=><option key={subject}>{subject}</option>)}
        </select></label>
        <label>原始月份<input value={row.month} maxLength={60} onChange={event=>item(row.id,{month:event.target.value})}/></label>
        <label>原始周次<input value={row.week} maxLength={60} onChange={event=>item(row.id,{week:event.target.value})}/></label>
        <label>预计学习时间<input value={row.estimated} maxLength={160} onChange={event=>item(row.id,{estimated:event.target.value})}/></label>
        {dates&&<><label>执行起日<input type="date" value={row.from} onChange={event=>item(row.id,{from:event.target.value})}/></label>
        <label>执行止日<input type="date" value={row.to} onChange={event=>item(row.id,{to:event.target.value})}/></label></>}
      </div>
      <label>目标或任务内容<textarea value={row.content} maxLength={12000} rows={3} onChange={event=>item(row.id,{content:event.target.value})}/></label>
      {row.sources.length>0&&<p className="muted">原文 {row.sources.join("、")}</p>}
      <button type="button" className="secondary" onClick={()=>change("entries",value.entries.filter(entry=>entry.id!==row.id))}>从本次规划移除此条目</button>
    </div>)}
    <button type="button" className="secondary" disabled={value.entries.length>=300}
      onClick={()=>change("entries",[...value.entries,{id:crypto.randomUUID(),subject:value.subjects.length===1?value.subjects[0]:"",month:"",week:"",kind:"week",content:"",estimated:"",from:"",to:"",sources:[]}])}>添加规划条目</button>
  </fieldset>;
}
