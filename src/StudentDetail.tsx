import { useEffect, useState, type ReactNode } from "react";
import type { IntakeHistorySummary, Result, Student, WorkspaceApi } from "./contracts";
import type { StudentRecordKind } from "./student-records";
import { lifecycleLabels } from "./student-lifecycle";
import type { OverviewSection } from "./StudentOverview";
import "./student-detail.css";

type Section = "overview" | "lifecycle" | "growth" | "history" | "sources" | "edit" | "parent" | "study-plan" | "learning-tracking" | StudentRecordKind;
const intakeStatus = { done: "已导入", pending: "待确认保存结果", review: "待核对" } as const;
const intakeTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
});

function ImportSources({ api, student }: { api: WorkspaceApi; student: Student }) {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ refresh: number; result: Result<IntakeHistorySummary> }>();
  const studentId = student.id;

  useEffect(() => {
    let current = true;
    api.studentIntakeHistory(studentId).then(result => {
      if (!current) return;
      if (result.ok && result.value.studentId !== studentId) {
        setLoaded({ refresh, result: { ok: false, code: "recovery", message: "来源记录与当前学生不一致。" } });
        return;
      }
      setLoaded({ refresh, result });
    }).catch(() => {
      if (current) setLoaded({ refresh, result: { ok: false, code: "failed", message: "无法读取导入来源。" } });
    });
    return () => { current = false; };
  }, [api, studentId, refresh]);

  const result = loaded?.refresh === refresh ? loaded.result : undefined;
  return <section className="panel student-sources" aria-labelledby="student-sources-heading">
    <h2 id="student-sources-heading">导入来源</h2>
    {!result ? <p className="muted" role="status">正在读取导入来源…</p>
      : !result.ok ? <div className="notice failure" role="alert">
        <p>读取失败。{result.message}</p>
        <button type="button" className="secondary" onClick={() => setRefresh(value => value + 1)}>重新读取来源</button>
      </div>
        : !result.value.entries.length ? <p className="muted">该学生尚未导入 JSON。</p>
          : <>
            <p className="muted">最近 20 条处理记录 · 上海时间</p>
            <ol className="student-source-list">
              {result.value.entries.map(entry => <li key={entry.digest}>
                <div className="student-source-heading">
                  <h3>{entry.code}</h3><span className="student-source-status" data-state={entry.state}>{intakeStatus[entry.state]}</span>
                </div>
                <dl>
                  <div><dt>关联学生</dt><dd>{student.alias} · 档案尾号 {student.id.slice(-8)}</dd></div>
                  <div><dt>{entry.state === "done" ? "导入完成时间" : "最近处理时间"}</dt>
                    <dd><time dateTime={new Date(entry.updatedAt).toISOString()}>{intakeTime.format(entry.updatedAt)}</time></dd></div>
                  <div><dt>来源说明</dt><dd>学生资料 JSON · {entry.documentCount} 份来源文档 · {entry.reviewCount} 项来源提示</dd></div>
                  <div><dt>来源指纹</dt><dd><code>{entry.digest.slice(0, 12)}</code></dd></div>
                </dl>
              </li>)}
            </ol>
          </>}
  </section>;
}

