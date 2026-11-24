import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Lesson, LessonInput, Student, StudentInput, WorkspaceApi } from "./contracts";
import { GrowthProfilePanel } from "./GrowthProfilePanel";
import { WorkLogPanel } from "./WorkLogPanel";
import { WeeklySchedulePanel } from "./WeeklySchedulePanel";
import { DataProtectionPanel } from "./DataProtectionPanel";
import { StudentIntakeHistory, StudentIntakePanel } from "./StudentIntakePanel";
import "./styles.css";

declare global {
  interface Window { supervisorWorkspace: WorkspaceApi }
}

type Command = { kind: "student"; input: StudentInput } | { kind: "lesson"; input: LessonInput };
type Notice = { type: "success" | "failure" | "pending"; message: string };
type History = { studentId: string; rows?: Lesson[]; error?: string };

function today(): string {
  const date = new Date();
  return [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function StudentForm({ disabled, submit }: { disabled: boolean; submit: (input: StudentInput) => void }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    submit({
      id: crypto.randomUUID(), alias: String(fields.get("alias")), grade: String(fields.get("grade")),
      subjects: String(fields.get("subjects")), goal: String(fields.get("goal")), notes: String(fields.get("notes")),
    });
  }

  return <section className="panel" aria-labelledby="new-student">
    <h1 id="new-student">新建学生档案</h1>
    <form onSubmit={onSubmit}>
      <fieldset disabled={disabled}>
        <div className="field-grid">
          <label>学生代号<input name="alias" maxLength={40} required placeholder="例如 虚构学员·小岚" autoFocus /></label>
          <label>年级<input name="grade" maxLength={30} required placeholder="例如 七年级" /></label>
          <label className="wide">学科<input name="subjects" maxLength={100} required placeholder="例如 数学、语文" /></label>
          <label className="wide">学习目标<textarea name="goal" maxLength={300} rows={2} /></label>
          <label className="wide">备注<textarea name="notes" maxLength={500} rows={2} /></label>
        </div>
        <button className="primary" type="submit">保存档案</button>
      </fieldset>
    </form>
  </section>;
}

function LessonForm({ student, disabled, submit }: {
  student: Student; disabled: boolean; submit: (input: LessonInput) => void;
}) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    submit({
      id: crypto.randomUUID(), studentId: student.id, date: String(fields.get("date")),
      subject: String(fields.get("subject")), task: String(fields.get("task")),
      completion: String(fields.get("completion")), assessment: String(fields.get("assessment")),
      nextStep: String(fields.get("nextStep")),
    });
  }

  return <section className="panel" aria-labelledby="add-lesson">
    <h2 id="add-lesson">添加学习记录</h2>
    <form onSubmit={onSubmit}>
      <fieldset disabled={disabled}>
        <div className="field-grid">
          <label>日期<input name="date" type="date" min="0001-01-01" max="9999-12-31" defaultValue={today()} required /></label>
          <label>学科<input name="subject" maxLength={40} required defaultValue={student.subjects.split(/[、,，]/)[0].trim().slice(0, 40)} /></label>
          <label className="wide">学习任务<textarea name="task" maxLength={500} rows={2} required /></label>
          <label className="wide">实际完成情况<textarea name="completion" maxLength={500} rows={2} required /></label>
          <label className="wide">测验与观察<textarea name="assessment" maxLength={500} rows={2} /></label>
          <label className="wide">下一步建议<textarea name="nextStep" maxLength={500} rows={2} /></label>
        </div>
        <button className="primary" type="submit">保存学习记录</button>
      </fieldset>
    </form>
  </section>;
}

function HistoryView({ history, reload }: { history?: History; reload: () => void }) {
  return <section className="panel history" aria-labelledby="learning-history">
    <h2 id="learning-history">学习历史</h2>
    {history?.error ? <div className="notice failure" role="alert">
      {history.error} <button className="secondary" onClick={reload}>重新读取</button>
    </div> : !history?.rows ? <p role="status" className="muted">正在读取学习历史…</p>
      : history.rows.length === 0 ? <p className="muted">还没有学习记录。保存后可在这里查看。</p>
        : <ol className="lesson-list">{history.rows.map(lesson => <li key={lesson.id}>
          <div className="lesson-heading"><h3>{lesson.subject}</h3><time dateTime={lesson.date}>{lesson.date}</time></div>
          <dl>
            <div><dt>学习任务</dt><dd>{lesson.task}</dd></div>
            <div><dt>实际完成</dt><dd>{lesson.completion}</dd></div>
            {lesson.assessment && <div><dt>测验与观察</dt><dd>{lesson.assessment}</dd></div>}
            {lesson.nextStep && <div><dt>下一步</dt><dd>{lesson.nextStep}</dd></div>}
          </dl>
        </li>)}</ol>}
  </section>;
}

