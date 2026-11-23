import { useEffect, useState, type ReactNode } from "react";
import type { IntakeHistorySummary, Result, Student, WorkspaceApi } from "./contracts";
import "./student-detail.css";

const sections = [
  { id: "growth", label: "成长档案" },
  { id: "history", label: "学习历史" },
  { id: "sources", label: "导入来源" },
  { id: "planned", label: "后续功能" },
] as const;
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

export function StudentDetail({ student, api, intakeOpen, actions, growth, history }: {
  student: Student; api: WorkspaceApi; intakeOpen: boolean;
  actions: ReactNode; growth: ReactNode; history: ReactNode;
}) {
  const [selected, setSelected] = useState<(typeof sections)[number]["id"]>("growth");

  return <article className="student-detail" aria-labelledby="student-detail-heading">
    <header className="panel student-overview">
      <div className="student-overview-heading">
        <h1 id="student-detail-heading">{student.alias}</h1>
        {actions}
      </div>
      <dl>
        <div><dt>年级</dt><dd>{student.grade}</dd></div>
        <div><dt>学科</dt><dd>{student.subjects}</dd></div>
        {student.goal && <div><dt>学习目标</dt><dd>{student.goal}</dd></div>}
        {student.notes && <div><dt>备注</dt><dd>{student.notes}</dd></div>}
      </dl>
    </header>
    <nav className="student-detail-nav" aria-label="学生详情">
      {sections.map(({ id, label }) => <button key={id} type="button" aria-controls={"student-section-" + id}
        aria-pressed={selected === id} onClick={() => setSelected(id)}>{label}</button>)}
    </nav>
    <div id="student-section-growth" hidden={selected !== "growth"}>{!intakeOpen && growth}</div>
    <div id="student-section-history" hidden={selected !== "history"}>{history}</div>
    <div id="student-section-sources" hidden={selected !== "sources"}>
      {!intakeOpen && <ImportSources key={student.id} api={api} student={student} />}
    </div>
    <section id="student-section-planned" className="panel student-planned" hidden={selected !== "planned"}
      aria-labelledby="student-planned-heading">
      <h2 id="student-planned-heading">规划中的功能</h2>
      <ul>{["家长诉求", "成绩趋势", "提分方案", "到期提醒"].map(label => <li key={label}>{label}</li>)}</ul>
    </section>
  </article>;
}
