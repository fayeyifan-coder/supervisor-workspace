import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { LearningDayInput, Lesson, LessonInput, Student, StudentInput, WorkspaceApi, WorkspaceInfo } from "./contracts";
import { GrowthProfilePanel } from "./GrowthProfilePanel";
import { WorkLogPanel } from "./WorkLogPanel";
import { AttendanceBoard, AttendanceOverview, useTodayAttendance } from "./AttendanceBoard";
import { WeeklySchedulePanel } from "./WeeklySchedulePanel";
import { DataProtectionPanel } from "./DataProtectionPanel";
import { BusinessExportPanel } from "./BusinessExportPanel";
import { StudentIntakePanel } from "./StudentIntakePanel";
import { StudyPlanImportPanel } from "./StudyPlanImportPanel";
import "./study-plans.css";
import { StudentDetail } from "./StudentDetail";
import { StudentEditPanel } from "./StudentEditPanel";
import { ParentFollowUpPanel } from "./ParentFollowUpPanel";
import { TrainingForPlan } from "./TrainingForPlan";
import { ScoreTrend } from "./ScoreTrend";
import { StudentWriteRecoveryPanel, type StudentWriteResolution } from "./StudentWriteRecoveryPanel";
import { StudentRecordsPanel } from "./StudentRecordsPanel";
import { StudentLifecyclePanel } from "./StudentLifecyclePanel";
import { StudentOverview } from "./StudentOverview";
import { lifecycleLabels, type LifecycleChange, type LifecycleStatus } from "./student-lifecycle";
import { studentRecordDefinitions, type StudentRecordKind } from "./student-records";
import "./styles.css";

declare global {
  interface Window {
    supervisorWorkspace: WorkspaceApi;
    profileSwitchReady?: (freeze: boolean) => boolean;
    profileSwitchCancel?: () => void;
  }
}

type Command = { kind: "student"; input: StudentInput } | { kind: "lesson"; input: LessonInput };
type Notice = { type: "success" | "failure" | "pending"; message: string };
type History = { studentId: string; refresh: number; rows?: Lesson[]; error?: string };