function App() {
  const api = window.supervisorWorkspace;
  const [students, setStudents] = useState<Student[]>();
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [schedule, setSchedule] = useState<{ studentId: string }>();
  const [activeId, setActiveId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState("");
  const [history, setHistory] = useState<History>();
  const [listRefresh, setListRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [formVersion, setFormVersion] = useState(0);
  const [pending, setPending] = useState<Command>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [growthDirty, setGrowthDirty] = useState(false);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    api.scheduleAvailable().then(result => {
      if (current && result.ok) setScheduleEnabled(result.value);
    }).catch(() => {});
    return () => { current = false; };
  }, [api]);

  useEffect(() => {
    let current = true;
    setListError("");
    api.students().then(result => {
      if (!current) return;
      if (!result.ok) { setListError(result.message); return; }
      setStudents(result.value);
      setActiveId(previous => result.value.some(student => student.id === previous) ? previous : result.value[0]?.id);
    }).catch(() => { if (current) setListError("无法读取本地档案，请重试。"); });
    return () => { current = false; };
  }, [api, listRefresh]);

  useEffect(() => {
    if (!activeId) return;
    const studentId = activeId;
    let current = true;
    setHistory({ studentId });
    api.history(studentId).then(result => {
      if (!current) return;
      setHistory(result.ok ? { studentId, rows: result.value } : { studentId, error: result.message });
    }).catch(() => {
      if (current) setHistory({ studentId, error: "无法读取本地历史，请重试。" });
    });
    return () => { current = false; };
  }, [activeId, api, historyRefresh]);

  function confirm(row: Student | Lesson) {
    if ("studentId" in row) {
      setHistoryRefresh(value => value + 1);
    } else {
      setStudents(previous => [row, ...(previous ?? []).filter(student => student.id !== row.id)]);
      setActiveId(row.id);
      setCreating(false);
    }
    setFormVersion(value => value + 1);
    setPending(undefined);
    setNotice({ type: "success", message: "studentId" in row ? "学习记录已保存到本机。" : "学生档案已保存到本机。" });
  }

  async function save(command: Command) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice({ type: "pending", message: "正在等待 SQLite 确认保存…" });
    try {
      const result = command.kind === "student" ? await api.createStudent(command.input) : await api.addLesson(command.input);
      if (result.ok) {
        confirm(result.value);
      } else if (result.code === "unknown" || (pending && result.code !== "conflict")) {
        setPending(command);
        setNotice({ type: "pending", message: "保存结果待确认。" + result.message });
      } else {
        setPending(undefined);
        setNotice({ type: "failure", message: "保存未完成。" + result.message });
      }
    } catch {
      setPending(command);
      setNotice({ type: "pending", message: "保存结果待确认。可核对本地记录或重试同一请求。" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function checkPending() {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = pending.kind === "student" ? await api.students() : await api.history(pending.input.studentId);
      if (result.ok) {
        const row = result.value.find(item => item.id === pending.input.id);
        if (row && Object.entries(pending.input).every(([key, value]) => Reflect.get(row, key) === value.trim())) {
          confirm(row);
          return;
        }
      }
      setNotice({ type: "pending", message: "尚未从本机确认保存。你可以重试同一请求。" });
    } catch {
      setNotice({ type: "pending", message: "读取失败，保存结果仍待确认。" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const active = students?.find(student => student.id === activeId);
  const visibleHistory = history?.studentId === active?.id ? history : undefined;
  const locked = busy || pending !== undefined;
  const showStudentForm = students && (creating || students.length === 0);

  function canLeaveGrowth(): boolean {
    if (growthBusy) return false;
    if (growthDirty && !window.confirm("成长档案有未保存修改，确定离开并放弃吗？")) return false;
    setGrowthDirty(false);
    return true;
  }

  return <main className="shell" data-ui>
    <header className="masthead">
      <div className="brand"><span className="brand-mark" aria-hidden="true" /><strong>督学工作台</strong></div>
      <div className="schedule-heading-actions">
        <span className="scope">离线验收 · 仅用虚构学生</span>
        {scheduleEnabled && !schedule && <button className="secondary" type="button"
          disabled={!students || locked || growthBusy || intakeOpen}
          onClick={() => setSchedule({ studentId: "" })}>排课周视图</button>}
      </div>
    </header>
    {schedule && students && <WeeklySchedulePanel api={api} students={students} initialStudentId={schedule.studentId}
      onBack={() => setSchedule(undefined)} />}
    <div className="workspace" hidden={Boolean(schedule)}>
      <aside className="roster" aria-label="学生档案">
        <div className="roster-heading"><h2>学生档案</h2>
          <button className="secondary" disabled={locked || growthBusy || intakeOpen || !students} onClick={() => {
            if (!canLeaveGrowth()) return;
            setCreating(true); setNotice(undefined);
          }}>新建学生</button>
        </div>
        <button className="secondary intake-entry" type="button" disabled={locked || growthBusy || intakeOpen || !students}
          onClick={() => {
            if (!canLeaveGrowth()) return;
            setIntakeOpen(true); setNotice(undefined);
          }}>导入学生 JSON</button>
        {!listError && !students && <p role="status" className="muted">正在读取档案…</p>}
        {listError && <div className="notice failure" role="alert">{listError} <button className="secondary" onClick={() => setListRefresh(value => value + 1)}>重新读取</button></div>}
        {students?.length === 0 && <p className="muted">还没有学生档案。</p>}
        <ul className="student-list">{students?.map(student => <li key={student.id}>
          <button disabled={locked || growthBusy || intakeOpen} aria-pressed={!creating && student.id === activeId} onClick={() => {
            if (student.id === activeId && !creating) return;
            if (!canLeaveGrowth()) return;
            setActiveId(student.id); setCreating(false); setNotice(undefined);
          }}><strong>{student.alias}</strong><span>{student.grade} · {student.subjects}</span></button>
        </li>)}</ul>
      </aside>
      <div className="detail">
        {notice && <div className={"notice " + notice.type} role={notice.type === "failure" ? "alert" : "status"}>
          <span>{notice.message}</span>
          {pending && <div className="retry-actions">
            <button className="secondary" disabled={busy} onClick={() => void checkPending()}>核对本地记录</button>
            <button className="secondary" disabled={busy} onClick={() => void save(pending)}>重试同一请求</button>
          </div>}
        </div>}
        {intakeOpen && students && <StudentIntakePanel api={api} students={students} student={active}
          onImported={studentId => {
            setActiveId(studentId); setCreating(false); setListRefresh(value => value + 1);
          }} onBusyChange={setIntakeBusy} onClose={() => {
            if (intakeBusy) return;
            setIntakeOpen(false); setListRefresh(value => value + 1);
          }} />}
        <div className="student-content" hidden={intakeOpen}>
          {showStudentForm ? <StudentForm key={formVersion} disabled={locked} submit={input => void save({ kind: "student", input })} />
            : active && <>
              <section className="profile" aria-label="当前学生">
                <p className="muted">{active.grade} · {active.subjects}</p><h1>{active.alias}</h1>
                {scheduleEnabled && <button className="secondary" type="button" disabled={locked || growthBusy}
                  onClick={() => setSchedule({ studentId: active.id })}>查看该学生排课</button>}
                {(active.goal || active.notes) && <dl>
                  {active.goal && <div><dt>学习目标</dt><dd>{active.goal}</dd></div>}
                  {active.notes && <div><dt>备注</dt><dd>{active.notes}</dd></div>}
                </dl>}
              </section>
              {!intakeOpen && <><GrowthProfilePanel key={active.id} student={active} api={api}
                onDirtyChange={setGrowthDirty} onBusyChange={setGrowthBusy} />
              <StudentIntakeHistory api={api} studentId={active.id} /></>}
              <div className="learning">
                <LessonForm key={active.id + formVersion} student={active} disabled={locked || !visibleHistory?.rows}
                  submit={input => void save({ kind: "lesson", input })} />
                <HistoryView history={visibleHistory} reload={() => setHistoryRefresh(value => value + 1)} />
              </div>
            </>}
          {students && <WorkLogPanel students={students} api={api} />}
          <DataProtectionPanel api={api} />
        </div>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
