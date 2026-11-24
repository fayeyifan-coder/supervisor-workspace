import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Result, WorkspaceApi } from "./contracts";
import { enrollmentStatus, studentRecordDefinitions, type RecordField, type StudentRecord, type StudentRecordInput,
  type StudentRecordKind, type StudentRecordView } from "./student-records";
import type { StudentWriteResolution } from "./StudentWriteRecoveryPanel";
import { shanghaiParts } from "./schedule-calendar";

export function StudentRecordsPanel({ api, studentId, kind, onActivity, overview, after, fixedFields, filter, onRecoveryChange, recoveryResolution }: {
  api: WorkspaceApi; studentId: string; kind: StudentRecordKind;
  onActivity: (kind: StudentRecordKind, dirty: boolean, busy: boolean) => void;
  overview?: (records: StudentRecord[]) => ReactNode;
  after?: (records: StudentRecord[]) => ReactNode;
  fixedFields?: Record<string, string>;
  filter?: (record: StudentRecord) => boolean;
  onRecoveryChange: () => void; recoveryResolution?: StudentWriteResolution;
}) {
  const definition = studentRecordDefinitions[kind];
  const fields: readonly RecordField[] = definition.fields;
  const [today, setToday] = useState(() => shanghaiParts(Date.now()).date);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ refresh: number; result: Result<StudentRecordView> }>();
  const [recordsForDetails, setRecordsForDetails] = useState<StudentRecord[]>([]);
  const [draft, setDraft] = useState<StudentRecordInput>();
  const [pending, setPending] = useState<StudentRecordInput>();
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const refreshDay = () => setToday(shanghaiParts(Date.now()).date);
    const timer = window.setInterval(refreshDay, 60_000);
    window.addEventListener("focus", refreshDay);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshDay); };
  }, []);
  useEffect(() => {
    let live = true;
    api.studentRecords(kind, studentId).then(result => {
      if (!live) return;
      if (result.ok && (result.value.studentId !== studentId || result.value.records.some(row => row.studentId !== studentId))) {
        setLoaded({ refresh, result: { ok: false, code: "recovery", message: "记录与当前学生不一致。" } });
      } else {
        if (result.ok) setRecordsForDetails(result.value.records);
        setLoaded({ refresh, result });
      }
    }).catch(() => {
      if (live) setLoaded({ refresh, result: { ok: false, code: "failed", message: "读取学生记录失败。" } });
    });
    return () => { live = false; };
  }, [api, kind, studentId, refresh]);
  useEffect(() => {
    onActivity(kind, Boolean(draft), busy || Boolean(pending));
    return () => onActivity(kind, false, false);
  }, [kind, onActivity, draft, busy, pending]);

  useEffect(() => {
    if (!recoveryResolution) return;
    setRefresh(value => value + 1);
    if (pending && (recoveryResolution.action === "archive" || pending.requestId === recoveryResolution.requestId)) {
      setPending(undefined);
      setDraft(undefined);
      setMessage("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryResolution]);

  const result = loaded?.refresh === refresh ? loaded.result : undefined;
  const records = result?.ok ? result.value.records.filter(row => !filter || filter(row)) : [];
  const current = records.find(row => row.id === draft?.id);

  function start(row?: StudentRecord) {
    setConflict(false);
    setMessage("");
    const defaults = Object.fromEntries(fields.map(field => [field.key, field.options?.[0] ?? (field.type === "date" && !field.optional ? today : "")]));
    setDraft({ kind, studentId, id: row?.id ?? crypto.randomUUID(), requestId: crypto.randomUUID(),
      expectedRevision: row?.revision ?? 0, fields: row?.fields ?? { ...defaults, ...fixedFields } });
  }

  async function save(input: StudentRecordInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const reply = await api.saveStudentRecord(input);
      if (reply.ok && reply.value.studentId === studentId && reply.value.id === input.id &&
          reply.value.requestId === input.requestId && reply.value.revision === input.expectedRevision + 1) {
        setDraft(undefined);
        setPending(undefined);
        setConflict(false);
        setMessage("保存成功。");
        await api.resolveStudentWrite("confirm", input.requestId).catch(() => undefined);
        setRefresh(value => value + 1);
      } else if (reply.ok || reply.code === "unknown" || (pending && reply.code === "busy")) {
        setPending(input);
        setMessage("保存结果待核对。可使用原请求编号重试。若数据库暂时被锁定，重开后请先查看已保存记录。");
      } else {
        setPending(undefined);
        setMessage(reply.message);
        if (reply.code === "conflict") {
          setConflict(true);
          setRefresh(value => value + 1);
        }
      }
    } catch {
      setPending(input);
      setMessage("保存回执未收到。请使用原请求编号重试。");
    } finally {
      setBusy(false);
      inFlight.current = false;
      onRecoveryChange();
    }
  }

  return <section className="panel student-records" aria-label={definition.label}>
    <div className="student-source-heading">
      <h2>{definition.label}</h2>
      {result?.ok && <button type="button" disabled={Boolean(draft)} onClick={() => start()}>新增{definition.item}</button>}
    </div>
    {message && <p role="status">{message}</p>}
    {!result ? <p role="status">正在读取…</p>
      : !result.ok ? <div className="notice failure" role="alert"><p>{result.message}</p>
        <button type="button" className="secondary" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>
      : <>
        {overview?.(result.value.records)}
        {records.length === 0 && <p className="muted">尚无{definition.item}记录。</p>}
        <ul className="student-source-list">
          {records.map(row => <li key={row.id}>
            <div className="student-source-heading"><h3>{row.fields[fields[0].key]}</h3>
              {kind === "enrollment" && <strong className="student-source-status">{enrollmentStatus(row.fields, today)}</strong>}
              <button type="button" className="secondary" disabled={Boolean(draft)} onClick={() => start(row)}>编辑</button>
            </div>
            <dl>{fields.slice(1).filter(field => row.fields[field.key] && field.key !== "planId").map(field =>
              <div key={field.key}><dt>{field.label}</dt><dd>{row.fields[field.key]}</dd></div>)}</dl>
          </li>)}
        </ul>
      </>}
    {draft && <form className="parent-follow-up-form" onSubmit={event => {
      event.preventDefault();
      if (!pending && !conflict) void save(draft);
    }}>
      <fieldset disabled={busy || Boolean(pending)}>
        <legend>{draft.expectedRevision ? "编辑" : "新增"}{definition.item}</legend>
        {fields.filter(field => !fixedFields || !Object.hasOwn(fixedFields, field.key)).map(field => {
          const control = { name: field.key, value: draft.fields[field.key], required: !field.optional };
          function update(event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
            const value = event.currentTarget.value;
            setDraft(current => current && { ...current, fields: { ...current.fields, [field.key]: value } });
          }
          return <label key={field.key}>{field.label}
            {field.options ? <select {...control} onChange={update}>{field.options.map(option => <option key={option}>{option}</option>)}</select>
              : field.type === "textarea" ? <textarea {...control} onChange={update} maxLength={field.limit ?? 1000} />
                : <input {...control} onChange={update} type={field.type ?? "text"} maxLength={field.limit ?? 1000} step="any" />}
          </label>;
        })}
      </fieldset>
      {pending ? <div>
        <p>请求编号 <code>{pending.requestId}</code></p>
        <button type="button" disabled={busy} onClick={() => void save(pending)}>用原编号重试</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>重新读取已保存记录</button>
      </div> : <div>
        <button type="submit" disabled={busy || conflict}>保存{definition.item}</button>
        {conflict && current && <button type="button" className="secondary" onClick={() => {
          setDraft({ ...draft, expectedRevision: current.revision, requestId: crypto.randomUUID() });
          setConflict(false);
          setMessage("");
        }}>核对后使用当前版本 {current.revision}</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          setDraft(undefined); setConflict(false); setMessage("");
        }}>取消编辑</button>
      </div>}
    </form>}
    {after?.(recordsForDetails)}
  </section>;
}