export function StudentDetail({ student, api, intakeOpen, actions, growth, history, edit, parentFollowUp, lifecycle, overview, overviewVisible, recordPanels, studyPlan, focusPlan, learningTracking }:  {
  student: Student; api: WorkspaceApi; intakeOpen: boolean;
  actions: ReactNode; growth: ReactNode; history: ReactNode; edit?: ReactNode; parentFollowUp?: ReactNode; lifecycle?: ReactNode;
  overview?: (open: (section: OverviewSection, recordId?: string) => void) => ReactNode; overviewVisible?: boolean;
  studyPlan?: ReactNode; focusPlan?: number; learningTracking?: ReactNode;
  recordPanels: { id: StudentRecordKind; label: string; content: ReactNode }[];
}) {
  const tabs: { id: Section; label: string; enabled: boolean }[] = [
    { id: "overview", label: "综合概览", enabled: Boolean(overview) },
    { id: "parent", label: "家长诉求", enabled: Boolean(parentFollowUp) },
    { id: "score", label: "成绩趋势", enabled: recordPanels.some(panel => panel.id === "score") },
    { id: "study-plan", label: "学习规划", enabled: Boolean(studyPlan) },
    { id: "learning-tracking", label: "单元与检测", enabled: Boolean(learningTracking) },
    { id: "growth", label: "成长档案", enabled: true },
    { id: "improvement", label: "提分方案", enabled: recordPanels.some(panel => panel.id === "improvement") },
    { id: "lifecycle", label: "跟进状态", enabled: Boolean(lifecycle) },
    { id: "enrollment", label: "报名与到期", enabled: recordPanels.some(panel => panel.id === "enrollment") },
    { id: "edit", label: "基础档案编辑", enabled: Boolean(edit) },
    { id: "history", label: "学习历史", enabled: true },
    { id: "sources", label: "导入来源", enabled: true },
  ];
  const available = tabs.filter(tab => tab.enabled);
  const [selection, setSelection] = useState<{ studentId: string; section: Section }>();
  useEffect(()=>{if(focusPlan!==undefined&&studyPlan)setSelection({studentId:student.id,section:"study-plan"});},
    [focusPlan,student.id]);
  // Forget the prior student's explicit choice even if no tab is clicked on the next student.
  if (selection && selection.studentId !== student.id) setSelection(undefined);
  // Derive the new student's tab during render; do not unmount the detail tree to reset it.
  const selected = selection?.studentId === student.id && available.some(tab => tab.id === selection.section)
    ? selection.section : available[0].id;

  function openSource(section: OverviewSection, recordId?: string) {
    if (!available.some(tab => tab.id === section)) return;
    setSelection({ studentId: student.id, section });
    requestAnimationFrame(() => {
      const detail = document.querySelector(".student-detail");
      if (!(detail instanceof HTMLElement) || detail.dataset.studentId !== student.id) return;
      const record = recordId ? document.getElementById(`student-source-${section}-${recordId}`) : null;
      const target = record ?? document.getElementById("student-section-" + section);
      target?.scrollIntoView({ block: "start" });
      if (record) record.focus({ preventScroll: true });
    });
  }

  return <article className="student-detail" data-student-id={student.id} aria-labelledby="student-detail-heading">
    <header className="panel student-overview">
      <div className="student-overview-heading">
        <h1 id="student-detail-heading" tabIndex={-1}>{student.alias}</h1>
        {actions}
      </div>
      <dl>
        <div><dt>年级</dt><dd>{student.grade}</dd></div>
        <div><dt>学科</dt><dd>{student.subjects}</dd></div>
        {student.lifecycleStatus && <div><dt>跟进状态</dt><dd>{lifecycleLabels[student.lifecycleStatus]}</dd></div>}
        {student.goal && <div><dt>学习目标</dt><dd>{student.goal}</dd></div>}
        {student.notes && <div><dt>备注</dt><dd>{student.notes}</dd></div>}
      </dl>
    </header>
    <nav className="student-detail-nav" aria-label="学生详情">
      {available.map(({ id, label }) => <button key={id} type="button" aria-controls={"student-section-" + id}
        aria-pressed={selected === id} onClick={() => setSelection({ studentId: student.id, section: id })}>{label}</button>)}
    </nav>
    {overview && <div id="student-section-overview" hidden={selected !== "overview"}>
      {selected === "overview" && overviewVisible && !intakeOpen && overview(openSource)}
    </div>}
    {studyPlan && <div id="student-section-study-plan" hidden={selected !== "study-plan"}>{!intakeOpen && studyPlan}</div>}
    {learningTracking&&<div id="student-section-learning-tracking" hidden={selected!=="learning-tracking"}>{!intakeOpen&&learningTracking}</div>}
    <div id="student-section-growth" hidden={selected !== "growth"}>{!intakeOpen && growth}</div>
    <div id="student-section-history" hidden={selected !== "history"}>{history}</div>
    <div id="student-section-sources" hidden={selected !== "sources"}>
      {!intakeOpen && <ImportSources key={student.id} api={api} student={student} />}
    </div>
    {lifecycle && <div id="student-section-lifecycle" hidden={selected !== "lifecycle"}>{!intakeOpen && lifecycle}</div>}
    {edit && <div id="student-section-edit" hidden={selected !== "edit"}>{!intakeOpen && edit}</div>}
    {parentFollowUp && <div id="student-section-parent" hidden={selected !== "parent"}>{!intakeOpen && parentFollowUp}</div>}
    {recordPanels.map(panel => <div key={panel.id} id={"student-section-" + panel.id} hidden={selected !== panel.id}>
      {!intakeOpen && panel.content}
    </div>)}
  </article>;
}
