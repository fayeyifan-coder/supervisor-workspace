import { useRef, useState } from "react";
import type { AttendancePlan, Student, WorkspaceApi } from "./contracts";
import type { CycleCommand, FlexWindow } from "./recurring-schedule";
import { shanghaiMinute, shanghaiParts } from "./schedule-calendar";

function useArrivalChange(api: WorkspaceApi, blocked: boolean, onSaved: (plan: AttendancePlan, button: HTMLButtonElement, actual: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const inFlight = useRef(false);
  async function commit(input: CycleCommand, button: HTMLButtonElement, actual: boolean) {
    if (blocked || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailure("");
    try {
      const result = await api.changeCycleSchedule(input);
      if (!result.ok) setFailure(result.message);
      else if (result.value.action === "visit") onSaved(result.value.plan, button, actual);
      else setFailure("返回的到课结果与当前操作不一致。");
    } catch { setFailure("到课结果待核对。请先刷新，再按原输入重试。"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return { commit, busy, failure };
}

export function FlexibleWindowCard({ api, window, alias, blocked, onSaved }: {
  api: WorkspaceApi; window: FlexWindow; alias: string; blocked: boolean;
  onSaved: (plan: AttendancePlan, button: HTMLButtonElement, actual: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState("");
  const { commit, busy, failure } = useArrivalChange(api, blocked, onSaved);
  const now = Date.now(), first = shanghaiMinute(window.date, window.start)!, last = shanghaiMinute(window.date, window.end)!;
  return <li className="schedule-card-item flex-window" data-profile-switch-draft={editing || busy ? "" : undefined}>
    <strong>{alias}</strong>
    <span>{window.start}–{window.end} · 弹性窗口 · 预计 {window.durationMinutes} 分钟</span>
    <span className="muted">{now < last ? "待确认具体到课时段" : "窗口已过，未记录到课事实"}</span>
    <div className="schedule-buttons">
      {editing ? <>
        <label>预约开始<input type="time" value={start} min={window.start} max={window.end} onChange={event => setStart(event.target.value)} /></label>
        <button type="button" disabled={blocked || busy || !start} onClick={event =>
          void commit({ action: "confirmFlex", window, start }, event.currentTarget, false)}>保存具体预约</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>取消输入</button>
      </> : <button type="button" className="secondary" disabled={blocked || busy || now >= last}
        onClick={() => setEditing(true)}>确认预约时间</button>}
      <button type="button" className="secondary" disabled={blocked || busy || now < first || now >= last}
        onClick={event => void commit({ action: "arriveFlex", window }, event.currentTarget, true)}>实际到课并签到</button>
    </div>
    {failure && <p role="alert" className="notice failure">{failure}</p>}
  </li>;
}

export function WalkInForm({ api, students, initial, blocked, onSaved }: {
  api: WorkspaceApi; students: Student[]; initial?: string; blocked: boolean;
  onSaved: (plan: AttendancePlan, button: HTMLButtonElement, actual: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [studentId, setStudentId] = useState("");
  const [duration, setDuration] = useState("120");
  const cached = useRef<{ input: string; requestId: string }>(undefined);
  const { commit, busy, failure } = useArrivalChange(api, blocked, (plan, button, actual) => {
    setEditing(false); cached.current = undefined; onSaved(plan, button, actual);
  });
  return <div className="recurring-generate" data-profile-switch-draft={editing || busy ? "" : undefined}>
    {!editing ? <button type="button" className="secondary" disabled={blocked || !students.length}
      onClick={() => { setStudentId(initial || ""); setEditing(true); }}>当日临时到课</button> : <>
      <label>实际到课学生<select value={studentId} onChange={event => setStudentId(event.target.value)}>
        <option value="">请选择</option>{students.map(student => <option key={student.id} value={student.id}>{student.alias}</option>)}
      </select></label>
      <label>预计学习分钟<input type="number" value={duration} min={15} max={480} onChange={event => setDuration(event.target.value)} /></label>
      <button type="button" className="primary" disabled={blocked || busy || !studentId || !/^\d+$/.test(duration) || Number(duration) < 15 || Number(duration) > 480} onClick={event => {
        const input = studentId + "/" + duration;
        if (cached.current?.input !== input) cached.current = { input, requestId: crypto.randomUUID() };
        void commit({ action: "walkIn", requestId: cached.current.requestId, studentId, durationMinutes: Number(duration) }, event.currentTarget, true);
      }}>现在签到</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>取消</button>
      <span className="muted">机构日期 {shanghaiParts(Date.now()).date}</span>
    </>}
    {failure && <p role="alert" className="notice failure">{failure}</p>}
  </div>;
}
