import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AttendancePlan, Failure, ScheduleSaveInput, Student, WorkspaceApi } from "./contracts";
import { minute, mondayOf, openingHours, shanghaiMinute, shanghaiParts, shiftDate, weekday, weekRange } from "./schedule-calendar";
import { AttendanceLearningPanel } from "./AttendanceLearningPanel";
import { usePendingOperation } from "./use-pending-operation";
import "./weekly-schedule.css";

const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const statuses: Record<AttendancePlan["status"], string> = {
  planned: "待确认", confirmed: "已确认", attended: "已到校", absent: "缺席", cancelled: "已取消",
};

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

function defaults(date: string, kind: Draft["kind"]) {
  const hours = openingHours(date);
  const start = hours?.start ?? "16:00";
  return { start, end: kind === "whole_day" ? hours?.end ?? "18:00"
    : shanghaiParts(shanghaiMinute(date, start)! + 120 * minute).time };
}

function nextDefaultDate(week: string): string {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, index) => shiftDate(week, index + 1))
    .find(date => shanghaiMinute(date, openingHours(date)!.start)! > now) ??
    Array.from({ length: 7 }, (_, index) => shiftDate(shanghaiParts(now).date, index + 1))
      .find(date => openingHours(date) !== null)!;
}

function outsideHours(draft: Draft): boolean {
  if (shanghaiMinute(draft.date, draft.start) === null || shanghaiMinute(draft.date, draft.end) === null) return false;
  const hours = openingHours(draft.date);
  return hours === null || draft.start < hours.start || draft.end > hours.end;
}

function exceptionText(draft: Draft): string {
  const hours = openingHours(draft.date);
  return hours ? "这个时段超出当天开放时间 " + hours.start + "–" + hours.end + "。"
    : "周一默认停排。";
}

