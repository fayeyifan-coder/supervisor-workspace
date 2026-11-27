import { useRef, useState } from "react";
import type { Student, WorkspaceApi } from "./contracts";
import { shanghaiParts } from "./schedule-calendar";
import { defaultSigninSlots, signinLabels, signinSourceLabels, weekendGroupingLabels, type SigninChange,
  type SigninKind, type SigninPreview, type WeekendGrouping } from "./signin-calendar";

export function SigninSheetPanel({ api, students, studentId, day }: {
  api: WorkspaceApi; students: Student[]; studentId: string; day: string;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SigninKind>("weekday");
  const [period, setPeriod] = useState("");
  const [slots, setSlots] = useState(defaultSigninSlots);
  const [includePendingFlex, setIncludePendingFlex] = useState(true);
  const [weekendGrouping, setWeekendGrouping] = useState<WeekendGrouping>("start");
  const [result, setResult] = useState<{ preview: SigninPreview; key: string }>();
  const [edits, setEdits] = useState<SigninChange[]>([]);
  const [adding, setAdding] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const inFlight = useRef(false);
  const candidates = students.filter(student => !studentId || student.id === studentId);
  const aliases = new Map(students.map(student => [student.id, student.alias]));
  const today = shanghaiParts(Date.now()).date;
  const selected = period || (kind === "weekday" ? day : (day || today).slice(0, 7));
  const visible = result?.preview.input.studentId === (studentId || undefined) && result?.preview.input.period === selected ? result : undefined;
  const preview = visible?.preview;
  function invalidate() { setResult(undefined); setEdits([]); setAdding({}); setNotice(undefined); }
  function mark(change: SigninChange) {
    setEdits(previous => [...previous.filter(row => row.group !== change.group || row.date !== change.date || row.studentId !== change.studentId), change]);
  }
  async function operate(action: "preview" | "export") {
    if (inFlight.current || !selected) return;
    inFlight.current = true; setBusy(true); setNotice(undefined);
    try {
      if (action === "preview") {
        invalidate();
        const response = await api.previewSignin({kind, period: selected, slots: kind === "weekday" ? [] : slots, studentId: studentId || undefined,
          ...(kind === "weekday" ? {includePendingFlex} : {weekendGrouping})});
        if (!response.ok) setNotice({ message: response.message, error: true });
        else setResult(response.value);
      } else if (visible) {
        const response = await api.exportSignin({input: visible.preview.input, key: visible.key, changes: edits});
        if (!response.ok) setNotice({ message: response.message, error: true });
        else if (response.value) setNotice({ error: false, message:
          `已保存 ${response.value.names} 行名单、${response.value.slots} 个预计签名位置。文件位于 ${response.value.location}` });
      }
    } catch {
      setNotice({message: "无法完成签到表操作。请先核对目标文件，再重试。", error: true});
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="panel signin-panel" aria-label="签到表">
    <div className="schedule-form-heading"><h2>签到表</h2>
      <button type="button" className="secondary" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
        {open ? "收起签到表" : "生成签到表"}</button>
    </div>
    {open && <div data-profile-switch-draft={edits.length || busy ? "" : undefined}>
      <fieldset className="schedule-fields" disabled={busy}>
        <label>签到表类型<select value={kind} onChange={event => { setKind(event.target.value as SigninKind); setPeriod(""); invalidate(); }}>
          {Object.entries(signinLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {kind === "weekday" ? <label>所在周日期<input type="date" value={selected} onChange={event => { setPeriod(event.target.value); invalidate(); }} /></label>
          : <label>月份<input type="month" value={selected} onChange={event => { setPeriod(event.target.value); invalidate(); }} /></label>}
      </fieldset>
      {kind === "weekday" ? <label className="schedule-check"><input type="checkbox" checked={includePendingFlex} disabled={busy}
        onChange={event => { setIncludePendingFlex(event.target.checked); invalidate(); }} />包含未确认弹性学生</label>
        : <fieldset className="schedule-fields" disabled={busy}><legend>打印时段</legend>
          <label>周末名单归组<select value={weekendGrouping} onChange={event => {
            setWeekendGrouping(event.target.value as WeekendGrouping); invalidate();
          }}>{Object.entries(weekendGroupingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {slots.map((slot, index) =>
        <div className="schedule-buttons" key={index}>
          {(["start", "end"] as const).map(field => <label key={field}>{field === "start" ? "开始" : "结束"} {index + 1}<input type="time"
            value={slot[field]} onChange={event => {
              const value = event.target.value;
              setSlots(previous => previous.map((item, i) => i === index ? { ...item, [field]: value } : item)); invalidate();
            }} /></label>)}
        </div>)}</fieldset>}
      <p className="muted">{kind === "weekday"
        ? "弹性候选只预留签名位置，预约和考勤由各自记录确认。"
        : "按覆盖时段可把一段到课列入所有与之重叠的打印时段。"} 名单调整仅用于本次打印，签名栏留空。</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void operate("preview")}>预览预计签到名单</button>
      {preview && <div className="signin-preview">
        {preview.warnings.length > 0 && <details><summary>有 {preview.warnings.length} 条安排需人工核对</summary><ul>
          {preview.warnings.map((row, index) => <li key={index}>{row.date} {row.time} · {row.alias} · {row.reason}</li>)}</ul></details>}
        {preview.groups.map((group, index) => {
          const selection = edits.filter(row => row.group === index);
          const ids = [...new Set([...group.members.map(member => member.studentId), ...selection.map(change => change.studentId)])];
          return <section key={group.label} className="signin-group" aria-label={group.label}>
            <h3>{group.label}</h3>
            <div className="signin-table" tabIndex={0} aria-label={group.label + "签名名单"}>
              <table>
                <thead><tr><th scope="col">学生</th>{preview.dates.map(date => <th scope="col" key={date}>{date.slice(5)}</th>)}</tr></thead>
                <tbody>{ids.map(id => <tr key={id}><th scope="row">{aliases.get(id) ?? "待核对学生"}</th>
                  {preview.dates.map(date => {
                    const sources = group.members.find(member => member.studentId === id)?.days.find(day => day.date === date)?.sources;
                    const checked = selection.find(row => row.studentId === id && row.date === date)?.include ?? Boolean(sources);
                    const label = checked ? (sources ?? ["manual"] as const).map(source => signinSourceLabels[source]).join("、") : "";
                    return <td key={date}><input type="checkbox" disabled={busy}
                      aria-label={(aliases.get(id) ?? "") + " " + date + " 预留签名" + (label ? " · " + label : "")}
                      checked={checked} onChange={event => mark({group: index, studentId: id, date, include: event.target.checked})} />
                      {label && <small className="signin-source muted">{label}</small>}</td>;
                  })}</tr>)}</tbody>
              </table>
              {!ids.length && <p className="muted">该时段暂无预计名单。</p>}
            </div>
            <div className="schedule-buttons"><label>补入打印名单<select disabled={busy} value={adding[index] ?? ""}
              onChange={event => setAdding(previous => ({ ...previous, [index]: event.target.value }))}>
              <option value="">请选择学生</option>{candidates.filter(student => !ids.includes(student.id)).map(student =>
                <option key={student.id} value={student.id}>{student.alias}</option>)}
            </select></label>
              <button type="button" disabled={busy || !adding[index]} onClick={() => {
                mark({group: index, studentId: adding[index], date: preview.dates[0], include: false});
                setAdding(previous => ({ ...previous, [index]: "" }));
              }}>添加待勾选学生</button>
            </div>
          </section>;
        })}
        <button type="button" className="primary" disabled={busy} onClick={() => void operate("export")}>选择模板并导出 XLSX</button>
      </div>}
      {notice && <p className={"notice " + (notice.error ? "failure" : "success")} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
    </div>}
  </section>;
}
