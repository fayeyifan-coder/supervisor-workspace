import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Result, Student, StudentEditFields, StudentEditInput, StudentEditView, WorkspaceApi } from "./contracts";

const fields = [
  { name: "alias", label: "学生代号", limit: 40, required: true },
  { name: "grade", label: "年级", limit: 30, required: true },
  { name: "subjects", label: "学科", limit: 100, required: true },
  { name: "goal", label: "基础学习目标", limit: 300, required: false },
  { name: "notes", label: "备注", limit: 500, required: false },
] as const;
const dates = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium" });
const values = ({ alias, grade, subjects, goal, notes }: Student): StudentEditFields => ({ alias, grade, subjects, goal, notes });
type Draft = Pick<StudentEditInput, "expectedRevision" | "fields">;

function FieldList({ data }: { data: StudentEditFields }) {
  return <dl>{fields.map(({ name, label }) => <div key={name}><dt>{label}</dt><dd>{data[name] || "未填写"}</dd></div>)}</dl>;
}

export function StudentEditPanel({ studentId, api, onSaved, onDirtyChange, onBusyChange }: {
  studentId: string; api: WorkspaceApi; onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [read, setRead] = useState<{ refresh: number; result: Result<StudentEditView> }>();
  const [draft, setDraft] = useState<Draft>();
  const [attempt, setAttempt] = useState<StudentEditInput>();
  const [notice, setNotice] = useState<{ kind: "failure" | "pending" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const result = read?.refresh === refresh ? read.result : undefined;
  const view = result?.ok ? result.value : undefined;
  const pending = view?.pending;
  const confirmed = pending && view?.history.some(record => record.requestId === pending.requestId);
  const stale = view && draft && draft.expectedRevision !== view.revision;
  const dirty = Boolean(draft && JSON.stringify(draft.fields) !== JSON.stringify(view && values(view.student)));

  useEffect(() => {
    let current = true;
    const readFailure: Result<StudentEditView> = { ok: false, code: "failed", message: "无法读取基础档案修改记录。" };
    api.studentEdit(studentId).then(result => {
      if (!current) return;
      if (result.ok && (result.value.student.id !== studentId ||
          (result.value.pending && result.value.pending.studentId !== studentId))) {
        setRead({ refresh, result: { ok: false, code: "recovery", message: "基础档案与当前学生不一致。" } });
      } else {
        setRead({ refresh, result });
      }
    }).catch(() => { if (current) setRead({ refresh, result: readFailure }); });
    return () => { current = false; };
  }, [api, studentId, refresh]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  function reread() { setRefresh(value => value + 1); }

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setNotice(undefined);
    try { await operation(); }
    catch { setNotice({ kind: "pending", text: "结果尚未确认。正在读取本机保存状态。" }); }
    finally {
      reread();
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  function save(input: StudentEditInput) {
    setAttempt(input);
    void run(async () => {
      const reply = await api.saveStudentEdit(input);
      if (!reply.ok) {
        setNotice({ kind: reply.code === "unknown" ? "pending" : "failure", text: reply.message });
        return;
      }
      setDraft(undefined);
      setAttempt(undefined);
      onSaved();
      const ended = await api.finishStudentEdit({ studentId, requestId: input.requestId }).catch(() => undefined);
      setNotice({ kind: "success", text: ended?.ok ? "基础档案已保存。" : "基础档案已保存。请核对是否仍有待处理请求。" });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !view || stale || pending || busy || !dirty) return;
    const same = attempt?.expectedRevision === draft.expectedRevision && JSON.stringify(attempt.fields) === JSON.stringify(draft.fields);
    save(same ? attempt : { ...draft, studentId, requestId: crypto.randomUUID() });
  }

  function finish(discard: boolean) {
    if (!pending || (discard && !window.confirm("确认放弃这笔尚未提交的修改？"))) return;
    void run(async () => {
      const reply = await api.finishStudentEdit({ studentId, requestId: pending.requestId, discard });
      if (!reply.ok) { setNotice({ kind: "failure", text: reply.message }); return; }
      setAttempt(undefined);
      setDraft(undefined);
      if (!discard) onSaved();
      setNotice({ kind: "success", text: discard ? "已放弃待提交修改。" : "已确认保存结果。" });
    });
  }

  return <section className="panel student-edit" aria-labelledby="student-edit-heading">
    <div className="student-overview-heading">
      <div><h2 id="student-edit-heading">基础档案编辑</h2>
        {view && <p className="muted">当前版本 {view.revision}</p>}</div>
      <button type="button" className="secondary" disabled={busy} onClick={reread}>重新读取基础档案</button>
    </div>
    {!result && <p role="status" className="muted">正在读取基础档案…</p>}
    {result && !result.ok && <p className="notice failure" role="alert">读取失败。{result.message}</p>}
    {notice && <p className={"notice " + notice.kind} role={notice.kind === "failure" ? "alert" : "status"}>{notice.text}</p>}
    {pending && <section className="notice pending" aria-label="待核对的学生修改">
      <h3>{confirmed ? "原请求已保存，待确认" : "原请求尚未提交"}</h3>
      <p>请求编号 <code>{pending.requestId}</code></p>
      <details><summary>查看原请求内容</summary><FieldList data={pending.fields} /></details>
      <div className="retry-actions">
        {confirmed ? <button type="button" className="secondary" disabled={busy} onClick={() => finish(false)}>确认保存结果</button> : <>
          <button type="button" className="primary" disabled={busy} onClick={() => save(pending)}>重试同一修改请求</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => finish(true)}>放弃待提交修改</button>
        </>}
      </div>
    </section>}
    {!draft && view && !pending && <button type="button" className="primary" disabled={busy}
      onClick={() => { setNotice(undefined); setDraft({ expectedRevision: view.revision, fields: values(view.student) }); }}>修改基础档案</button>}
    {draft && <form onSubmit={submit}>
      {stale && <section className="notice pending" role="alert">
        <h3>档案已更新至版本 {view.revision}</h3>
        <FieldList data={values(view.student)} />
        <button type="button" className="secondary" disabled={busy || Boolean(pending)}
          onClick={() => { setAttempt(undefined); setDraft({ ...draft, expectedRevision: view.revision }); }}>核对后保留输入，采用此版本</button>
      </section>}
      <fieldset className="field-grid" disabled={!view || busy || Boolean(pending)}>
        {fields.map(({ name, label, limit, required }) => {
          const common = { value: draft.fields[name], maxLength: limit, required,
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setDraft({ ...draft, fields: { ...draft.fields, [name]: event.target.value } }) };
          return name === "goal" || name === "notes" ? <label className="wide" key={name}>{label}<textarea rows={2} {...common} /></label>
            : <label key={name}>{label}<input {...common} /></label>;
        })}
      </fieldset>
      <div className="student-edit-actions">
        <button type="submit" className="primary" disabled={!view || !dirty || busy || Boolean(pending || stale)}>保存基础修改</button>
        <button type="button" className="secondary" disabled={busy || Boolean(pending)} onClick={() => {
          if (dirty && !window.confirm("确认放弃本次未保存的输入？")) return;
          setDraft(undefined); setAttempt(undefined);
        }}>取消编辑</button>
      </div>
    </form>}
    {view && <section className="student-edit-history" aria-labelledby="student-edit-history-heading">
      <h3 id="student-edit-history-heading">基础档案修改历史</h3>
      {view.history.length === 0 ? <p className="muted">尚无修改记录。</p>
        : <ol>{view.history.map(record => <li key={record.requestId}>
          <details>
            <summary>版本 {record.revision} · <time dateTime={new Date(record.changedAt).toISOString()}>{dates.format(record.changedAt)}</time></summary>
            <p className="muted">请求编号 <code>{record.requestId}</code></p>
            <div className="student-edit-comparison">
              <div><h4>修改前</h4><FieldList data={record.before} /></div>
              <div><h4>修改后</h4><FieldList data={record.after} /></div>
            </div>
          </details>
        </li>)}</ol>}
    </section>}
  </section>;
}
