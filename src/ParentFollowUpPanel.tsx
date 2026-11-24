import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ParentConcernHistory, ParentConcernInput, ParentFollowUpInput, ParentFollowUpView } from "./parent-follow-up";
import { parentCategories, parentRoles, parentStatuses } from "./parent-follow-up";
import type { Result, WorkspaceApi } from "./contracts";
import type { StudentWriteResolution } from "./StudentWriteRecoveryPanel";
import { shanghaiParts } from "./schedule-calendar";

type Draft = { kind: "concern" } | { kind: "follow-up"; concernId: string; revision: number };
type Command = { kind: "concern"; input: ParentConcernInput } | { kind: "follow-up"; input: ParentFollowUpInput };

function Options({ labels }: { labels: Record<string, string> }) {
  return <>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
}

export function ParentFollowUpPanel({ studentId, api, onDirtyChange, onBusyChange, onRecoveryChange, recoveryResolution }: {
  studentId: string; api: WorkspaceApi;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onRecoveryChange: () => void; recoveryResolution?: StudentWriteResolution;
}) {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ refresh: number; result: Result<ParentFollowUpView> }>();
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<Command>();
  const [notice, setNotice] = useState<{ kind: "failure" | "pending" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const result = loaded?.refresh === refresh ? loaded.result : undefined;
  const view = result?.ok ? result.value : undefined;
  const selected = draft?.kind === "follow-up" ? view?.concerns.find(row => row.requestId === draft.concernId) : undefined;
  const latest = selected?.followUps[0];
  const latestRevision = latest?.revision ?? 0;
  const stale = draft?.kind === "follow-up" && (!selected || draft.revision !== latestRevision);

  useEffect(() => {
    let current = true;
    const invalid: Result<ParentFollowUpView> = { ok: false, code: "recovery", message: "家长诉求与所选学生不一致。" };
    api.parentFollowUp(studentId).then(result => {
      if (!current) return;
      if (result.ok && (result.value.studentId !== studentId || result.value.concerns.some(row =>
        row.studentId !== studentId || row.followUps.some(item => item.studentId !== studentId || item.concernId !== row.requestId)))) {
        setLoaded({ refresh, result: invalid });
      } else {
        setLoaded({ refresh, result });
      }
    }).catch(() => {
      if (current) setLoaded({ refresh, result: { ok: false, code: "failed", message: "无法读取家长诉求，请重试。" } });
    });
    return () => { current = false; };
  }, [api, studentId, refresh]);

  useEffect(() => { onDirtyChange(Boolean(draft)); }, [draft, onDirtyChange]);

  useEffect(() => {
    if (!pending || !view) return;
    const id = pending.input.requestId;
    const found = pending.kind === "concern" ? view.concerns.find(row => row.requestId === id)
      : view.concerns.find(row => row.requestId === pending.input.concernId)?.followUps.find(item => item.requestId === id);
    if (!found) return;
    const matches = Object.entries(pending.input).every(([key, value]) => key === "expectedRevision"
      ? "revision" in found && found.revision === Number(value) + 1
      : Reflect.get(found, key) === (key === "concern" || key === "note" ? String(value).trim() : value));
    setPending(undefined);
    if (!matches) {
      setNotice({ kind: "failure", text: "该请求编号的已存内容不一致。请核对原记录。" });
      return;
    }
    setDraft(undefined);
    setNotice({ kind: "success", text: "已从本机记录确认保存结果。" });
  }, [pending, view]);

  useEffect(() => {
    if (!recoveryResolution) return;
    setRefresh(value => value + 1);
    if (pending && (recoveryResolution.action === "archive" || pending.input.requestId === recoveryResolution.requestId)) {
      setPending(undefined);
      setDraft(undefined);
      setNotice(undefined);
    }
    // This signal is sent only when a recovery action finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryResolution]);

  const reread = () => setRefresh(value => value + 1);

  async function save(command: Command) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setNotice(undefined);
    try {
      const reply = command.kind === "concern" ? await api.createParentConcern(command.input)
        : await api.appendParentFollowUp(command.input);
      if (reply.ok) {
        setPending(undefined); setDraft(undefined);
        setNotice({ kind: "success", text: "已保存到本机。" });
        await api.resolveStudentWrite("confirm", command.input.requestId).catch(() => undefined);
      } else {
        setPending(reply.code === "unknown" ? command : undefined);
        setNotice({ kind: reply.code === "unknown" ? "pending" : "failure", text: reply.message });
      }
    } catch {
      setPending(command);
      setNotice({ kind: "pending", text: "保存状态待确认。请核对或重试原请求。" });
    } finally {
      reread();
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
      onRecoveryChange();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !draft || stale || pending || busy) return;
    const form = new FormData(event.currentTarget);
    const input = (key: string) => String(form.get(key) ?? "");
    const common = { studentId, requestId: crypto.randomUUID(), nextOn: input("nextOn") };
    if (draft.kind === "concern") {
      void save({ kind: draft.kind, input: { ...common, reportedOn: input("on"), role: input("role") as ParentConcernInput["role"],
        category: input("category") as ParentConcernInput["category"], concern: input("detail") } });
    } else {
      void save({ kind: draft.kind, input: { ...common, concernId: draft.concernId, expectedRevision: draft.revision,
        followedOn: input("on"), status: input("status") as ParentFollowUpInput["status"], note: input("detail") } });
    }
  }

  function openFollowUp(row: ParentConcernHistory) {
    setNotice(undefined);
    setDraft({ kind: "follow-up", concernId: row.requestId, revision: row.followUps[0]?.revision ?? 0 });
  }

  const today = shanghaiParts(Date.now()).date;
  const lastOn = latest?.followedOn ?? selected?.reportedOn;
  const formDate = lastOn && lastOn > today ? lastOn : today;

  return <section className="panel parent-follow-up" aria-labelledby="parent-follow-up-heading">
    <div className="student-overview-heading">
      <h2 id="parent-follow-up-heading">家长诉求与跟进</h2>
      {view && <button type="button" className="secondary" disabled={Boolean(draft) || busy}
        onClick={() => { setNotice(undefined); setDraft({ kind: "concern" }); }}>登记诉求</button>}
    </div>
    {!result && <p role="status" className="muted">正在读取家长诉求…</p>}
    {result && !result.ok && <div role="alert" className="notice failure">读取失败。{result.message}
      <button type="button" className="secondary" onClick={reread}>重新读取</button></div>}
    {notice && <p className={"notice " + notice.kind} role={notice.kind === "failure" ? "alert" : "status"}>{notice.text}</p>}
    {pending && <div className="notice pending">
      <p>待核对请求 <code>{pending.input.requestId}</code></p>
      <div className="retry-actions">
        <button type="button" className="secondary" disabled={busy} onClick={reread}>核对已保存记录</button>
        <button type="button" className="secondary" disabled={busy || !view} onClick={() => void save(pending)}>重试原请求</button>
      </div>
    </div>}
    {draft && <form className="parent-follow-up-form" onSubmit={submit}>
      <h3>{draft.kind === "concern" ? "登记家长诉求" : "记录跟进"}</h3>
      {selected && <p className="parent-concern-text muted">{selected.concern}</p>}
      {stale && view && <div className="notice pending" role="alert">
        <p>跟进已更新。{latest && <>当前版本 {latest.revision}（{parentStatuses[latest.status]}） · {latest.note}</>}</p>
        {selected && <button type="button" className="secondary" disabled={Boolean(pending) || busy}
          onClick={() => setDraft({ ...draft, revision: latestRevision })}>核对后采用当前版本</button>}
      </div>}
      <fieldset className="field-grid" disabled={busy || !view || Boolean(pending)}>
        <label>{draft.kind === "concern" ? "诉求日期" : "跟进日期"}
          <input name="on" type="date" required min={lastOn ?? "1992-01-01"} max="9998-12-31" defaultValue={formDate} />
        </label>
        <label>下次跟进日期<input name="nextOn" type="date" min="1992-01-01" max="9998-12-31" /></label>
        {draft.kind === "concern" ? <>
          <label>来源角色<select name="role" defaultValue="" required><option value="">请选择</option><Options labels={parentRoles} /></select></label>
          <label>类别<select name="category" defaultValue="" required><option value="">请选择</option><Options labels={parentCategories} /></select></label>
        </> : <label>当前状态<select name="status" defaultValue={latest?.status ?? "open"} required><Options labels={parentStatuses} /></select></label>}
        <label className="wide">{draft.kind === "concern" ? "诉求内容" : "跟进说明"}
          <textarea name="detail" rows={3} maxLength={1000} required /></label>
      </fieldset>
      <div className="student-edit-actions">
        <button type="submit" className="primary" disabled={busy || !view || stale || Boolean(pending)}>保存记录</button>
        <button type="button" className="secondary" disabled={busy || Boolean(pending)} onClick={() => {
          if (window.confirm("确认放弃本次尚未保存的输入？")) setDraft(undefined);
        }}>取消</button>
      </div>
    </form>}
    {view && (view.concerns.length === 0 ? <p className="muted">尚未登记家长诉求。</p> :
      <ol className="parent-concern-list">{view.concerns.map(row => {
        const last = row.followUps[0];
        const nextOn = last ? last.nextOn : row.nextOn;
        return <li key={row.requestId}>
          <div className="student-source-heading">
            <h3>{parentCategories[row.category]}</h3>
            <span className="student-source-status">{parentStatuses[last?.status ?? "open"]}</span>
          </div>
          <p className="muted">{row.reportedOn} · {parentRoles[row.role]}{nextOn && " · 下次跟进 " + nextOn}</p>
          <p className="parent-concern-text">{row.concern}</p>
          <details className="growth-editor">
            <summary>跟进历史（{row.followUps.length}）</summary>
            <p className="muted">登记请求 <code>{row.requestId}</code></p>
            {row.followUps.length === 0 ? <p className="muted">暂无跟进记录。</p> :
              <ol className="parent-follow-up-history">{row.followUps.map(item => <li key={item.requestId}>
                <p>{item.followedOn} · {parentStatuses[item.status]}{item.nextOn && " · 下次跟进 " + item.nextOn}</p>
                <p className="parent-concern-text">{item.note}</p>
                <p className="muted">请求编号 <code>{item.requestId}</code></p>
              </li>)}</ol>}
          </details>
          <button type="button" className="secondary" disabled={Boolean(draft) || busy}
            onClick={() => openFollowUp(row)}>记录跟进</button>
        </li>;
      })}</ol>)}
  </section>;
}
