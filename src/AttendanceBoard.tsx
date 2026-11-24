import { useEffect, useState } from "react";
import type { AttendanceBoardDay, AttendanceBoardStatus, LearningDayInput, Result, Student, WorkspaceApi } from "./contracts";
import { attendanceCounts, isLateArrival, shanghaiParts } from "./schedule-calendar";
import "./attendance-board.css";

const labels: Record<AttendanceBoardStatus, string> = {
  upcoming: "待到校", unchecked: "未签到", checked_in: "已到", learning: "学习中",
  checked_out: "已签退", absent: "缺席", cancelled: "已取消",
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

export function AttendanceBoard({ result, reload, students, onLearning, onStudent }: {
  result?: Result<AttendanceBoardDay>; reload: () => void; students: Student[];
  onLearning: (target: LearningDayInput, trigger: HTMLButtonElement) => void;
  onStudent: (studentId: string, trigger: HTMLButtonElement) => void;
}) {
  const names = new Map(students.map(student => [student.id, student.alias]));
  const entries = result?.ok ? result.value.entries : [];

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
          <p className="muted">应到学生按档案去重，出勤状态按人次统计。已取消不计入应到。</p>
          <AttendanceOverview day={result.value} />
          {entries.length === 0 ? <p className="muted">今天暂无到校安排。</p>
            : <ul className="attendance-board-list">
              {entries.map(({ plan, status }) => <li key={plan.id} className="panel attendance-board-row" data-state={status}>
                <div><h2><button className="schedule-profile-link" type="button" disabled={!names.has(plan.studentId)}
                  onClick={event => onStudent(plan.studentId, event.currentTarget)}>{names.get(plan.studentId) ?? "待核对学生"}</button></h2>
                  <p>{shanghaiParts(plan.startAt).time}–{shanghaiParts(plan.endAt).time} · {plan.kind === "whole_day" ? "全天" : "普通"}</p>
                  {plan.exceptionReason && <p>时段例外：{plan.exceptionReason}</p>}
                </div>
                <div><strong>{labels[status]}</strong>
                  {plan.checkInAt !== null && <p>签到 {shanghaiParts(plan.checkInAt).time}{isLateArrival(plan) && " · 迟到"}</p>}
                  {plan.checkOutAt !== null && <p>签退 {shanghaiParts(plan.checkOutAt).time}</p>}
                </div>
                <button className="primary schedule-learning-entry" type="button" onClick={event => onLearning({
                  attendanceId: plan.id, studentId: plan.studentId,
                }, event.currentTarget)}>进入学习</button>
              </li>)}
            </ul>}
        </>}
  </section>;
}
