import { useEffect, useState, type FormEvent } from "react";
import type { Student, WorkspaceApi } from "./contracts";
import type { WorkChange, WorkItem, WorkItemInput } from "./worklog";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function WorkLogPanel({ students, api }: { students: Student[]; api: WorkspaceApi }) {
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [history, setHistory] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<WorkItem>();
  const [changes, setChanges] = useState<WorkChange[]>([]);
  const [editing, setEditing] = useState<WorkItem>();
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const day = today();
  const refresh = () => {
    api.workItems(day).then(r => { if (r.ok) setRows(r.value); else setNotice(r.message); });
    api.searchWorkItems("0001-01-01", day, query).then(r => { if (r.ok) setHistory(r.value); else setNotice(r.message); });
  };
  useEffect(() => { refresh(); }, [api, day, query]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: WorkItemInput = {
      id: editing?.id ?? draftId,
      title: String(data.get("title")), workDate: String(data.get("workDate")),
      studentId: String(data.get("studentId") || "") || null,
      startedAt: String(data.get("startedAt")), notes: String(data.get("notes")), nextStep: String(data.get("nextStep")),
    };
    const result = await api.saveWorkItem(input);
    if (!result.ok) { setNotice(result.message); return; }
    setNotice("工作记录已保存在本机。"); setEditing(undefined); setDraftId(crypto.randomUUID()); refresh();
  }
  async function status(item: WorkItem, next: "open" | "done" | "cancelled") {
    const result = await api.setWorkItemStatus(item.id, next);
    setNotice(result.ok ? "状态已更新。" : result.message); refresh();
  }
  async function showHistory(item: WorkItem) {
    const result = await api.workHistory(item.id);
    if (!result.ok) { setNotice(result.message); return; }
    setSelected(item); setChanges(result.value);
    setNotice(`修改历史：${result.value.length} 条`);
  }
  return <section className="panel worklog" aria-labelledby="worklog-heading">
    <h2 id="worklog-heading">每日工作日志</h2>
    <p className="muted">独立本地数据库；不包含在 M2-A 备份中。</p>
    {notice && <p role="status" className="worklog-notice">{notice}</p>}
    <form key={editing?.id ?? draftId} onSubmit={submit}>
      <fieldset>
        <div className="field-grid">
          <label className="wide">工作事项<input name="title" maxLength={160} required defaultValue={editing?.title ?? ""} /></label>
          <label>工作日期<input name="workDate" type="date" required defaultValue={editing?.workDate ?? day} /></label>
          <label>关联学生<select name="studentId" defaultValue={editing?.studentId ?? ""}><option value="">不关联</option>
            {students.map(student => <option key={student.id} value={student.id}>{student.alias}</option>)}</select></label>
          <label>执行时间<input name="startedAt" type="datetime-local" defaultValue={editing?.startedAt ?? ""} /></label>
          <label className="wide">备注<textarea name="notes" maxLength={1000} rows={2} defaultValue={editing?.notes ?? ""} /></label>
          <label className="wide">下一步跟进<textarea name="nextStep" maxLength={500} rows={2} defaultValue={editing?.nextStep ?? ""} /></label>
        </div>
        <button className="primary" type="submit">{editing ? "保存修改" : "创建工作事项"}</button>
        {editing && <button className="secondary" type="button" onClick={() => setEditing(undefined)}>取消修改</button>}
      </fieldset>
    </form>
    <h3>今日待办与到期未完成</h3>
    {!rows.length ? <p className="muted">目前没有到期未完成事项。</p> : <ul className="work-items">{rows.map(item => <li key={item.id}>
      <strong>{item.title}</strong><span>{item.workDate} · {item.status}{item.studentId ? ` · ${students.find(s => s.id === item.studentId)?.alias ?? "已关联学生"}` : ""}</span>
      <p>{item.notes}</p>{item.nextStep && <p>下一步：{item.nextStep}</p>}
      <div className="work-actions"><button className="secondary" onClick={() => setEditing(item)}>修改</button>
        <button className="secondary" onClick={() => void status(item, "done")}>完成</button>
        <button className="secondary" onClick={() => void status(item, "cancelled")}>取消事项</button>
        <button className="secondary" onClick={() => void showHistory(item)}>修改历史</button></div>
      {item.completedAt && <time>完成于 {new Date(item.completedAt).toLocaleString()}</time>}
      {selected?.id === item.id && <ol className="change-list">{changes.map(change => <li key={change.id}>
        {new Date(change.changedAt).toLocaleString()} · {change.snapshot.status} · {change.snapshot.title}
        {change.snapshot.notes && <p>{change.snapshot.notes}</p>}
      </li>)}</ol>}
    </li>)}</ul>}
    <h3>历史查询</h3>
    <label>筛选标题或备注<input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <ul className="work-items">{history.map(item => <li key={item.id}><strong>{item.title}</strong>
      <span>{item.workDate} · {item.status}{item.completedAt ? ` · 完成 ${new Date(item.completedAt).toLocaleString()}` : ""}</span>
      <button className="secondary" onClick={() => setEditing(item)}>修改</button></li>)}</ul>
  </section>;
}
