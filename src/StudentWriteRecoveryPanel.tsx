import { useEffect, useState } from "react";
import type { Result, Student, StudentWriteAction, StudentWriteState, WorkspaceApi } from "./contracts";

import { lifecycleLabels } from "./student-lifecycle";

export type StudentWriteResolution = { action: "confirm" | "discard" | "archive"; requestId?: string };

export function StudentWriteRecoveryPanel({ api, students, refresh, onResolved }: {
  api: WorkspaceApi; students: Student[]; refresh: number;
  onResolved: (resolution: StudentWriteResolution) => void;
}) {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<Result<StudentWriteState>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const read = () => setReload(value => value + 1);

  useEffect(() => {
    let current = true;
    api.studentWriteState().then(reply => { if (current) setResult(reply); }).catch(() => {
      if (current) setResult({ ok: false, code: "failed", message: "无法读取学生资料的保存状态。" });
    });
    return () => { current = false; };
  }, [api, refresh, reload]);

  const entry = result?.ok ? result.value : undefined;
  if (!result || (entry?.kind === "empty" && !message)) return null;
  const requestId = entry?.kind === "pending" ? entry.command.input.requestId : entry?.kind === "damaged" ? entry.requestId : undefined;
  const details = entry?.kind === "pending" ? entry.command.input : undefined;
  const student = details && students.find(item => item.id === details.studentId);
  const values: readonly [string, unknown][] = !details ? [] : "fields" in details ? Object.entries(details.fields)
    : "reason" in details ? [["跟进状态", lifecycleLabels[details.status]], ["变更原因", details.reason]]
    : "concern" in details ? [["诉求日期", details.reportedOn], ["诉求", details.concern], ["下次跟进", details.nextOn]]
      : [["跟进日期", details.followedOn], ["说明", details.note], ["下次跟进", details.nextOn]];

  async function resolve(action: StudentWriteAction) {
    if (busy) return;
    if (action === "discard" && !window.confirm("已核对该请求未保存，确定放弃原输入？")) return;
    if (action === "archive" && !window.confirm("请先查看学生档案和历史。确认已经人工核对，且保留损坏凭据后恢复写入？")) return;
    setBusy(true);
    setMessage("");
    try {
      const reply = await api.resolveStudentWrite(action, requestId);
      if (!reply.ok) setMessage(reply.message);
      else if (action !== "retry") onResolved({ action, requestId });
    } catch {
      setMessage("未收到回执，请重新查询。");
    } finally { setBusy(false); read(); }
  }

  return <aside className="notice pending student-write-recovery" aria-label="待核对学生资料请求">
    {result && !result.ok && <p role="alert">{result.message}</p>}
    {entry?.kind === "damaged" && <p role="alert">
      原请求凭据不完整，已暂停相关写入。请先查学生档案和历史。人工确认后可保留原凭据并结束待核对。
    </p>}
    {entry?.kind === "pending" && <>
      <p>{student?.alias ?? "待核对学生"} · {entry.outcome === "saved" ? "已核对到提交回执"
        : entry.outcome === "notSaved" ? "没有找到这笔请求的提交回执" : "暂时无法核对。请正常关闭重开后再查询。"}</p>
      <details><summary>查看待核对输入</summary><dl>{values.map(([key, value]) => <div key={key}>
        <dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>
    </>}
    {requestId && <p>原请求编号 <code>{requestId}</code></p>}
    {message && <p role="status">{message}</p>}
    <div className="retry-actions">
      <button type="button" className="secondary" disabled={busy} onClick={read}>核对待确认请求</button>
      {entry?.kind === "pending" && entry.outcome === "saved" && <button type="button" disabled={busy}
        onClick={() => void resolve("confirm")}>确认已保存</button>}
      {entry?.kind === "pending" && entry.outcome === "notSaved" && <>
        <button type="button" disabled={busy} onClick={() => void resolve("retry")}>重试原请求</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void resolve("discard")}>放弃未提交请求</button>
      </>}
      {entry?.kind === "damaged" && <button type="button" className="secondary" disabled={busy}
        onClick={() => void resolve("archive")}>核对后保留凭据并恢复写入</button>}
    </div>
  </aside>;
}
