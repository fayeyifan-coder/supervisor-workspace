import { useState } from "react";
import type { Student, WorkspaceApi } from "./contracts";
import type { PlanDocumentReview, PlanDraft, PlanPickResult } from "./study-plan-model";
import { StudyPlanFields } from "./StudyPlanFields";

export function StudyPlanImportPanel({api,students,onClose,onSaved}:{api:WorkspaceApi;students:Student[];onClose:()=>void;onSaved:()=>void}){
 const [files,setFiles]=useState<PlanPickResult[]>([]);
 const [selected,setSelected]=useState(0);
 const [drafts,setDrafts]=useState<Record<string,{fields:PlanDraft;studentId:string;confirm:boolean;result?:string}>>({});
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState("");
 const review=files[selected]?.review;
 const draft=review?drafts[review.token]:undefined;
 const pending=Object.values(drafts).some(row=>!row.result);
 function set(review:PlanDocumentReview,change:Partial<NonNullable<typeof draft>>){
   setDrafts(previous=>({...previous,[review.token]:{...previous[review.token],...change}}));
 }
 async function pick(){
  if(pending&&!window.confirm("本次 Word 预览尚有未保存条目。更换文件将清除未保存输入。"))return;
  setBusy(true);setStatus("");
  try{
   const response=await api.pickStudyPlans();
   if(!response.ok){setStatus(response.message);return;}
   if(!response.value.length){setStatus("未选择文件，现有预览保留。");return;}
   setFiles(response.value);setSelected(0);
   setDrafts(Object.fromEntries(response.value.flatMap(row=>row.review?[[row.review.token,{fields:row.review.fields,studentId:"",confirm:false}]]:[])));
  }catch{setStatus("文件选择失败，现有输入保留。");}finally{setBusy(false);}
 }
 async function save(){
  if(!review||!draft?.studentId||!draft.confirm||draft.result)return;
  setBusy(true);setStatus("");
  try{
   const fields={...draft.fields,subjects:draft.fields.subjects.map(x=>x.trim()).filter(Boolean)};
   const response=await api.saveStudyPlan({token:review.token,studentId:draft.studentId,confirmed:true,fields});
   if(!response.ok){setStatus(response.message);return;}
   const message=response.value.duplicate?"原件已保存，已保留原有初始规划。":"初始规划和 Word 原件已保存。";
   set(review,{result:message});setStatus(message);onSaved();
  }catch{setStatus("无法确认保存结果。请保留本页，重试同一文件。");}finally{setBusy(false);}
 }
 return <section className="panel study-plan-import" aria-label="Word 学习规划导入" data-profile-switch-draft={busy||pending?"":undefined}>
  <header className="schedule-form-heading"><h2>批量导入半年学习规划</h2>
   <button type="button" className="secondary" disabled={busy} onClick={()=>{if(!pending||window.confirm("关闭将放弃尚未保存的本次预览。"))onClose();}}>关闭导入</button>
  </header>
  <p className="muted">一次选择 1 至 20 份 Word 文件。逐份核对学生身份与学科后保存。单份原件上限 512 KiB。</p>
  <button type="button" className="primary" disabled={busy} onClick={()=>void pick()}>选择 Word 文件</button>
  {status&&<p role="status" aria-live="polite">{status}</p>}
  {files.length>0&&<ol className="study-plan-file-list">{files.map((file,index)=><li key={index}>
   <button type="button" className="secondary" disabled={busy} aria-pressed={selected===index} onClick={()=>{setSelected(index);setStatus("");}}>
    {file.name} · {file.issue?"需人工处理":file.review&&drafts[file.review.token]?.result?"已处理":"待核对"}
   </button></li>)}</ol>}
  {files[selected]?.issue&&<p role="alert">{files[selected].issue} 可在 Word 本地另存为 DOCX 后重试，或在学生档案人工新建规划。</p>}
  {review&&draft&&<div>
   <h3>{review.name}</h3>
   <p className="muted">SHA256 <code>{review.sha256}</code>{review.duplicate&&" · 检测到已保存的同一原件"}</p>
   {review.warnings.length>0&&<ul className="notice pending">{review.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul>}
   <details><summary>原文与未识别内容（{review.cells.length} 项）</summary>
    <dl className="study-plan-original">{review.cells.filter(cell=>cell.text.trim()).map(cell=><div key={cell.ref}>
      <dt>{cell.ref}{cell.span&&cell.span>1?" · 合并 "+cell.span+" 列":""}{cell.merge?" · 纵向合并":""}</dt><dd>{cell.text}</dd>
    </div>)}</dl>
   </details>
   <StudyPlanFields value={draft.fields} set={fields=>set(review,{fields,confirm:false})} disabled={busy||Boolean(draft.result)}/>
   <label>关联现有学生<select value={draft.studentId} disabled={busy||Boolean(draft.result)}
     onChange={event=>set(review,{studentId:event.target.value,confirm:false})}>
     <option value="">请选择并核对档案</option>{students.map(student=><option key={student.id} value={student.id}>{student.alias} · {student.grade} · {student.id.slice(-8)}</option>)}
   </select></label>
   <label className="schedule-check"><input type="checkbox" checked={draft.confirm} disabled={!draft.studentId||busy||Boolean(draft.result)}
    onChange={event=>set(review,{confirm:event.target.checked})}/>已核对封面、正文和现有学生档案身份</label>
   <button type="button" className="primary" disabled={!draft.confirm||busy||Boolean(draft.result)} onClick={()=>void save()}>保存这一份规划</button>
   {draft.result&&<p>{draft.result}</p>}
  </div>}
 </section>;
}