export function WeeklySchedulePanel({ api, students, initialStudentId, onBack }: {
  api: WorkspaceApi; students: Student[]; initialStudentId: string; onBack: () => void;
}) {
  const today = shanghaiParts(Date.now()).date;
  const [week, setWeek] = useState(() => mondayOf(today));
  const [studentId, setStudentId] = useState(initialStudentId);
  const [queryRevision, setQueryRevision] = useState(0);
  const [listing, setListing] = useState<{ key: string; rows?: AttendancePlan[]; error?: string }>();
  const [draft, setDraft] = useState<Draft>();
  const [draftDirty, setDraftDirty] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "failure" | "pending"; message: string }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const submission = useRef<ScheduleSaveInput | undefined>(undefined);
  const [learning, setLearning] = useState<{ attendanceId: string; studentId: string }>();
  const [learningRevision, setLearningRevision] = useState(0);
  const [confirmedLearningRequest, setConfirmedLearningRequest] = useState<string>();
  const request = usePendingOperation(api, (saved, requestId) => {
    if (saved?.command === "saveAttendancePlan") {
      setWeek(mondayOf(shanghaiParts(saved.startAt).date));
      showDraft(undefined);
    }
    refresh();
    setConfirmedLearningRequest(requestId);
    setLearningRevision(value => value + 1);
  });
  const [latest, setLatest] = useState<AttendancePlan>();
  const formRef = useRef<HTMLFormElement>(null);
  const queryKey = week + "/" + studentId + "/" + queryRevision;
  const current = listing?.key === queryKey ? listing : undefined;

  useEffect(() => {
    let mounted = true;
    api.scheduleWeek({ monday: week, studentId: studentId || undefined }).then(result => {
      if (mounted) setListing(result.ok ? { key: queryKey, rows: result.value } : { key: queryKey, error: result.message });
    }).catch(() => {
      if (mounted) setListing({ key: queryKey, error: "无法读取本周排课，请重试。" });
    });
    return () => { mounted = false; };
  }, [api, queryKey, studentId, week]);

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
    const date = nextDefaultDate(week);
    showDraft({ id: crypto.randomUUID(), studentId: studentId || students[0]?.id || "", date,
      ...defaults(date, "regular"), kind: "regular", confirmed: false, reason: "" });
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
    const exception = outsideHours(draft);
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
        setWeek(mondayOf(shanghaiParts(command.startAt).date));
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

  function moveWeek(delta: number) {
    const date = shiftDate(week, delta);
    if (weekRange(date)) setWeek(date);
  }

  const names = new Map(students.map(student => [student.id, student.alias]));
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index));
  const plansByDay = new Map(days.map(date => [date, [] as AttendancePlan[]]));
  for (const plan of current?.rows ?? []) plansByDay.get(shanghaiParts(plan.startAt).date)?.push(plan);
  const hasMonday = Boolean(plansByDay.get(week)?.length);
  const readOnly = Boolean(draft?.original && !canEdit(draft.original));
  const exception = draft && outsideHours(draft);

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
    {learning && <AttendanceLearningPanel api={api} target={learning} alias={names.get(learning.studentId) ?? "待核对学生"}
      reloadVersion={learningRevision} confirmedRequestId={confirmedLearningRequest}
      blocked={request.blocked} submit={request.run}
      onBack={() => { setLearning(undefined); refresh(); }} />}
    <section className="schedule-page" aria-labelledby="schedule-title" hidden={Boolean(learning)}>
    <header className="schedule-heading">
      <div>
        <button className="schedule-back" type="button" onClick={() => { if (canDiscard()) onBack(); }}>返回学生档案</button>
        <h1 id="schedule-title">排课周视图</h1>
        <p className="muted">机构时间（上海） · 周一默认停排</p>
      </div>
      <button type="button" className="primary schedule-primary" disabled={!students.length || busy || request.blocked} onClick={newDraft}>新建单次排课</button>
    </header>
    <div className="schedule-toolbar">
      <div className="schedule-period">
        <strong aria-live="polite">{week.replaceAll("-", ".")} – {days[6].replaceAll("-", ".")}</strong>
        <div className="schedule-buttons">
          <button className="secondary" type="button" onClick={() => moveWeek(-7)}>上一周</button>
          <button className="secondary" type="button" onClick={() => setWeek(mondayOf(today))}>本周</button>
          <button className="secondary" type="button" onClick={() => moveWeek(7)}>下一周</button>
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
        {draft.original && <span className="muted">{statuses[draft.original.status]}</span>}
      </div>
      {readOnly && <p className="muted">已开始或已结束的排课只供查看。</p>}
      {latest && <div className="notice pending" role="alert">
        <p>当前版本已变更。最新安排为 {shanghaiParts(latest.startAt).date} {shanghaiParts(latest.startAt).time}–{shanghaiParts(latest.endAt).time}，{latest.kind === "whole_day" ? "全天" : "普通"}，{statuses[latest.status]}。</p>
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
          <p>{exceptionText(draft)}</p>
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
    <div className={"schedule-days" + (hasMonday ? " schedule-days-extra" : "")}>
      {(hasMonday ? days : days.slice(1)).map(date => {
        const day = weekday(date);
        const hours = openingHours(date);
        const plans = plansByDay.get(date)!;
        return <section key={date} className={"schedule-day" + (day === 0 || day === 6 ? " schedule-weekend" : "")}
          aria-label={dayNames[day] + " " + date}>
          <header className="schedule-day-heading" aria-current={date === today ? "date" : undefined}>
            <h2>{dayNames[day]} <time dateTime={date}>{date.slice(5).replace("-", "/")}</time></h2>
            <p>{hours ? hours.start + "–" + hours.end : "仅显示例外"}</p>
          </header>
          {current?.rows && (plans.length ? <ul className="schedule-card-list">{plans.map(plan => {
            const start = shanghaiParts(plan.startAt).time;
            const end = shanghaiParts(plan.endAt).time;
            const alias = names.get(plan.studentId) ?? "待核对学生";
            return <li key={plan.id}>
              <button type="button" disabled={busy} className="schedule-card" data-kind={plan.kind} data-exception={Boolean(plan.exceptionReason)}
                aria-label={alias + " " + start + "–" + end + " " + statuses[plan.status]} onClick={() => {
                  if (canDiscard()) showDraft(toDraft(plan));
                }}>
                <span className="schedule-card-time">{start}–{end}</span>
                <strong>{alias}</strong>
                <span className="schedule-card-meta">{plan.kind === "whole_day" ? "全天" : "普通"} · {statuses[plan.status]}</span>
                {plan.exceptionReason && <span className="schedule-card-exception">时段例外</span>}
              </button>
              <button className="schedule-learning-entry" type="button" disabled={busy || request.busy}
                aria-label={alias + " 到校与任务"} onClick={() => {
                  if (!canDiscard()) return;
                  showDraft(undefined);
                  setLearning({ attendanceId: plan.id, studentId: plan.studentId });
                  window.scrollTo(0, 0);
                }}>到校与任务</button>
            </li>;
          })}</ul> : <p className="schedule-empty muted">无排课</p>)}
        </section>;
      })}
    </div>
    </section>
  </>;
}
