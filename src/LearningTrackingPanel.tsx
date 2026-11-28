import {useEffect,useState} from "react";
import type {WorkspaceApi} from "./contracts";
import type {TrackingFields,TrackingInput,TrackingRecord,TrackingView,UnitFields,CheckFields} from "./learning-tracking";
import {shanghaiParts} from "./schedule-calendar";

const unitStates={new:"尚未开始",learning:"学习中",learned:"学习完成",waiting:"待检测",tested:"已检测",consolidate:"待巩固"};
const checkStates={pending:"待检测",tested:"已检测",retest:"待复测",cancelled:"取消"};
const recordName=(f:TrackingFields)=>f.kind==="unit"?f.title:f.scope;
const stateLabel=(f:TrackingFields)=>f.kind==="unit"?unitStates[f.state]:checkStates[f.state];
const keyRef=(x:{kind:string;id:string;revision:number})=>[x.kind,x.id,x.revision].join("/");
const keyPlan=(x:{planId:string;entryId:string;revision:number})=>[x.planId,x.entryId,x.revision].join("/");

export function LearningTrackingPanel({api,studentId,onActivity,onSaved}:{api:WorkspaceApi;studentId:string;onActivity:(dirty:boolean,busy:boolean)=>void;onSaved:()=>void}){
 const [view,setView]=useState<TrackingView>(),[draft,setDraft]=useState<TrackingInput>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const [reload,setReload]=useState(0);
 const date=shanghaiParts(Date.now()).date;
 useEffect(()=>{
  let active=true;
  api.learningTracking(studentId).then(r=>{if(active){if(r.ok)setView(r.value);else setNotice(r.message);}})
   .catch(()=>{if(active)setNotice("无法读取学科单元。");});
  return()=>{active=false;};
 },[api,studentId,reload]);
 useEffect(()=>{onActivity(Boolean(draft),busy);return()=>onActivity(false,false);},[draft,busy,onActivity]);
 const units=(view?.records??[]).filter((r):r is TrackingRecord&{fields:UnitFields}=>r.fields.kind==="unit");
 const checks=(view?.records??[]).filter((r):r is TrackingRecord&{fields:CheckFields}=>r.fields.kind==="check");
 const begin=(fields:TrackingFields,record?:TrackingRecord)=>setDraft({id:record?.id??crypto.randomUUID(),studentId,date,
  requestId:crypto.randomUUID(),expectedRevision:record?.revision??0,fields});
 function patch(fields:Partial<TrackingFields>){setDraft(previous=>previous?{...previous,fields:{...previous.fields,...fields} as TrackingFields}:previous);}
 async function save(){
  if(!draft||busy)return;
  setBusy(true);setNotice("");
  try{
   const reply=await api.saveLearningTracking(draft);
   if(!reply.ok){setNotice(reply.message);return;}
   setDraft(undefined);setReload(n=>n+1);onSaved();setNotice("已保存新修订。");
  }catch{setNotice("保存结果待核对。可使用原保存编号重试。");}
  finally{setBusy(false);}
 }
 const f=draft?.fields;
 const selectedUnit=f?.kind==="check"?units.find(row=>row.id===f.unitId):undefined;
 return <section className="panel" aria-label="单元与检测" data-profile-switch-draft={draft||busy?"":undefined}>
  <header className="schedule-form-heading"><h2>单元与检测</h2><button type="button" className="secondary" disabled={!view||Boolean(draft)||busy} onClick={()=>begin({kind:"unit",subject:"",title:"",state:"new",basis:"",planning:null})}>新增学科单元</button></header>
  {notice&&<p role="status">{notice}</p>}
  {!view?<p className="muted">正在读取单元记录… <button type="button" onClick={()=>setReload(n=>n+1)}>重试</button></p>:!units.length?<p className="muted">尚未建立学科单元。</p>:<ul className="student-source-list">
   {units.map(unit=><li key={unit.id} id={"learning-unit-"+unit.id}><h3>{unit.fields.subject} · {unit.fields.title}</h3>
    <p>{stateLabel(unit.fields)} · {unit.date} · 第 {unit.revision} 版</p><p className="muted">{unit.fields.basis}</p>
    <button type="button" className="secondary" disabled={Boolean(draft)||busy} onClick={()=>begin(unit.fields,unit)}>更新单元状态</button>
    <button type="button" className="secondary" disabled={Boolean(draft)||busy} onClick={()=>begin({kind:"check",unitId:unit.id,scope:unit.fields.title,due:"",state:"pending",result:null,next:"",reminderId:null})}>建立检测任务</button>
    {checks.filter(row=>row.fields.unitId===unit.id).map(row=><p key={row.id}>
      <button type="button" className="schedule-profile-link" disabled={Boolean(draft)||busy} onClick={()=>begin(row.fields,row)}>{row.fields.scope}</button>
      {" · "+stateLabel(row.fields)+(row.fields.due?" · 预计 "+row.fields.due:"")}{row.fields.result&&" · 已引用真实结果第 "+row.fields.result.revision+" 版"}
      {row.fields.next&&" · "+row.fields.next}
    </p>)}
   </li>)}
  </ul>}
  {draft&&f&&<form aria-label="单元或检测修订" onSubmit={event=>{event.preventDefault();void save();}}>
   <h3>{f.kind==="unit"?"单元状态变化":"检测任务修订"}</h3>
   <fieldset className="schedule-fields" disabled={busy}>
    <label>状态变化日期<input type="date" required max={date} value={draft.date} onChange={event=>setDraft({...draft,date:event.target.value})}/></label>
    {f.kind==="unit"?<>
     <label>学科<input required value={f.subject} maxLength={40} onChange={event=>patch({subject:event.target.value})}/></label>
     <label>单元或知识点<input required value={f.title} maxLength={150} onChange={event=>patch({title:event.target.value})}/></label>
     <label>单元状态<select value={f.state} onChange={event=>patch({state:event.target.value as UnitFields["state"]})}>{Object.entries(unitStates).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
     <label>变化依据<input required value={f.basis} maxLength={400} onChange={event=>patch({basis:event.target.value})}/></label>
     <label>规划来源<select value={f.planning?keyPlan(f.planning):""} onChange={event=>{
      const ref=view?.plans.find(row=>keyPlan(row)===event.target.value);
      patch({planning:ref?{planId:ref.planId,revision:ref.revision,entryId:ref.entryId}:null});
     }}><option value="">教材章节或人工登记</option>{view?.plans.filter(row=>row.subject===f.subject).map(row=><option key={keyPlan(row)} value={keyPlan(row)}>{row.title} · 第 {row.revision} 版</option>)}</select></label>
    </>:<>
     <label>检测范围<input required value={f.scope} maxLength={250} onChange={event=>patch({scope:event.target.value})}/></label>
     <label>预计检测日期<input type="date" value={f.due} onChange={event=>patch({due:event.target.value})}/></label>
     <label>检测状态<select value={f.state} onChange={event=>patch({state:event.target.value as CheckFields["state"]})}>{Object.entries(checkStates).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
     <label>真实结果<select value={f.result?keyRef(f.result):""} onChange={event=>{
      const result=view?.results.find(row=>keyRef(row)===event.target.value);
      patch({result:result?{id:result.id,kind:result.kind,revision:result.revision}:null});
     }}><option value="">尚未关联</option>{f.result&&!view?.results.some(row=>keyRef(row)===keyRef(f.result!))&&<option value={keyRef(f.result)}>已引用的历史修订</option>}
      {view?.results.filter(row=>row.subject===selectedUnit?.fields.subject&&row.date<=draft.date).map(row=><option key={keyRef(row)} value={keyRef(row)}>{row.date} · {row.title} · 第 {row.revision} 版</option>)}</select></label>
     <label>已有工作事项<select value={f.reminderId??""} onChange={event=>patch({reminderId:event.target.value||null})}>
      <option value="">未关联</option>{view?.reminders.map(row=><option key={row.id} value={row.id}>{row.date} · {row.title}</option>)}</select></label>
     <label>后续巩固安排<input value={f.next} maxLength={400} onChange={event=>patch({next:event.target.value})}/></label>
    </>}
   </fieldset>
   <button className="primary" disabled={busy}>保存修订</button>
   <button type="button" className="secondary" disabled={busy} onClick={()=>setDraft(undefined)}>关闭修订</button>
  </form>}
  {view&&view.history.length>0&&<details><summary>历史变更（{view.history.length}）</summary><ul className="student-source-list">{view.history.map(row=><li key={row.requestId}>
   {row.date} · {recordName(row.fields)} · 第 {row.revision} 版 · {stateLabel(row.fields)}
   <p>{row.fields.kind==="unit"?row.fields.basis:row.fields.next}{row.fields.kind==="check"&&row.fields.result&&" · 结果版本 "+row.fields.result.revision}</p>
  </li>)}</ul></details>}
 </section>;
}
