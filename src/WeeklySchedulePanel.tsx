import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { AttendancePlan, Failure, LearningDayInput, ScheduleSaveInput, Student, WorkspaceApi } from "./contracts";
import { attendanceCounts, minute, mondayOf, openingHours, shanghaiMinute, shanghaiParts, shiftDate, weekday, weekRange, type ScheduleHours } from "./schedule-calendar";
import type { ScheduleConfiguration } from "./recurring-schedule";
import { RecurringSchedulePanel } from "./RecurringSchedulePanel";
import { AttendanceLearningPanel } from "./AttendanceLearningPanel";
import { usePendingOperation } from "./use-pending-operation";
import "./weekly-schedule.css";

const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const statuses: Record<AttendancePlan["status"], string> = {
  planned: "待确认", confirmed: "已确认", attended: "已到校", absent: "缺席", cancelled: "已取消",
};
const attendanceLabel = (plan: AttendancePlan) => plan.checkOutAt === null ? statuses[plan.status] : "已签退";

interface Draft {
  id: string;
  studentId: string;
  date: string;
  start: string;
  end: string;
  kind: AttendancePlan["kind"];
  confirmed: boolean;
  reason: string;
  original?: AttendancePlan;
}

const canEdit = (plan: AttendancePlan) =>
  plan.startAt > Date.now() && (plan.status === "planned" || plan.status === "confirmed");

function toDraft(plan: AttendancePlan): Draft {
  const from = shanghaiParts(plan.startAt);
  return {
    id: plan.id, studentId: plan.studentId, date: from.date, start: from.time, end: shanghaiParts(plan.endAt).time,
    kind: plan.kind, confirmed: plan.exceptionReason !== null, reason: plan.exceptionReason ?? "", original: plan,
  };
}

function windowsOf(date: string, schedule?: ScheduleHours) {
  if (schedule) return schedule[weekday(date)];
  const legacy = openingHours(date);
  return legacy ? [legacy] : [];
}

function defaults(date: string, kind: Draft["kind"], schedule?: ScheduleHours) {
  const hours = windowsOf(date, schedule)[0];
  const start = hours?.start ?? "16:00";
  return { start, end: kind === "whole_day" ? hours?.end ?? "18:00"
    : shanghaiParts(shanghaiMinute(date, start)! + 120 * minute).time };
}

function nextDefaultDate(week: string, schedule?: ScheduleHours): string {
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index));
  return days.find(date => windowsOf(date, schedule).some(slot => (shanghaiMinute(date, slot.start) ?? 0) > now)) ??
    Array.from({ length: 7 }, (_, index) => shiftDate(shanghaiParts(now).date, index + 1))
      .find(date => windowsOf(date, schedule).length > 0) ?? shiftDate(shanghaiParts(now).date, 1);
}

function outsideHours(draft: Draft, schedule?: ScheduleHours): boolean {
  if (shanghaiMinute(draft.date, draft.start) === null || shanghaiMinute(draft.date, draft.end) === null) return false;
  return !windowsOf(draft.date, schedule).some(slot => draft.start >= slot.start && draft.end <= slot.end);
}

function exceptionText(draft: Draft, schedule?: ScheduleHours): string {
  const hours = windowsOf(draft.date, schedule);
  return hours.length ? "当天开放时段为 " + hours.map(slot => slot.start + "–" + slot.end).join("、") + "。"
    : "当天未配置营业时段。";
}

