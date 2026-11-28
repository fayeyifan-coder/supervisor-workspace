import { useEffect, useState } from "react";
import type { AttendanceBoardDay, AttendanceBoardStatus, LearningDayInput, Result, Student, WorkspaceApi } from "./contracts";
import { FlexibleWindowCard, WalkInForm } from "./ScheduleArrivals";
import { attendanceCounts, attendanceSummary, isExpectedVisit, isLateArrival, shanghaiParts } from "./schedule-calendar";
import "./attendance-board.css";

const labels: Record<AttendanceBoardStatus, string> = {
  upcoming: "待到校", unchecked: "未签到", checked_in: "已到", learning: "学习中",
  checked_out: "已签退", absent: "缺席", cancelled: "已取消", leave: "已请假",
};

export function useTodayAttendance(api: WorkspaceApi, enabled: boolean) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result<AttendanceBoardDay>>();
  useEffect(() => {
    if (!enabled) return;
    const reload = () => setRefresh(value => value + 1);
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener("focus", reload);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", reload); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api.attendanceBoard().then(reply => { if (active) setResult(reply); }).catch(() => {
      if (active) setResult({ ok: false, code: "failed", message: "无法读取今日到校安排。" });
    });
    return () => { active = false; };
  }, [api, enabled, refresh]);
  return { result, reload: () => setRefresh(value => value + 1) };
}

export function AttendanceOverview({ day, compact = false }: { day: AttendanceBoardDay; compact?: boolean }) {
  if (day.flexWindows) {
    const totals = attendanceSummary(day.entries.map(({ plan }) => plan));
    return <dl className="attendance-overview" aria-label="出勤汇总">
      <div><dt>预计学生</dt><dd>{totals.expected.students} 人</dd></div>
      <div><dt>预计到课人次</dt><dd>{totals.expected.visits}</dd></div>
      <div><dt>实际到校学生</dt><dd>{totals.actual.students} 人</dd></div>
      <div><dt>实际到课人次</dt><dd>{totals.actual.visits}</dd></div>
      <div><dt>在校时长（已签退）</dt><dd>{totals.onsiteMinutes} 分钟</dd></div>
      {!compact && <><div><dt>未签退人次</dt><dd>{totals.open}</dd></div>
        <div><dt>有效学习时长</dt><dd>未登记</dd></div>
        <div><dt>弹性待确认</dt><dd>{day.flexWindows.length}</dd></div></>}
    </dl>;
  }
  const expected = attendanceCounts(day.entries.filter(({ status }) => status !== "cancelled").map(({ plan }) => plan));
  const counts = Object.fromEntries(Object.keys(labels).map(state => [state, 0]));
  for (const entry of day.entries) counts[entry.status]++;
  const states: AttendanceBoardStatus[] = compact ? ["unchecked", "checked_in", "learning", "checked_out"] : Object.keys(labels) as AttendanceBoardStatus[];
  return <dl className="attendance-overview" aria-label="出勤汇总">
    <div><dt>应到学生</dt><dd>{expected.students} 人</dd></div>
    <div><dt>应到人次</dt><dd>{expected.visits}</dd></div>
    {states.map(state => <div key={state} data-state={state}><dt>{labels[state]}</dt><dd>{counts[state]}</dd></div>)}
  </dl>;
}

