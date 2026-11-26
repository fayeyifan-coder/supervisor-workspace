import { useEffect, useRef, useState } from "react";
import type { WorkspaceApi } from "./contracts";
import type { BusinessExportPreview, BusinessExportResult } from "./business-export";

export function BusinessExportPanel({api, supported, onBusyChange}: {api: WorkspaceApi; supported: boolean; onBusyChange: (busy: boolean) => void}) {
 const [includeSourceText,setIncludeSourceText]=useState(false);
 const [preview,setPreview]=useState<BusinessExportPreview>();
 const [result,setResult]=useState<BusinessExportResult>();
 const [busy,setBusy]=useState(false);
 const [failure,setFailure]=useState("");
 const [notice,setNotice]=useState("");
 const token=useRef<string | undefined>(undefined); const generation=useRef(0);
 useEffect(()=>{onBusyChange(busy);},[busy,onBusyChange]);
 useEffect(()=>()=>{generation.current++; if(token.current) void api.cancelBusinessExport(token.current).catch(()=>undefined);},[api]);
 async function prepare() {
  const current=++generation.current;setBusy(true);setFailure("");setNotice("");setResult(undefined);setPreview(undefined);token.current=undefined;
  try {
   const reply=await api.prepareBusinessExport({includeSourceText});
   if(current!==generation.current){if(reply.ok)void api.cancelBusinessExport(reply.value.token).catch(()=>undefined);return;}
   if(reply.ok){token.current=reply.value.token;setPreview(reply.value);}else setFailure(reply.message);
  }catch{setFailure("未能生成导出预览，请核对后重试。");}finally{if(current===generation.current)setBusy(false);}
 }
 async function cancel() {
  const old=token.current;token.current=undefined;setPreview(undefined);generation.current++;
  if(old) await api.cancelBusinessExport(old).catch(()=>undefined);
  setNotice("预览已取消，没有生成业务导出文件。");
 }
 async function write() {
  if(!preview)return;setBusy(true);setFailure("");setNotice("");
  try {
   const reply=await api.writeBusinessExport(preview.token);
   if(!reply.ok)setFailure(reply.message);
   else if(reply.value){setResult(reply.value);setPreview(undefined);token.current=undefined;}
   else setNotice("已取消选择保存位置，未写入文件；可重新选择位置或取消预览。");
  }catch{setFailure("无法确认导出结果，请保留生成目录并核对 export.complete，不要盲目重复导出。");}
  finally{setBusy(false);}
 }
 return <section className="panel worklog" aria-labelledby="business-export-title">
  <h2 id="business-export-title">全量业务数据导出</h2>
  <p className="muted">生成可阅读的 Excel（XLSX）及保真 JSON。范围为当前档案的全部学生、业务记录及历史修订，不限当前学生或界面分页；不代替可恢复的 SWBACK2 完整备份。</p>
  <p className="muted">仅在本机新建独立目录，不上传、不覆盖已有文件，也不会改变最近完整备份时间。超长或特殊文本会明确转到分片表和 JSON，原值不截断。</p>
  {!supported&&<p role="note">当前版本档案尚不支持五库 v6 业务导出；完整备份能力继续可用，不会自动迁移。</p>}
  <label className="business-export-source"><input type="checkbox" checked={includeSourceText} disabled={busy}
   onChange={event=>{void cancel();setIncludeSourceText(event.target.checked);}}/>同时包含已导入原文 source_json（可能包含机构自由文本，请先自行核对）</label>
  <div className="retry-actions"><button type="button" className="secondary" disabled={busy||!supported} onClick={()=>void prepare()}>预览全部业务数据</button></div>
  {busy&&<p role="status">正在处理业务导出，请等待结果。开始写出后请勿关闭应用。</p>}
  {notice&&<p role="status">{notice}</p>}{failure&&<p role="alert" className="notice failure">{failure}</p>}
  {preview&&<div className="business-export-preview">
   <h3>确认本次全量导出</h3>
   <p>学生 {preview.students} 名 · 业务及历史记录 {preview.rows} 行 · 五库 {preview.tables.length} 表范围已登记。</p>
   <p>快照截至 {new Date(preview.capturedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}；此后保存的记录不自动加入，请重新预览刷新。预览于 {new Date(preview.expiresAt).toLocaleTimeString("zh-CN",{hour12:false})} 失效。</p>
   <p>{preview.includeSourceText?"本次包含导入原文。请将导出文件作为私人业务资料妥善保管。":"本次不包含 intake_jobs.source_json 导入原文；其余已确认业务和来源身份保留。"} 三类内部状态仅列数量，不导出正文；完整恢复请用上方完整备份。</p>
   <details><summary>查看 24 表映射、记录数及排除项</summary><div className="business-export-table"><table><thead><tr><th>库 / 原表</th><th>Excel 表</th><th>源行数</th><th>输出行数</th><th>实体 / 历史行</th><th>范围说明</th></tr></thead><tbody>
    {preview.tables.map(row=><tr key={row.store+row.table}><td>{row.store} / {row.table}</td><td>{row.role==="internal"?"仅范围说明":row.sheet}</td><td>{row.sourceRows}</td><td>{row.exportedRows}</td><td>{row.entities} / {row.historicalRows}</td><td>{row.reason}</td></tr>)}
   </tbody></table></div></details>
   <div className="retry-actions"><button type="button" className="primary" disabled={busy} onClick={()=>void write()}>确认范围并选择保存位置</button><button type="button" className="secondary" disabled={busy} onClick={()=>void cancel()}>取消导出预览</button></div>
  </div>}
  {result&&<div role="status" className="notice success"><h3>业务数据导出已完成并读回校验</h3><p>{result.location}</p><p>共 {result.rows} 行业务及历史记录；{result.files.length} 个文件；{result.longTextCells} 个文本单元格使用分片保真。具体范围和排除项见 export-manifest.json。</p>
   <ul>{result.files.map(file=><li key={file.name}>{file.name} · {file.bytes.toLocaleString("zh-CN")} bytes</li>)}</ul>
   <p className="muted">仅 export.complete 与清单摘要一致的目录才是完整结果。请在本机用 Excel 或 WPS 打开核对，勿将真实学生数据附到公开仓库。</p></div>}
 </section>;
}
