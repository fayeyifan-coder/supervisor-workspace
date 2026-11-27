import { useRef, useState } from "react";
import type { Student, WorkspaceApi } from "./contracts";
import type { CycleCommand, CycleDefinition, CycleRule, ScheduleConfiguration } from "./recurring-schedule";
import { shiftDate, type ScheduleHours } from "./schedule-calendar";

const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekdays = [1, 2, 3, 4, 5, 6, 0];
const nameOf = (kind: CycleDefinition["kind"]) => kind === "long_term" ? "长期在校" : "固定到课";
const slot = () => ({ id: crypto.randomUUID(), day: 2, start: "09:00", end: "10:30" });
type RuleDraft = { id: string; studentId: string; revision: number; definition: CycleDefinition };

export function RecurringSchedulePanel({ api, configuration, students, week, studentId, blocked, onChanged }: {
  api: WorkspaceApi; configuration: ScheduleConfiguration | undefined; students: Student[];
  week: string; studentId: string; blocked: boolean; onChanged: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>();
  const [hoursText, setHoursText] = useState<string[]>();
  const [range, setRange] = useState<{ week: string; from: string; to: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean }>();
  const inFlight = useRef(false);
  const previous = useRef<{ key: string; id: string }>(undefined);
  if (!configuration) return <p className="muted">正在读取周期排课。<button type="button" onClick={onChanged}>重试</button></p>;
  const filtered = configuration.rules.filter(rule => !studentId || rule.studentId === studentId);
  const displayed = filtered.filter((rule, i) => i === 0 || filtered[i - 1].id !== rule.id);
  const names = new Map(students.map(student => [student.id, student]));
  const chosen = range?.week === week ? range : { week, from: week, to: shiftDate(week, 6) };
  const locked = busy || blocked;
  function requestKey(input: unknown): string {
    const key = JSON.stringify(input);
    if (previous.current?.key !== key) previous.current = { key, id: crypto.randomUUID() };
    return previous.current.id;
  }

  async function change(input: CycleCommand) {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true); setNotice(undefined);
    try {
      const reply = await api.changeCycleSchedule(input);
      if (!reply.ok) { setNotice({ text: reply.message, bad: true }); return; }
      previous.current = undefined;
      const value = reply.value;
      if (value.action === "rule") {
        setDraft(undefined);
        setNotice({ text: "周期规则已保存。已生成的单日安排保留。", bad: false });
      } else if (value.action === "hours") {
        setHoursText(undefined);
        setNotice({ text: "营业时间已保存。", bad: false });
      } else {
        const { created, existing, inactive, conflicts, elapsed } = value.result;
        setNotice({ text: `已生成 ${created} 次 · 已有 ${existing} 次 · 暂停或归档 ${inactive} 次 · 冲突或时段外 ${conflicts} 次 · 已过时段 ${elapsed} 次`, bad: conflicts > 0 });
      }
    } catch { setNotice({ text: "保存结果待确认。请先重新读取，再用相同输入重试。", bad: true }); }
    finally { inFlight.current = false; setBusy(false); onChanged(); }
  }
  function edit(rule?: CycleRule) {
    if (rule) {
      const { id, studentId, revision, changedAt: _changedAt, ...definition } = rule;
      setDraft({ id, studentId, revision, definition });
    } else {
      const target = studentId || students.find(row => row.lifecycleStatus === "active")?.id || "";
      setDraft({ id: crypto.randomUUID(), studentId: target, revision: 0,
        definition: { kind: "fixed", startsOn: week, endsOn: null, paused: false, slots: [slot()] } });
    }
  }
  function update(fields: Partial<CycleDefinition>) {
    setDraft(current => current && ({ ...current, definition: { ...current.definition, ...fields } }));
  }
  function saveHours() {
    const hoursRevision = configuration!.hoursRevision;
    const hours: ScheduleHours = hoursText!.map(text => text.trim() ? text.split(/[,，]/).map(value => {
      const [start, end] = value.trim().split(/[-–—]/).map(part => part.trim());
      return { start, end };
    }) : []);
    const data = { action: "hours" as const, expectedRevision: hoursRevision, hours };
    void change({ ...data, requestId: requestKey(data) });
  }

  return <details className="panel recurring-panel" data-profile-switch-draft={draft || hoursText || busy ? "" : undefined}>
    <summary>周期排课与营业时段</summary>
    <div className="schedule-buttons">
      <button type="button" className="secondary" disabled={locked || Boolean(draft) || !students.length} onClick={() => edit()}>新建周期规则</button>
      <button type="button" className="secondary" disabled={locked || Boolean(hoursText)} onClick={() =>
        setHoursText(configuration.hours.map(row => row.map(period => period.start + "–" + period.end).join("，")))}>配置营业时段</button>
    </div>
    <div className="recurring-generate">
      <label>生成起日<input type="date" value={chosen.from} onChange={event => setRange({ ...chosen, from: event.target.value })} /></label>
      <label>生成止日<input type="date" value={chosen.to} onChange={event => setRange({ ...chosen, to: event.target.value })} /></label>
      <button type="button" className="primary" disabled={locked || !chosen.from || !chosen.to} onClick={() =>
        void change({ action: "generate", from: chosen.from, to: chosen.to, studentId: studentId || undefined })}>生成单日安排</button>
    </div>
    <p className="muted">按当前学生筛选生成，单次最多 31 天。修改规则用于尚未生成的日期。调整已生成的安排请进入对应的单次排课。</p>
    {notice && <p className={notice.bad ? "notice failure" : "muted"} role={notice.bad ? "alert" : "status"}>{notice.text}</p>}
    {hoursText && <form className="recurring-editor" onSubmit={event => { event.preventDefault(); saveHours(); }}>
      <fieldset disabled={locked}>
        <legend>机构营业时段</legend>
        <p className="muted">用 09:00–12:00 格式填写，多个时段用逗号分隔。休息日留空。</p>
        {weekdays.map(day => <label key={day}>{days[day]}<input value={hoursText[day]} placeholder="休息"
          onChange={event => { const value = event.target.value; setHoursText(current => current?.map((prior, i) => i === day ? value : prior)); }} /></label>)}
        <button type="submit">保存营业时段</button>
        <button type="button" className="secondary" onClick={() => setHoursText(undefined)}>取消</button>
      </fieldset>
    </form>}
    {draft && <form className="recurring-editor" onSubmit={event => {
      event.preventDefault();
      const data = { action: "rule" as const, id: draft.id, studentId: draft.studentId, expectedRevision: draft.revision, definition: draft.definition };
      void change({ ...data, requestId: requestKey(data) });
    }}>
      <fieldset disabled={locked}>
        <legend>{draft.revision ? "编辑周期规则" : "新建周期规则"}</legend>
        <div className="recurring-generate">
          <label>学生<select required value={draft.studentId} disabled={Boolean(draft.revision)} onChange={event => {
            const studentId = event.target.value;
            setDraft(current => current && { ...current, studentId });
          }}><option value="">请选择</option>{students.map(row => <option key={row.id} value={row.id}>{row.alias}</option>)}</select></label>
          <label>类型<select value={draft.definition.kind} onChange={event => update({ kind: event.target.value as CycleDefinition["kind"] })}>
            <option value="fixed">固定到课</option><option value="long_term">长期在校</option>
          </select></label>
          <label>生效日期<input type="date" required value={draft.definition.startsOn} onChange={event => update({ startsOn: event.target.value })} /></label>
          <label>结束日期（可选）<input type="date" value={draft.definition.endsOn ?? ""} onChange={event => update({ endsOn: event.target.value || null })} /></label>
        </div>
        <label className="schedule-check"><input type="checkbox" checked={draft.definition.paused} onChange={event => update({ paused: event.target.checked })} />暂停规则</label>
        {draft.definition.slots.map((row, index) => {
          const editSlot = (fields: Partial<typeof row>) => update({ slots: draft.definition.slots.map(item => item.id === row.id ? { ...item, ...fields } : item) });
          return <div className="recurring-generate" key={row.id}>
            <label>星期<select value={row.day} onChange={event => editSlot({ day: Number(event.target.value) })}>
              {weekdays.map(day => <option value={day} key={day}>{days[day]}</option>)}
            </select></label>
            <label>起时<input type="time" required value={row.start} onChange={event => editSlot({ start: event.target.value })} /></label>
            <label>止时<input type="time" required value={row.end} onChange={event => editSlot({ end: event.target.value })} /></label>
            <button type="button" className="secondary" disabled={draft.definition.slots.length === 1} aria-label={`移除第 ${index + 1} 个时段`}
              onClick={() => update({ slots: draft.definition.slots.filter(item => item.id !== row.id) })}>移除</button>
          </div>;
        })}
        <div className="schedule-buttons">
          <button type="button" className="secondary" disabled={draft.definition.slots.length >= 42}
            onClick={() => update({ slots: [...draft.definition.slots, slot()] })}>添加时段</button>
          <button type="submit" className="primary">保存规则</button>
          <button type="button" className="secondary" onClick={() => setDraft(undefined)}>取消</button>
        </div>
      </fieldset>
    </form>}
    {displayed.length === 0 ? <p className="muted">尚无周期规则。</p> : <ul className="student-source-list">
      {displayed.map(rule => {
        const student = names.get(rule.studentId);
        const history = filtered.filter(item => item.id === rule.id);
        return <li key={rule.id}>
          <div className="student-source-heading"><strong>{student?.alias ?? "待核对学生"} · {nameOf(rule.kind)}</strong>
            {(rule.paused || student?.lifecycleStatus !== "active") && <span>暂停生成，已有安排待人工核对</span>}
            <button type="button" className="secondary" disabled={locked || Boolean(draft)} onClick={() => edit(rule)}>编辑规则</button>
          </div>
          <p>{rule.startsOn} 至 {rule.endsOn ?? "长期"}</p>
          <p>{rule.slots.map(item => `${days[item.day]} ${item.start}–${item.end}`).join("、")}</p>
          <details><summary>修订历史（{history.length}）</summary><ol>{history.map(item => <li key={item.revision}>
            第 {item.revision} 版 · {new Date(item.changedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {nameOf(item.kind)} ·
            {item.paused ? "暂停" : "启用"} · {item.startsOn} 至 {item.endsOn ?? "长期"} ·
            {item.slots.map(period => `${days[period.day]} ${period.start}–${period.end}`).join("、")}
          </li>)}</ol></details>
        </li>;
      })}
    </ul>}
  </details>;
}