function hasUncontrolledDraft(): boolean {
  return Array.from(document.querySelectorAll<HTMLFormElement>("[data-profile-switch-form]")).some(form =>
    Array.from(form.elements).some(field => {
      if (field instanceof HTMLSelectElement) {
        const original = Array.from(field.options).find(option => option.defaultSelected) ?? field.options[0];
        return field.value !== (original?.value ?? "");
      }
      if (field instanceof HTMLInputElement) {
        return field.type === "checkbox" || field.type === "radio"
          ? field.checked !== field.defaultChecked : field.value !== field.defaultValue;
      }
      return field instanceof HTMLTextAreaElement && field.value !== field.defaultValue;
    }));
}

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
    <form data-profile-switch-form onSubmit={onSubmit}>
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
    <form data-profile-switch-form onSubmit={onSubmit}>
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
      读取失败。{history.error} <button className="secondary" onClick={reload}>重新读取</button>
    </div> : !history?.rows ? <p role="status" className="muted">正在读取学习历史…</p>
      : history.rows.length === 0 ? <p className="muted">还没有学习记录。保存后可在这里查看。</p>
        : <ol className="lesson-list">{history.rows.map(lesson => <li key={lesson.id} id={"student-source-history-" + lesson.id} tabIndex={-1}>
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
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo>();
  useEffect(() => {
    let mounted = true;
    void api.workspaceInfo().then(reply => {
      if (mounted && reply.ok) setWorkspaceInfo(reply.value);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [api]);
  const [students, setStudents] = useState<Student[]>();
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>();
  const [page, setPage] = useState<"schedule" | "board" | "students">("schedule");
  const [protectionOpen, setProtectionOpen] = useState(false);
  const [protectionBusy, setProtectionBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [studentFilter, setStudentFilter] = useState("");
  const [rosterStatus, setRosterStatus] = useState<LifecycleStatus | "all">("active");
  const [learning, setLearning] = useState<LearningDayInput & { focusTaskId?: string }>();
  const learningLeaveGuard = useRef<() => boolean>(null);
  const attendance = useTodayAttendance(api, scheduleEnabled === true);
  const [studentEditEnabled, setStudentEditEnabled] = useState(false);
  const [studentWriteRefresh, setStudentWriteRefresh] = useState(0);
  const [writeResolution, setWriteResolution] = useState<StudentWriteResolution>();
  const refreshStudentWrites = useCallback(() => setStudentWriteRefresh(value => value + 1), []);
  const [studentRecordVersion, setStudentRecordVersion] = useState(0);
  const [planImportOpen,setPlanImportOpen]=useState(false);
  const [planRefresh,setPlanRefresh]=useState(0);
  const [recordActivity, setRecordActivity] = useState<Partial<Record<StudentRecordKind, { dirty: boolean; busy: boolean }>>>({});
  const onRecordActivity = useCallback((kind: StudentRecordKind, dirty: boolean, busy: boolean) => {
    setRecordActivity(old => old[kind]?.dirty === dirty && old[kind]?.busy === busy ? old : { ...old, [kind]: { dirty, busy } });
  }, []);
  const [parentFollowUpEnabled, setParentFollowUpEnabled] = useState(false);
  const [profileReturn, setProfileReturn] = useState<"schedule" | "board">();
  const entry = useRef<{ trigger: HTMLButtonElement; scroll: number }>(null);
  const scheduleNav = useRef<HTMLButtonElement>(null);
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
  const [lifecycleDirty, setLifecycleDirty] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const lifecycleActivity = useCallback((dirty: boolean, working: boolean) => {
    setLifecycleDirty(dirty); setLifecycleBusy(working);
  }, []);
  function updateLifecycle(change: LifecycleChange) {
    setStudents(previous => previous?.map(student => student.id === change.studentId ? { ...student, lifecycleStatus: change.status } : student));
  }
  const [growthDirty, setGrowthDirty] = useState(false);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [studentEditDirty, setStudentEditDirty] = useState(false);
  const [studentEditBusy, setStudentEditBusy] = useState(false);
  const [parentFollowUpDirty, setParentFollowUpDirty] = useState(false);
  const [parentFollowUpBusy, setParentFollowUpBusy] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    api.scheduleAvailable().then(result => {
      if (current) setScheduleEnabled(result.ok && result.value);
    }).catch(() => { if (current) setScheduleEnabled(false); });
    api.studentEditAvailable().then(result => {
      if (current && result.ok) setStudentEditEnabled(result.value);
    }).catch(() => {});
    api.studentRecordVersion().then(result => {
      if (current && result.ok) setStudentRecordVersion(result.value);
    }).catch(() => {});
    api.parentFollowUpAvailable().then(result => {
      if (current && result.ok) setParentFollowUpEnabled(result.value);
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
      setActiveId(previous => result.value.some(student => student.id === previous) ? previous : result.value.find(student => (student.lifecycleStatus ?? "active") === "active")?.id);
    }).catch(() => { if (current) setListError("无法读取本地档案，请重试。"); });
    return () => { current = false; };
  }, [api, listRefresh]);

  useEffect(() => {
    if (!activeId) return;
    const studentId = activeId;
    let current = true;
    api.history(studentId).then(result => {
      if (!current) return;
      if (!result.ok) { setHistory({ studentId, refresh: historyRefresh, error: result.message }); return; }
      if (result.value.some(lesson => lesson.studentId !== studentId)) {
        setHistory({ studentId, refresh: historyRefresh, error: "学习记录与当前学生不一致。" });
        return;
      }
      setHistory({ studentId, refresh: historyRefresh, rows: result.value });
    }).catch(() => {
      if (current) setHistory({ studentId, refresh: historyRefresh, error: "无法读取本地历史，请重试。" });
    });
    return () => { current = false; };
  }, [activeId, api, historyRefresh]);

  function confirm(row: Student | Lesson) {
    if ("studentId" in row) {
      setHistoryRefresh(value => value + 1);
    } else {
      setStudents(previous => [row, ...(previous ?? []).filter(student => student.id !== row.id)]);
      setActiveId(row.id);
      setRosterStatus("active");
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
  const visibleHistory = history?.studentId === active?.id && history?.refresh === historyRefresh ? history : undefined;
  const locked = busy || pending !== undefined;
  const editorBusy = lifecycleBusy || growthBusy || studentEditBusy || parentFollowUpBusy || Object.values(recordActivity).some(activity => activity.busy);
  useLayoutEffect(() => {
    window.profileSwitchReady = freeze => {
      if (locked || editorBusy || intakeOpen || intakeBusy || learning || lifecycleDirty || growthDirty || studentEditDirty ||
          parentFollowUpDirty || Object.values(recordActivity).some(activity => activity.dirty) ||
          document.querySelector("[data-profile-switch-draft]") || hasUncontrolledDraft()) return false;
      if (freeze) document.body.inert = true;
      return true;
    };
    window.profileSwitchCancel = () => { document.body.inert = false; };
    return () => { delete window.profileSwitchReady; delete window.profileSwitchCancel; };
  });
  const showStudentForm = students && (creating || students.length === 0);
  const rosterStudents = students?.filter(student => rosterStatus === "all" || (student.lifecycleStatus ?? "active") === rosterStatus);

  function canLeaveStudentDrafts(): boolean {
    if (editorBusy) return false;
    if ((lifecycleDirty || growthDirty || studentEditDirty || parentFollowUpDirty || Object.values(recordActivity).some(activity => activity.dirty)) &&
        !window.confirm("学生档案有未保存输入，确定离开并放弃吗？")) return false;
    setLifecycleDirty(false);
    setGrowthDirty(false);
    setStudentEditDirty(false);
    setParentFollowUpDirty(false);
    return true;
  }

  const showingWorkspace = scheduleEnabled === false || page === "students";

  function restoreEntry() {
    const origin = entry.current;
    entry.current = null;
    requestAnimationFrame(() => {
      window.scrollTo(0, origin?.scroll ?? 0);
      const control = origin?.trigger;
      (control?.isConnected && !control.disabled && control.getClientRects().length ? control : scheduleNav.current)
        ?.focus({ preventScroll: true });
    });
  }

  function openLearning(target: LearningDayInput, trigger: HTMLButtonElement, focusTaskId?: string) {
    entry.current = { trigger, scroll: window.scrollY };
    setLearning({ ...target, focusTaskId });
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.getElementById("learning-day-title")?.focus({ preventScroll: true });
    });
  }

  function closeLearning() {
    setLearning(undefined);
    attendance.reload();
    restoreEntry();
  }

  function openLinkedStudent(studentId: string, origin: "schedule" | "board", trigger: HTMLButtonElement): boolean {
    if (!students?.some(student => student.id === studentId) || locked || editorBusy || intakeOpen) return false;
    if ((studentId !== activeId || creating) && !canLeaveStudentDrafts()) return false;
    entry.current = { trigger, scroll: window.scrollY };
    setActiveId(studentId);
    setCreating(false);
    setNotice(undefined);
    setProfileReturn(origin);
    setPage("students");
    requestAnimationFrame(() => {
      document.getElementById("student-detail-heading")?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
    return true;
  }

  function returnToOrigin() {
    if (!profileReturn) return;
    setPage(profileReturn);
    setProfileReturn(undefined);
    restoreEntry();
  }

  function navigate(next: typeof page) {
    if (learning) {
      if (!learningLeaveGuard.current?.()) return;
      if (page === next) { closeLearning(); return; }
      setLearning(undefined);
      attendance.reload();
    } else if (next === page) {
      return;
    }
    if (next === profileReturn) { returnToOrigin(); return; }
    entry.current = null;
    setProfileReturn(undefined);
    setPage(next);
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  return <main className="shell" data-ui>
    <header className="masthead">
      <div className="brand"><span className="brand-mark" aria-hidden="true" /><strong>督学工作台</strong></div>
      <nav className="schedule-heading-actions workspace-navigation" aria-label="工作台">
        <span className="scope">{workspaceInfo?.mode === "production" ? "正式档案 · 本机离线" :
          workspaceInfo?.mode === "synthetic" ? "合成验收 · 仅用虚构学生" : "档案模式待确认"}</span>
        <button className="secondary" type="button" aria-expanded={protectionOpen} aria-controls="data-export-center"
          disabled={protectionBusy || exportBusy} onClick={() => setProtectionOpen(open => !open)}>数据导出与备份</button>
        {studentRecordVersion >= 11 && students && <button type="button" className="secondary" disabled={locked || editorBusy || intakeOpen}
          onClick={()=>setPlanImportOpen(true)}>导入 Word 规划</button>}
        {scheduleEnabled && <>
          <button className="secondary" type="button" ref={scheduleNav} aria-current={page === "schedule" && !learning ? "page" : undefined}
            disabled={!students || locked || editorBusy || intakeOpen} onClick={() => navigate("schedule")}>全局总课表</button>
          <button className="secondary" type="button" aria-current={page === "board" && !learning ? "page" : undefined}
            disabled={!students || locked || editorBusy || intakeOpen} onClick={() => navigate("board")}>今日到校看板</button>
          <button className="secondary" type="button" aria-current={showingWorkspace ? "page" : undefined}
            disabled={!students || locked || editorBusy || intakeOpen} onClick={() => navigate("students")}>学生档案</button>
        </>}
      </nav>
    </header>
    {planImportOpen&&students&&<StudyPlanImportPanel api={api} students={students} onClose={()=>setPlanImportOpen(false)}
      onSaved={()=>setPlanRefresh(value=>value+1)} />}
    <section id="data-export-center" hidden={!protectionOpen} aria-label="数据导出与备份">
      <div className="schedule-heading-actions"><h1>数据导出与备份</h1><button className="secondary" type="button"
        disabled={protectionBusy || exportBusy} onClick={() => setProtectionOpen(false)}>收起数据面板</button></div>
      <p className="muted">仅备份和导出已保存记录。未保存草稿仍保留在原页面，请先保存需要纳入的内容。</p>
      <DataProtectionPanel api={api} backupFormat={workspaceInfo?.backupFormat} onBusyChange={setProtectionBusy} />
      <BusinessExportPanel api={api} supported={workspaceInfo?.backupFormat === 2 && studentRecordVersion >= 6} onBusyChange={setExportBusy} />
    </section>
    {parentFollowUpEnabled && students && <StudentWriteRecoveryPanel api={api} students={students}
      refresh={studentWriteRefresh} onResolved={resolution => {
        setWriteResolution(resolution); setListRefresh(value => value + 1);
      }} />}
    {!showingWorkspace && (!students || scheduleEnabled === undefined) &&
      <p className="schedule-page" role="status">{listError || "正在读取课表…"}</p>}
    {!showingWorkspace && !students && listError && <button type="button" className="secondary" onClick={() => setListRefresh(value => value + 1)}>重新读取档案</button>}
    {scheduleEnabled && students && <div hidden={page !== "schedule" && !learning}>
      <WeeklySchedulePanel api={api} recurringEnabled={studentRecordVersion >= 9} flexEnabled={studentRecordVersion >= 10} students={students} studentId={studentFilter} setStudentId={setStudentFilter}
        learning={learning} learningBackLabel={page === "board" ? "返回今日到校" : page === "students" ? "返回学生概览" : undefined} onLearning={openLearning} onExitLearning={closeLearning}
        learningLeaveGuard={learningLeaveGuard} onStudent={(id, trigger) => openLinkedStudent(id, "schedule", trigger)}
        summary={<section className="schedule-attendance" aria-labelledby="schedule-attendance-title">
          <h2 id="schedule-attendance-title">今日到校{attendance.result?.ok && <> · <time dateTime={attendance.result.value.date}>{attendance.result.value.date}</time></>}</h2>
          {!attendance.result ? <p role="status" className="muted">正在读取今日到校…</p>
            : attendance.result.ok ? <AttendanceOverview day={attendance.result.value} compact />
            : <p role="alert">{attendance.result.message}</p>}
        </section>} />
    </div>}
    {scheduleEnabled && students && <div hidden={page !== "board" || Boolean(learning)}>
      <AttendanceBoard api={api} result={attendance.result} reload={attendance.reload} students={students}
        onStudent={(id, trigger) => openLinkedStudent(id, "board", trigger)} onLearning={openLearning} />
    </div>}
    <div className="workspace" hidden={!showingWorkspace || Boolean(learning)}>
      <aside className="roster" aria-label="学生档案">
        <div className="roster-heading"><h2>学生档案</h2>
          <button className="secondary" disabled={locked || editorBusy || intakeOpen || !students} onClick={() => {
            if (!canLeaveStudentDrafts()) return;
            setCreating(true); setNotice(undefined);
          }}>新建学生</button>
        </div>
        <button className="secondary intake-entry" type="button" disabled={locked || editorBusy || intakeOpen || !students}
          onClick={() => {
            if (!canLeaveStudentDrafts()) return;
            setIntakeOpen(true); setNotice(undefined);
          }}>导入学生 JSON</button>
        {!listError && !students && <p role="status" className="muted">正在读取档案…</p>}
        {listError && <div className="notice failure" role="alert">{listError} <button className="secondary" onClick={() => setListRefresh(value => value + 1)}>重新读取</button></div>}
        {students?.length === 0 && <p className="muted">还没有学生档案。</p>}
        {studentRecordVersion >= 8 && <label className="student-roster-filter">名单状态
          <select value={rosterStatus} disabled={locked || editorBusy || intakeOpen} onChange={event => {
            const status = event.target.value as LifecycleStatus | "all";
            const filtered = students?.filter(student => status === "all" || (student.lifecycleStatus ?? "active") === status);
            if (!creating && filtered?.some(student => student.id === activeId)) { setRosterStatus(status); return; }
            if (!canLeaveStudentDrafts()) return;
            setRosterStatus(status); setActiveId(filtered?.[0]?.id); setCreating(false); setNotice(undefined);
          }}>
            {(Object.keys(lifecycleLabels) as LifecycleStatus[]).map(status => <option key={status} value={status}>{lifecycleLabels[status]}</option>)}
            <option value="all">全部状态</option>
          </select>
        </label>}
        {students?.length !== 0 && rosterStudents?.length === 0 && <p className="muted">当前状态下没有学生档案。</p>}
        <ul className="student-list">{rosterStudents?.map(student => <li key={student.id}>
          <button disabled={locked || editorBusy || intakeOpen} aria-pressed={!creating && student.id === activeId} onClick={() => {
            if (student.id === activeId && !creating) return;
            if (!canLeaveStudentDrafts()) return;
            setActiveId(student.id); setCreating(false); setNotice(undefined);
          }}><strong>{student.alias}</strong><span>{student.grade} · {student.subjects}{rosterStatus === "all" && student.lifecycleStatus && ` · ${lifecycleLabels[student.lifecycleStatus]}`}</span></button>
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
        {intakeOpen && students && <StudentIntakePanel api={api} students={students} student={active} backupFormat={workspaceInfo?.backupFormat}
          onImported={studentId => {
            setActiveId(studentId); setCreating(false); setListRefresh(value => value + 1);
          }} onBusyChange={setIntakeBusy} onClose={() => {
            if (intakeBusy) return;
            setIntakeOpen(false); setListRefresh(value => value + 1);
          }} />}
        <div className="student-content" hidden={intakeOpen}>
          {showStudentForm ? <StudentForm key={formVersion} disabled={locked} submit={input => void save({ kind: "student", input })} />
            : active && <StudentDetail student={active} api={api} intakeOpen={intakeOpen}
              overviewVisible={showingWorkspace && !learning}
              overview={studentRecordVersion >= 8 ? openSource => <StudentOverview key={active.id} studentId={active.id}
                api={api} openSource={openSource} openVisit={openLearning} /> : undefined}
              actions={scheduleEnabled && <div className="schedule-heading-actions">
                {profileReturn && <button className="secondary" type="button" disabled={editorBusy} onClick={returnToOrigin}>
                  {profileReturn === "board" ? "返回今日到校" : "返回课表"}
                </button>}
                <button className="secondary" type="button" disabled={locked || editorBusy}
                  onClick={() => {
                    entry.current = null;
                    setProfileReturn(undefined);
                    setStudentFilter(active.id);
                    setPage("schedule");
                    window.scrollTo(0, 0);
                  }}>查看该学生排课</button>
              </div>}
              lifecycle={studentRecordVersion >= 8 && <StudentLifecyclePanel key={active.id} studentId={active.id} api={api}
                onSaved={updateLifecycle} onActivity={lifecycleActivity} refreshRecovery={refreshStudentWrites} resolution={writeResolution} />}
              edit={studentEditEnabled && <StudentEditPanel key={active.id} studentId={active.id} api={api}
                onDirtyChange={setStudentEditDirty} onBusyChange={setStudentEditBusy}
                onSaved={() => setListRefresh(value => value + 1)} />}
              recordPanels={(Object.keys(studentRecordDefinitions) as StudentRecordKind[])
                .filter(kind => kind !== "training" && studentRecordDefinitions[kind].version <= studentRecordVersion).map(kind => ({
                  id: kind, label: studentRecordDefinitions[kind].label,
                  content: <StudentRecordsPanel key={active.id + kind} studentId={active.id} kind={kind} recordVersion={studentRecordVersion} api={api}
                    onActivity={onRecordActivity} onRecoveryChange={refreshStudentWrites} recoveryResolution={writeResolution} overview={kind === "score" ? records => <ScoreTrend records={records} studentId={active.id} ranksEnabled={studentRecordVersion >= 7} /> : undefined}
                    after={kind === "improvement" ? plans => plans.length > 0 &&
                      <TrainingForPlan api={api} studentId={active.id} plans={plans} onActivity={onRecordActivity}
                        onRecoveryChange={refreshStudentWrites} recoveryResolution={writeResolution} /> : undefined} />,
                }))}
              parentFollowUp={parentFollowUpEnabled && <ParentFollowUpPanel key={active.id} studentId={active.id} api={api}
                onDirtyChange={setParentFollowUpDirty} onBusyChange={setParentFollowUpBusy}
                onRecoveryChange={refreshStudentWrites} recoveryResolution={writeResolution} />}
              growth={<GrowthProfilePanel key={active.id} student={active} api={api}
                onDirtyChange={setGrowthDirty} onBusyChange={setGrowthBusy} />}
              history={<div className="learning">
                <LessonForm key={active.id + formVersion} student={active} disabled={locked || !visibleHistory?.rows}
                  submit={input => void save({ kind: "lesson", input })} />
                <HistoryView history={visibleHistory} reload={() => setHistoryRefresh(value => value + 1)} />
              </div>} />}
          {students && <WorkLogPanel students={students} api={api} backupFormat={workspaceInfo?.backupFormat} />}
        </div>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