export function WeeklySchedulePanel({ api, recurringEnabled, students, studentId, setStudentId, learning, learningBackLabel,
  onLearning, onExitLearning, learningLeaveGuard, onStudent, summary }: {
  api: WorkspaceApi; recurringEnabled: boolean; students: Student[]; studentId: string; setStudentId: (id: string) => void;
  learning?: LearningDayInput & { focusTaskId?: string }; learningBackLabel?: string;
  onLearning: (target: LearningDayInput, trigger: HTMLButtonElement) => void;
  onExitLearning: () => void; learningLeaveGuard: Ref<() => boolean>;
  onStudent: (studentId: string, trigger: HTMLButtonElement) => boolean;
  summary: ReactNode;
}) {
  const today = shanghaiParts(Date.now()).date;
  const [week, setWeek] = useState(() => mondayOf(today));
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<"week" | "day">("day");
  const [queryRevision, setQueryRevision] = useState(0);
  const [configuration, setConfiguration] = useState<ScheduleConfiguration>();
  const [listing, setListing] = useState<{ key: string; rows?: AttendancePlan[]; error?: string }>();
  const [draft, setDraft] = useState<Draft>();
  const [draftDirty, setDraftDirty] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "failure" | "pending"; message: string }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const submission = useRef<ScheduleSaveInput | undefined>(undefined);
  const [learningRevision, setLearningRevision] = useState(0);
  const [confirmedLearningRequest, setConfirmedLearningRequest] = useState<string>();
  const request = usePendingOperation(api, (saved, requestId) => {
    if (saved?.command === "saveAttendancePlan") {
      selectDay(shanghaiParts(saved.startAt).date);
      showDraft(undefined);
    }
    refresh();
    setConfirmedLearningRequest(requestId);
    setLearningRevision(value => value + 1);
  });
  const [latest, setLatest] = useState<AttendancePlan>();
  const formRef = useRef<HTMLFormElement>(null);
  // Refresh the same list in place so the originating course button can receive focus.
  const queryKey = week + "/" + studentId;
  const current = listing?.key === queryKey ? listing : undefined;

  useEffect(() => {
    let mounted = true;
    api.scheduleWeek({ monday: week, studentId: studentId || undefined }).then(result => {
      if (mounted) setListing(result.ok ? { key: queryKey, rows: result.value } : { key: queryKey, error: result.message });
    }).catch(() => {
      if (mounted) setListing({ key: queryKey, error: "无法读取本周排课，请重试。" });
    });
    return () => { mounted = false; };
  }, [api, queryKey, queryRevision, studentId, week, learning]);

  useEffect(() => {
    if (!recurringEnabled) return;
    let current = true;
    api.scheduleConfiguration().then(result => { if (current && result.ok) setConfiguration(result.value); }).catch(() => undefined);
    return () => { current = false; };
  }, [api, recurringEnabled, queryRevision]);

  function refresh() { setQueryRevision(value => value + 1); }

  function canDiscard(): boolean {
    if (inFlight.current || request.busy) return false;
    return !draftDirty || window.confirm("本次排课有未保存的修改。确定放弃吗？");
  }

  function showDraft(next: Draft | undefined) {
    setDraft(next);
    setDraftDirty(false);
    setLatest(undefined);
    submission.current = undefined;
    setNotice(undefined);
    if (next) requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: "nearest" }));
  }

  function newDraft() {
    if (!canDiscard()) return;
    const desired = shanghaiMinute(day, defaults(day, "regular", configuration?.hours).start);
    const date = mode === "day" && desired !== null && desired > Date.now() ? day : nextDefaultDate(week, configuration?.hours);
    showDraft({ id: crypto.randomUUID(), studentId: studentId || students[0]?.id || "", date,
      ...defaults(date, "regular", configuration?.hours), kind: "regular", confirmed: false, reason: "" });
  }

  function updateDraft(fields: Partial<Draft>) {
    if (inFlight.current || request.blocked) return;
    setDraft(previous => previous && { ...previous, ...fields });
    setDraftDirty(true);
    setNotice(undefined);
    submission.current = undefined;
  }

  function changeWindow(fields: Partial<Pick<Draft, "date" | "start" | "end" | "kind">>) {
    if (!draft) return;
    updateDraft({ ...fields, confirmed: false, reason: draft.reason });
  }

  function showFailure(result: Failure) {
    if (result.code !== "unknown") setNotice({ kind: "failure", message: result.message });
    else setNotice(undefined);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || inFlight.current || request.blocked || latest || (draft.original && !canEdit(draft.original))) return;
    const startAt = shanghaiMinute(draft.date, draft.start);
    const endAt = shanghaiMinute(draft.date, draft.end);
    if (startAt === null || endAt === null || startAt >= endAt) {
      setNotice({ kind: "failure", message: "请填写有效日期和时段，结束须晚于开始。" });
      return;
    }
    const exception = outsideHours(draft, configuration?.hours);
    if (exception && (!draft.confirmed || !draft.reason.trim())) {
      setNotice({ kind: "failure", message: "请确认本次时段例外并填写原因。" });
      return;
    }
    const command = submission.current ?? {
      requestId: crypto.randomUUID(), id: draft.id, studentId: draft.studentId,
      expectedRevision: draft.original?.revision ?? 0, startAt, endAt, kind: draft.kind,
      exception: exception ? { confirmed: true, reason: draft.reason.trim() } : undefined,
    };
    submission.current = command;
    inFlight.current = true;
    setBusy(true);
    setNotice({ kind: "pending", message: "正在保存排课…" });
    try {
      const result = await request.run({ ...command, command: "saveAttendancePlan" });
      if (result.ok) {
        selectDay(shanghaiParts(command.startAt).date);
        if (studentId && studentId !== result.value.studentId) setStudentId(result.value.studentId);
        showDraft(undefined);
        setNotice({ kind: "success", message: "排课已保存。" });
        refresh();
      } else {
        showFailure(result);
        if (result.code === "conflict") {
          refresh();
          if (draft.original) {
            const row = await api.schedulePlan(draft.id).catch(() => undefined);
            if (row?.ok && row.value && row.value.revision !== draft.original.revision) setLatest(row.value);
          }
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function selectDay(date: string) {
    if (shanghaiMinute(date, "00:00") === null) return;
    const monday = mondayOf(date);
    if (!weekRange(monday)) return;
    setDay(date);
    setWeek(monday);
  }

  const names = new Map(students.map(student => [student.id, student.alias]));
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index));
  const plansByDay = new Map(days.map(date => [date, [] as AttendancePlan[]]));
  for (const plan of current?.rows ?? []) plansByDay.get(shanghaiParts(plan.startAt).date)?.push(plan);
  const hasMonday = Boolean(plansByDay.get(week)?.length || configuration?.hours[1].length);
  const shownDays = mode === "day" ? [day] : hasMonday ? days : days.slice(1);
  const listed = attendanceCounts(shownDays.flatMap(date => plansByDay.get(date) ?? []));
  const readOnly = Boolean(draft?.original && !canEdit(draft.original));
  const exception = draft && outsideHours(draft, configuration?.hours);

  return <>
    {(request.state?.kind === "pending" || request.state?.kind === "damaged" || request.issue || request.message) &&
      <aside className="schedule-recovery notice pending" aria-label="待核对教务请求">
        {request.descriptor && <p>待核对请求 <code>{request.descriptor.requestId}</code> · {names.get(request.descriptor.studentId)}</p>}
        {request.state?.kind === "damaged" && <p role="alert">原请求内容无法恢复，写入已暂停。请在周课表和当日学习面板查看已保存的出勤、学习块与任务结果。</p>}
        {(request.message || request.issue) && <p role="status">{request.issue || request.message}</p>}
        <div className="retry-actions">
          {request.descriptor && <button className="secondary" type="button" disabled={request.busy}
            onClick={() => void request.recover("read")}>查询原请求</button>}
          {request.state?.kind === "pending" && <button className="secondary" type="button" disabled={request.busy}
            onClick={() => void request.recover("retry")}>重试同一请求</button>}
          {request.state?.kind === "damaged" && request.descriptor && <button className="secondary" type="button" disabled={request.busy}
            onClick={() => {
              if (window.confirm("你已在周课表或当日学习面板核对实际记录，并确认结束这个待核对请求吗？"))
                void request.recover("reviewed");
            }}>已核对数据库，结束待核对</button>}
          {request.issue && <button className="secondary" type="button" disabled={request.busy}
            onClick={() => void request.hydrate()}>重新读取待核对状态</button>}
        </div>
      </aside>}
    {learning && <AttendanceLearningPanel key={learning.attendanceId} api={api} target={learning} alias={names.get(learning.studentId) ?? "待核对学生"}
      reloadVersion={learningRevision} confirmedRequestId={confirmedLearningRequest}
      blocked={request.blocked} submit={request.run}
      leaveGuard={learningLeaveGuard} backLabel={learningBackLabel} focusTaskId={learning.focusTaskId}
      onBack={onExitLearning} />}
    <section className="schedule-page" aria-labelledby="schedule-title" hidden={Boolean(learning)}
      data-profile-switch-draft={draftDirty || busy ? "" : undefined}>
    <header className="schedule-heading">
      <div>
        <h1 id="schedule-title" tabIndex={-1}>全局总课表</h1>
        <p className="muted">机构时间（上海） · 周一默认停排</p>
      </div>
      <button type="button" className="primary schedule-primary" disabled={!students.length || busy || request.blocked} onClick={newDraft}>新建单次排课</button>
    </header>
    {summary}
    {recurringEnabled && <RecurringSchedulePanel api={api} configuration={configuration} students={students} week={week}
      studentId={studentId} blocked={busy || request.blocked} onChanged={refresh} />}
    <div className="schedule-toolbar">
      <div className="schedule-period">
        <div className="schedule-buttons" aria-label="课表视图">
          <button className="secondary" type="button" aria-pressed={mode === "week"} onClick={() => setMode("week")}>周视图</button>
          <button className="secondary" type="button" aria-pressed={mode === "day"} onClick={() => setMode("day")}>日视图</button>
        </div>
        {mode === "week"
          ? <strong aria-live="polite">{week.replaceAll("-", ".")} – {days[6].replaceAll("-", ".")}</strong>
          : <label>课表日期<input type="date" value={day} onChange={event => selectDay(event.target.value)} /></label>}
        <div className="schedule-buttons">
          <button className="secondary" type="button" onClick={() => selectDay(shiftDate(day, mode === "week" ? -7 : -1))}>{mode === "week" ? "上一周" : "前一天"}</button>
          <button className="secondary" type="button" onClick={() => selectDay(today)}>{mode === "week" ? "本周" : "今天"}</button>
          <button className="secondary" type="button" onClick={() => selectDay(shiftDate(day, mode === "week" ? 7 : 1))}>{mode === "week" ? "下一周" : "后一天"}</button>
        </div>
      </div>
      <label className="schedule-filter">筛选学生
        <select value={studentId} onChange={event => setStudentId(event.target.value)}>
          <option value="">全部学生</option>
          {students.map(student => <option key={student.id} value={student.id}>{student.alias}</option>)}
        </select>
      </label>
    </div>
    {notice && <div className={"notice " + notice.kind} role={notice.kind === "failure" ? "alert" : "status"}>
      {notice.message}
    </div>}
    {draft && <form className="panel schedule-form" ref={formRef} onSubmit={event => void save(event)} aria-label="排课表单">
      <div className="schedule-form-heading">
        <h2>{readOnly ? "排课详情" : draft.original ? "修改单次排课" : "新建单次排课"}</h2>
        {draft.original && <span className="muted">{attendanceLabel(draft.original)}</span>}
      </div>
      {readOnly && <p className="muted">已开始或已结束的排课只供查看。</p>}
      {latest && <div className="notice pending" role="alert">
        <p>当前版本已变更。最新安排为 {shanghaiParts(latest.startAt).date} {shanghaiParts(latest.startAt).time}–{shanghaiParts(latest.endAt).time}，{latest.kind === "whole_day" ? "全天" : "普通"}，{attendanceLabel(latest)}。</p>
        <p>最新时段外例外原因：{latest.exceptionReason ?? "无"}</p>
        {canEdit(latest) ? <button className="secondary" type="button" onClick={() => {
          updateDraft({ original: latest, confirmed: false });
          setLatest(undefined);
        }}>已核对，保留输入并继续</button> :
          <p>当前安排已锁定，请关闭表单后查看最新记录。</p>}
      </div>}
      <fieldset className="schedule-fields" disabled={readOnly || busy || request.blocked || Boolean(latest)}>
        <label>学生
          <select required disabled={Boolean(draft.original)} value={draft.studentId} onChange={event => updateDraft({ studentId: event.target.value })}>
            {students.map(student => <option key={student.id} value={student.id}>{student.alias}</option>)}
          </select>
        </label>
        <label>到校日期<input required type="date" value={draft.date} onChange={event => {
          const date = event.target.value;
          changeWindow({ date, ...(!draft.original && shanghaiMinute(date, "00:00") !== null ? defaults(date, draft.kind) : {}) });
        }} /></label>
        <label>开始时间<input required type="time" value={draft.start} onChange={event => changeWindow({ start: event.target.value })} /></label>
        <label>结束时间<input required type="time" value={draft.end} onChange={event => changeWindow({ end: event.target.value })} /></label>
        <label>到校类型
          <select value={draft.kind} onChange={event => {
            const kind = event.target.value === "whole_day" ? "whole_day" : "regular";
            changeWindow({ kind, ...(!draft.original && shanghaiMinute(draft.date, "00:00") !== null ? defaults(draft.date, kind) : {}) });
          }}>
            <option value="regular">普通</option><option value="whole_day">全天</option>
          </select>
        </label>
        {exception && <div className="schedule-exception">
          <p>{exceptionText(draft, configuration?.hours)}</p>
          <label className="schedule-check"><input type="checkbox" checked={draft.confirmed}
            onChange={event => updateDraft({ confirmed: event.target.checked })} />确认仅本次例外</label>
          <label>例外原因<input value={draft.reason} maxLength={500}
            onChange={event => updateDraft({ reason: event.target.value })} /></label>
        </div>}
      </fieldset>
      <div className="schedule-buttons">
        {!readOnly && <button type="submit" className="primary schedule-primary" disabled={busy || request.blocked || Boolean(latest)}>
          保存排课
        </button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          if (canDiscard()) showDraft(undefined);
        }}>{readOnly ? "关闭详情" : "关闭表单"}</button>
      </div>
    </form>}
    {!current && <p className="schedule-read-state muted" role="status">正在读取本周排课…</p>}
    {current?.error && <div className="notice failure" role="alert">
      {current.error} <button type="button" className="secondary" onClick={refresh}>重新读取</button>
    </div>}
    {current?.rows && <p className="muted schedule-counts" aria-live="polite">
      排课 {listed.students} 人 · {listed.visits} 人次（含取消）
    </p>}
    <div className={"schedule-days" + (mode === "day" ? " schedule-single-day" : hasMonday ? " schedule-days-extra" : "")}>
      {shownDays.map(date => {
        const day = weekday(date);
        const hours = openingHours(date);
        const plans = plansByDay.get(date)!;
        return <section key={date} className={"schedule-day" + (day === 0 || day === 6 ? " schedule-weekend" : "")}
          aria-label={dayNames[day] + " " + date}>
          <header className="schedule-day-heading" aria-current={date === today ? "date" : undefined}>
            <h2>{dayNames[day]} <time dateTime={date}>{date.slice(5).replace("-", "/")}</time></h2>
            <p>{hours ? hours.start + "–" + hours.end : "周一默认停排 · 仅显示例外"}</p>
          </header>
          {current?.rows && (plans.length ? <ul className="schedule-card-list">{plans.map(plan => {
            const start = shanghaiParts(plan.startAt).time;
            const end = shanghaiParts(plan.endAt).time;
            const alias = names.get(plan.studentId) ?? "待核对学生";
            return <li key={plan.id} className="schedule-card-item" data-kind={plan.kind} data-exception={Boolean(plan.exceptionReason)}>
              <button type="button" disabled={busy} className="schedule-card"
                aria-label={alias + " " + start + "–" + end + " " + attendanceLabel(plan) + " · 排课详情"} onClick={() => {
                  if (canDiscard()) showDraft(toDraft(plan));
                }}>
                <span className="schedule-card-time">{start}–{end}</span>
                <strong>{alias}</strong>
                <span className="schedule-card-meta">{plan.cycleKind === "long_term" ? "长期在校" : plan.cycleKind === "fixed" ? "固定到课" : plan.kind === "whole_day" ? "全天" : "单次"} · {attendanceLabel(plan)}</span>
                {plan.exceptionReason && <span className="schedule-card-exception">时段例外</span>}
              </button>
              <div className="schedule-card-actions">
                <button className="primary schedule-learning-entry" type="button" disabled={busy || request.busy}
                  aria-label={"进入学习 · " + alias + " " + start + "–" + end} onClick={event => {
                    if (!canDiscard()) return;
                    showDraft(undefined);
                    onLearning({ attendanceId: plan.id, studentId: plan.studentId }, event.currentTarget);
                  }}>进入学习</button>
                <button className="schedule-profile-link" type="button" disabled={busy || request.busy || !names.has(plan.studentId)}
                  aria-label={"查看学生档案 · " + alias} onClick={event => {
                    if (canDiscard() && onStudent(plan.studentId, event.currentTarget)) showDraft(undefined);
                  }}>学生档案</button>
              </div>
            </li>;
          })}</ul> : <p className="schedule-empty muted">无排课</p>)}
        </section>;
      })}
    </div>
    </section>
  </>;
}
