import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Result, WorkspaceApi } from "./contracts";
import { lifecycleLabels, type LifecycleChange, type LifecycleInput, type LifecycleStatus, type LifecycleView } from "./student-lifecycle";
import type { StudentWriteResolution } from "./StudentWriteRecoveryPanel";

const timestamp = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" });

export function StudentLifecyclePanel({ api, studentId, onSaved, onActivity, refreshRecovery, resolution }: {
  api: WorkspaceApi; studentId: string;
  onSaved: (change: LifecycleChange) => void;
  onActivity: (dirty: boolean, busy: boolean) => void;
  refreshRecovery: () => void; resolution?: StudentWriteResolution;
}) {
  const [loaded, setLoaded] = useState<Result<LifecycleView>>();
  const [refresh, setRefresh] = useState(0);
  const [target, setTarget] = useState<LifecycleStatus | "">("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<LifecycleInput>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const running = useRef(false);

  useEffect(() => {
    let current = true;
    api.studentLifecycle(studentId).then(reply => {
      if (current) setLoaded(reply.ok && reply.value.studentId !== studentId
        ? { ok: false, code: "recovery", message: "跟进记录与当前学生不一致。" } : reply);
    }).catch(() => { if (current) setLoaded({ ok: false, code: "failed", message: "无法读取跟进状态。" }); });
    return () => { current = false; };
  }, [api, studentId, refresh, resolution]);

  useEffect(() => {
    onActivity(Boolean(target || reason), busy || Boolean(pending));
    return () => onActivity(false, false);
  }, [onActivity, target, reason, busy, pending]);

  useEffect(() => {
    if (pending && resolution && (resolution.action === "archive" || resolution.requestId === pending.requestId)) {
      setPending(undefined); setTarget(""); setReason(""); setMessage("");
    }
  }, [pending, resolution]);

  async function save(input: LifecycleInput) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      const reply = await api.saveStudentLifecycle(input);
      if (reply.ok && reply.value.studentId === studentId && reply.value.requestId === input.requestId
          && reply.value.revision === input.expectedRevision + 1 && reply.value.status === input.status) {
        onSaved(reply.value);
        const confirmation = await api.resolveStudentWrite("confirm", input.requestId);
        if (!confirmation.ok) { setPending(input); setMessage(confirmation.message); }
        else { setPending(undefined); setTarget(""); setReason(""); setMessage("跟进状态已更新。"); }
        setRefresh(value => value + 1);
      } else if (reply.ok || reply.code === "unknown") {
        setPending(input); setMessage("保存结果待核对，请在上方查看原请求。");
      } else {
        setMessage(reply.message);
        if (reply.code === "conflict") setRefresh(value => value + 1);
      }
    } catch {
      setPending(input);
      setMessage("保存回执未确认，请在上方核对原请求。");
    } finally {
      running.current = false;
      setBusy(false);
      refreshRecovery();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || !loaded?.ok || !reason.trim() || pending) return;
    void save({ studentId, status: target, reason, expectedRevision: loaded.value.revision, requestId: crypto.randomUUID() });
  }

  if (!loaded) return <p role="status">正在读取跟进状态…</p>;
  if (!loaded.ok) return <div role="alert">{loaded.message} <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></div>;
  const { status, history } = loaded.value;
  return <section className="panel student-records" aria-label="跟进状态">
    <h2>跟进状态</h2>
    <p>当前为 <strong>{lifecycleLabels[status]}</strong>。暂停和归档后，原有排课、到校安排、学习任务及跟进提醒继续保留。</p>
    <form className="parent-follow-up-form" data-profile-switch-draft={target || reason ? true : undefined} onSubmit={submit}>
      <fieldset disabled={busy || Boolean(pending)}>
        <legend>变更跟进状态</legend>
        <label>目标状态<select required value={target} onChange={event => setTarget(event.target.value as LifecycleStatus | "")}>
          <option value="">选择状态</option>
          {(Object.keys(lifecycleLabels) as LifecycleStatus[]).filter(item => item !== status).map(item =>
            <option key={item} value={item}>{item === "active" ? "恢复正常跟进" : lifecycleLabels[item]}</option>)}
        </select></label>
        <label>变更原因<textarea required value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" className="primary">保存跟进状态</button>
      </fieldset>
    </form>
    {pending && <button type="button" disabled={busy} onClick={() => void save(pending)}>用原编号重试</button>}
    {message && <p role="status">{message}</p>}
    <h3>状态历史</h3>
    {history.length ? <ol className="student-source-list">{history.map(row => <li key={row.requestId}>
      <time dateTime={new Date(row.changedAt).toISOString()}>{timestamp.format(row.changedAt)}</time>
      <strong>{lifecycleLabels[row.previousStatus]} → {lifecycleLabels[row.status]}</strong>
      <p>{row.reason}</p>
    </li>)}</ol> : <p className="muted">尚未发生状态变更。</p>}
  </section>;
}