export function AttendanceBoard({ api, result, reload, students, onLearning, onStudent, onQuick }: {
  api: WorkspaceApi; result?: Result<AttendanceBoardDay>; reload: () => void; students: Student[];
  onLearning: (target: LearningDayInput, trigger: HTMLButtonElement) => void;
  onStudent: (studentId: string, trigger: HTMLButtonElement) => void;
  onQuick?: (studentId:string,attendanceId:string)=>void;
}) {
  const names = new Map(students.map(student => [student.id, student.alias]));
  const [studentId, setStudentId] = useState("");
  const [scope, setScope] = useState<"all" | "expected" | "actual" | "exceptions">("all");
  const day = result?.ok ? result.value : undefined;
  const windows = day?.flexWindows?.filter(row => !studentId || row.studentId === studentId);
  const ownEntries = day?.entries.filter(({ plan }) => !studentId || plan.studentId === studentId) ?? [];
  const entries = ownEntries.filter(({ plan, status }) => scope === "all" ||
    (scope === "expected" && isExpectedVisit(plan)) || (scope === "actual" && plan.checkInAt !== null) ||
    (scope === "exceptions" && (status === "leave" || status === "cancelled" || status === "absent")));
  const onSaved: Parameters<typeof WalkInForm>[0]["onSaved"] = (plan, trigger, actual) => {
    reload();
    if (actual) onLearning({ attendanceId: plan.id, studentId: plan.studentId }, trigger);
  };

  return <section className="schedule-page attendance-board" aria-labelledby="attendance-board-title">
    <header className="schedule-heading">
      <div>
        <h1 id="attendance-board-title">今日到校</h1>
        <p className="muted">{result?.ok ? result.value.date : shanghaiParts(Date.now()).date} · 上海时间</p>
      </div>
      <button type="button" className="secondary" onClick={reload}>刷新今日到校</button>
    </header>
    {!result ? <p role="status">正在读取今日到校…</p>
      : !result.ok ? <p className="notice failure" role="alert">{result.message}</p>
        : <>
          {windows && <><div className="schedule-controls">
            <label>筛选学生<select value={studentId} onChange={event => setStudentId(event.target.value)}>
              <option value="">全部学生</option>{students.map(student => <option key={student.id} value={student.id}>{student.alias}</option>)}
            </select></label>
            <WalkInForm api={api} students={students} initial={studentId} onSaved={onSaved} blocked={false} />
          </div>
          <p className="muted">预计名单排除取消、请假和实际临时到课；实际名单以签到记录为准。同一学生的重叠在校时间只计一次。</p></>}
          <AttendanceOverview day={{ ...result.value, entries: ownEntries, flexWindows: windows }} />
          {windows && <div className="schedule-buttons" aria-label="到校名单">
            {([["all", "全部记录"], ["expected", "预计名单"], ["actual", "实际名单"], ["exceptions", "请假、缺席与取消"]] as const)
              .map(([key, label]) => <button key={key} type="button" className="secondary" aria-pressed={scope === key}
                onClick={() => setScope(key)}>{label}</button>)}
          </div>}
          {windows && scope === "all" && windows.length > 0 && <section aria-label="今日弹性窗口">
            <h2>弹性到课</h2><ul className="attendance-board-list">{windows.map(window => <FlexibleWindowCard
              key={window.id} api={api} window={window} alias={names.get(window.studentId) ?? "待核对学生"}
              blocked={false} onSaved={onSaved} />)}</ul>
          </section>}
          {entries.length === 0 ? <p className="muted">当前名单没有到校记录。</p>
            : <ul className="attendance-board-list">
              {entries.map(({ plan, status }) => <li key={plan.id} className="panel attendance-board-row" data-state={status}>
                <div><h2><button className="schedule-profile-link" type="button" disabled={!names.has(plan.studentId)}
                  onClick={event => onStudent(plan.studentId, event.currentTarget)}>{names.get(plan.studentId) ?? "待核对学生"}</button></h2>
                  <p>{plan.actualOnly ? "临时实际到课" : <>
                    {shanghaiParts(plan.startAt).time}–{shanghaiParts(plan.endAt).time} · {plan.cycleKind === "fixed" ? "固定到课" :
                      plan.cycleKind === "long_term" ? "长期在校" : plan.cycleKind === "flex" ? "弹性已预约" :
                        plan.kind === "whole_day" ? "全天" : "单次排课"}</>}</p>
                  {plan.dayException && <p>{plan.dayException.reason}</p>}
                  {plan.exceptionReason && <p>时段例外：{plan.exceptionReason}</p>}
                </div>
                <div><strong>{labels[status]}</strong>
                  {plan.checkInAt !== null && <p>签到 {shanghaiParts(plan.checkInAt).time}{isLateArrival(plan) && " · 迟到"}</p>}
                  {plan.checkOutAt !== null && <p>签退 {shanghaiParts(plan.checkOutAt).time}</p>}
                </div>
                <button className="primary schedule-learning-entry" type="button" onClick={event => onLearning({
                  attendanceId: plan.id, studentId: plan.studentId,
                }, event.currentTarget)}>进入学习</button>
                {onQuick&&plan.checkInAt!==null&&<button type="button" className="secondary" onClick={()=>onQuick(plan.studentId,plan.id)}>快速登记</button>}
              </li>)}
            </ul>}
        </>}
  </section>;
}
