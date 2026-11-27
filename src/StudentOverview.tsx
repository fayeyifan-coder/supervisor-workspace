import { useEffect, useState } from "react";
import type { LearningDayInput, Result, WorkspaceApi } from "./contracts";
import { parentStatuses } from "./parent-follow-up";
import { shanghaiParts } from "./schedule-calendar";
import type { StudentOverviewData } from "./student-overview";

export type OverviewSection = "parent" | "score" | "growth" | "history";
type OpenSource = (section: OverviewSection, recordId?: string) => void;
const empty = <p className="muted">尚未登记。</p>;
const rate = (value: number) => value.toFixed(1) + "%";
const rank = ({ rank, size }: { rank: number | null; size: number | null }) =>
  (rank === null ? "未登记" : `第 ${rank} 名`) + (size === null ? " · 参考人数未登记" : ` · ${size} 人参考`);

export function StudentOverview({ api, studentId, openSource, openVisit }: {
  api: WorkspaceApi; studentId: string; openSource: OpenSource;
  openVisit: (target: LearningDayInput, trigger: HTMLButtonElement, taskId?: string) => void;
}) {
  const [result, setResult] = useState<Result<StudentOverviewData>>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    api.studentOverview(studentId).then(reply => {
      if (!current) return;
      setResult(reply.ok && reply.value.studentId !== studentId
        ? { ok: false, code: "recovery", message: "概览资料与当前学生不一致。" } : reply);
    }).catch(() => { if (current) setResult({ ok: false, code: "failed", message: "无法读取概览资料。" }); });
    return () => { current = false; };
  }, [api, studentId, refresh]);

  if (!result) return <p role="status" className="muted">正在读取学生概览…</p>;
  if (!result.ok) return <div className="notice failure" role="alert">{result.message} <button type="button"
    onClick={() => { setResult(undefined); setRefresh(value => value + 1); }}>重新读取</button></div>;
  const view = result.value;
  if (view.studentId !== studentId) return null;
  const score = view.recentScore;

  return <div className="student-summary-grid" aria-label="学生概览摘要">
    <section className="panel student-summary-card">
      <h2>家长诉求与跟进</h2>
      {view.concerns.length ? <ul>{view.concerns.map(row => <li key={row.id}>
        <button className="schedule-profile-link" type="button" onClick={() => openSource("parent", row.id)}>{row.concern}</button>
        <p className="muted">{parentStatuses[row.status]} · {row.nextOn ? `下次跟进 ${row.nextOn}` : "跟进日期未登记"}</p>
      </li>)}</ul> : empty}
      {view.openConcerns > 3 && <button type="button" onClick={() => openSource("parent")}>查看全部 {view.openConcerns} 项待跟进</button>}
    </section>
    <section className="panel student-summary-card">
      <h2>最近成绩与趋势</h2>
      {score ? <>
        <button className="schedule-profile-link" type="button" onClick={() => openSource("score", score.id)}>
          {score.subject} · {score.name}</button>
        <p><strong>{score.score}/{score.maximum}</strong> · {rate(score.rate)} · {score.date}</p>
        <dl className="summary-ranks"><div><dt>班级排名</dt><dd>{rank(score.classRank)}</dd></div>
          <div><dt>年级排名</dt><dd>{rank(score.gradeRank)}</dd></div></dl>
        {view.recentTrend.length > 1 && <p className="muted">同学科最近得分率
          <span className="summary-trend">{view.recentTrend.map(row => <button className="schedule-profile-link" key={row.id} type="button"
            title={row.name + " · " + row.date} onClick={() => openSource("score", row.id)}>{rate(row.rate)}</button>)}</span>
        </p>}
      </> : empty}
    </section>
    <section className="panel student-summary-card">
      <h2>阶段目标与当前学情</h2>
      {view.goals.length ? <ul>{view.goals.map(goal => <li key={goal.id}><button className="schedule-profile-link" type="button"
        onClick={() => openSource("growth", goal.id)}>{goal.subject} · 目标 {goal.targetScore} 分 · {goal.deadline}</button></li>)}</ul>
        : <p className="muted">阶段目标尚未登记。</p>}
      {view.situation ? <button className="schedule-profile-link" type="button" onClick={() => openSource("growth")}>{view.situation}</button>
        : <p className="muted">当前学情尚未登记。</p>}
    </section>
    <section className="panel student-summary-card">
      <h2>未来 14 天到课与学习任务</h2>
      {view.attendance.length ? <ul>{view.attendance.map(row => {
        const start = shanghaiParts(row.startAt);
        return <li key={row.id}><button className="schedule-profile-link" type="button" onClick={event =>
          openVisit({ studentId, attendanceId: row.id }, event.currentTarget)}>{start.date} · {start.time}–{shanghaiParts(row.endAt).time}</button></li>;
      })}</ul> : <p className="muted">近期预计到课尚未登记。</p>}
      {view.tasks.length ? <ul>{view.tasks.map(task => <li key={task.id}><button className="schedule-profile-link" type="button" onClick={event =>
        openVisit({ studentId, attendanceId: task.visitId }, event.currentTarget, task.id)}>
        {task.subject ? task.subject + " · " : ""}{task.content}</button><p className="muted">{shanghaiParts(task.at).date} · {task.status === "in_progress" ? "进行中" : "待开始"}</p></li>)}</ul>
        : <p className="muted">近期学习任务尚未登记。</p>}
    </section>
    <section className="panel student-summary-card">
      <h2>下一步行动</h2>
      {view.nextAction ? <><button className="schedule-profile-link" type="button" onClick={() =>
        openSource("history", view.nextAction?.id)}>{view.nextAction.text}</button><p className="muted">{view.nextAction.date} · 学习记录</p></> : empty}
    </section>
  </div>;
}
