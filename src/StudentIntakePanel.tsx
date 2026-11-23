import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  GrowthFields, IntakeConfirm as Confirm, IntakeFile,
  IntakeReview as Review, IntakeTarget as Target, Student, StudentInput, WorkspaceApi,
} from "./contracts";
import type { IntakePreview } from "./intake-format";
import "./student-intake.css";

type ParsedFile = Extract<IntakeFile, { token: string }>;
type Notice = { kind: "failure" | "pending" | "success"; text: string };
type StudentFields = Omit<StudentInput, "id">;

const growthFields: ReadonlyArray<{ key: keyof GrowthFields; label: string; limit: number }> = [
  { key: "currentSituation", label: "当前学情", limit: 2000 },
  { key: "strengths", label: "当前优势", limit: 1500 },
  { key: "weakAreas", label: "当前薄弱项", limit: 1500 },
  { key: "learningCharacteristics", label: "学习特点", limit: 2000 },
  { key: "communicationPreferences", label: "沟通偏好", limit: 1000 },
];

const categories = [
  ["warning", "提取警告"],
  ["unknown", "未映射或待核对"],
  ["fact", "资料事实"],
  ["self-report", "学生自述"],
  ["teacher-assessment", "教师评价"],
  ["goal", "学习目标"],
  ["plan", "学习计划"],
] as const;

const intakeStatuses = {
  unbound: "待确认身份",
  ready: "待确认导入",
  pending: "待确认保存结果",
  review: "待核对",
  done: "已导入",
} as const;

function describeStudent(student: Student): string {
  return [student.alias, student.grade, student.subjects, student.id.slice(-8)].join(" · ");
}

function previewSummary(value: unknown): string {
  if (typeof value === "string") return value.length > 100 ? value.slice(0, 100) + "…" : value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const item = value as Record<string, unknown>;
  for (const key of ["issue", "statement", "item", "summary", "suggestion", "plan_name", "target_display", "title"]) {
    const text = item[key];
    if (typeof text === "string" && text.trim()) return previewSummary(text);
  }
  return "";
}

const SourceReview = memo(function SourceReview({ source }: { source: IntakePreview }) {
  return <section className="intake-section" aria-label="人工核对区">
    <h3>人工核对区</h3>
    <p className="muted">展开条目核对来源页、原文、识别置信度及待核对标记。</p>
    {categories.map(([category, label]) => {
      const items = source.review.filter(item => item.category === category);
      if (!items.length) return null;
      return <details className="intake-disclosure" key={category}>
        <summary>{label}（{items.length}）</summary>
        <ul className="intake-evidence">
          {items.map((item, index) => <li key={item.path + "/" + index}>
            <details>
              <summary>{previewSummary(item.value) || item.message}</summary>
              <p className="muted">{item.path} · {item.message}</p>
              <pre>{JSON.stringify(item.value, null, 2)}</pre>
            </details>
          </li>)}
        </ul>
      </details>;
    })}
    <details className="intake-disclosure">
      <summary>查看完整来源 JSON</summary>
      <pre>{JSON.stringify(source.source, null, 2)}</pre>
    </details>
  </section>;
});

function StudentFieldsEditor({ fields, change }: {
  fields: StudentFields; change: (fields: StudentFields) => void;
}) {
  return <div className="field-grid intake-student-fields">
    <label>学生显示代号<input required maxLength={40} value={fields.alias}
      onChange={event => change({ ...fields, alias: event.target.value })} /></label>
    <label>年级<input required maxLength={30} value={fields.grade}
      onChange={event => change({ ...fields, grade: event.target.value })} /></label>
    <label className="wide">学科<input required maxLength={100} value={fields.subjects}
      onChange={event => change({ ...fields, subjects: event.target.value })} /></label>
    <label className="wide">学习目标<textarea rows={2} maxLength={300} value={fields.goal}
      onChange={event => change({ ...fields, goal: event.target.value })} /></label>
    <label className="wide">备注<textarea rows={2} maxLength={500} value={fields.notes}
      onChange={event => change({ ...fields, notes: event.target.value })} /></label>
  </div>;
}

function IntakeEditor({ api, file, students, currentStudent, setBusy, setQueueState, markDraft, onImported }: {
  api: WorkspaceApi;
  file: ParsedFile;
  students: Student[];
  currentStudent?: Student;
  setBusy: (busy: boolean) => void;
  setQueueState: (state: Review["state"]) => void;
  markDraft: (dirty: boolean) => void;
  onImported: (studentId: string) => void;
}) {
  const [review, setReview] = useState<Review>();
  const [fields, setFields] = useState<GrowthFields>();
  const [studentFields, setStudentFields] = useState<StudentFields>(file.source.student);
  const [selection, setSelection] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  const [lastDraft, setLastDraft] = useState<GrowthFields>();
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const inFlight = useRef(false);

  function accept(next: Review) {
    setReview(next);
    setFields(next.proposed);
    setStudentFields(next.source.student);
    setConfirmed(false);
    setNeedsRefresh(false);
    markDraft(false);
    setQueueState(next.state);
  }

  async function prepare(target?: Target) {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.prepareStudentIntake(file.token, target);
      if (result.ok) accept(result.value);
      else setNotice({ kind: "failure", text: result.message });
    } catch {
      setNotice({ kind: "failure", text: "无法读取导入预览，请重新读取。" });
    } finally {
      inFlight.current = false;
      setWorking(false);
      setBusy(false);
    }
  }

  useEffect(() => { void prepare(); }, [file.token]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review?.target || !fields || inFlight.current || needsRefresh || review.state === "done") return;
    if (review.state !== "pending" && !confirmed) return;

    const input: Confirm = {
      token: file.token,
      target: review.target,
      expectedRevision: review.revision,
      student: review.target.kind === "new" && !review.student ? studentFields : undefined,
      fields,
      reviewed: true,
      pendingId: review.pendingId,
    };
    inFlight.current = true;
    setWorking(true);
    setBusy(true);
    setNotice(undefined);
    let refreshConflict = false;
    let saved = false;
    try {
      const result = await api.saveStudentIntake(input);
      if (!result.ok) {
        refreshConflict = result.code === "conflict";
        if (refreshConflict) setLastDraft(fields);
        setNotice({ kind: "failure", text: result.message });
      } else {
        const { state, studentId, message } = result.value;
        setNotice({ kind: state === "saved" ? "success" : "pending", text: message });
        if (state === "saved") {
          saved = true;
          setReview({ ...review, state: "done" });
          setQueueState("done");
          markDraft(false);
          setLastDraft(undefined);
          onImported(studentId);
        } else {
          setQueueState(state);
          setNeedsRefresh(true);
          if (state === "review") setLastDraft(fields);
        }
      }
    } catch {
      setNotice({ kind: "pending", text: "导入结果待确认。请重新读取保存状态，再决定下一步。" });
      setQueueState("pending");
      setNeedsRefresh(true);
    }

    // Read the durable plan after both known partial outcomes and uncertain returns.
    try {
      let current = await api.prepareStudentIntake(file.token);
      if (current.ok && current.value.state === "unbound" && (!refreshConflict || review.target.kind === "existing")) {
        current = await api.prepareStudentIntake(file.token, review.target);
      }
      if (current.ok) {
        if (current.value.state === "done" && !saved && current.value.student) {
          setNotice({ kind: "success", text: "已从本机确认导入完成。" });
          onImported(current.value.student.id);
        }
        if (refreshConflict || current.value.state === "done" || current.value.state === "pending" || current.value.state === "review") {
          accept(current.value);
        } else {
          setNeedsRefresh(false);
          setConfirmed(false);
          setQueueState(current.value.state);
        }
      } else if (!saved) {
        setNeedsRefresh(true);
        setNotice({ kind: "pending", text: current.message + " 请重新读取保存状态。" });
      }
    } catch {
      if (!saved) {
        setNeedsRefresh(true);
        setNotice({ kind: "pending", text: "无法核对保存状态。请重新读取预览。" });
      }
    } finally {
      inFlight.current = false;
      setWorking(false);
      setBusy(false);
    }
  }

  function refreshPreview() {
    if (review && fields && (JSON.stringify(fields) !== JSON.stringify(review.proposed) ||
        JSON.stringify(studentFields) !== JSON.stringify(review.source.student))) {
      if (!window.confirm("重新读取会放弃尚未确认的修改。继续吗？")) return;
    }
    void prepare();
  }

  function chooseTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selection === "new") void prepare({ kind: "new" });
    else if (selection) void prepare({ kind: "existing", studentId: selection });
  }

  const pending = review?.state === "pending";
  const done = review?.state === "done";
  const canEdit = !working && !pending && !done && !needsRefresh;
  const targetStudentId = review?.target?.kind === "existing" ? review.target.studentId : undefined;
  const chosenStudent = review?.student ?? students.find(student => student.id === targetStudentId);
  const createStudent = review?.target?.kind === "new" && !review.student;
  const priorFields = review?.priorFields ?? lastDraft;
  const selectableStudents = currentStudent
    ? [currentStudent, ...students.filter(student => student.id !== currentStudent.id)]
    : students;

  return <div className="intake-editor">
    <div className="intake-file-heading">
      <h2>{file.source.code}</h2>
      <p className="muted">{file.name}{review ? " · " + intakeStatuses[review.state] : ""}</p>
      <p className="muted">来源年级与学科 · {file.source.student.grade || "未填写"} · {file.source.student.subjects || "未填写"}</p>
    </div>
    {notice && <div className={"notice " + notice.kind} role={notice.kind === "failure" ? "alert" : "status"}>
      {notice.text}
    </div>}
    {working && <p className="muted" role="status">正在处理导入资料…</p>}
    {review?.message && review.message !== notice?.text && <p className="intake-state-note" role="status">{review.message}</p>}
    {!review && !working && <button type="button" className="secondary" onClick={() => void prepare()}>重新读取预览</button>}
    {review?.state === "unbound" && <form className="intake-section" onSubmit={chooseTarget}>
      <fieldset className="intake-identity-select" disabled={working}>
        <legend>确认本地学生身份</legend>
        <label>为来源代号 {file.source.code} 选择档案
          <select required value={selection} onChange={event => setSelection(event.target.value)}>
            <option value="">请选择</option>
            <option value="new">新建本地学生</option>
            {selectableStudents.map(student => <option key={student.id} value={student.id}>{describeStudent(student)}</option>)}
          </select>
        </label>
        <button type="submit" className="secondary">查看写入预览</button>
      </fieldset>
    </form>}
    {review?.target && <section className="intake-section" aria-label="本地学生身份">
      <h3>写入对象</h3>
      <p>{chosenStudent ? describeStudent(chosenStudent) : "新建本地学生"}</p>
    </section>}
    <SourceReview source={file.source} />
    {review?.target && fields && !done && <form className="intake-section" onSubmit={save}>
      {pending ? <>
        <p className="intake-state-note">重试会沿用已确认的原导入内容和学生档案。</p>
        <details className="intake-disclosure">
          <summary>查看已确认的成长档案内容</summary>
          <dl>{growthFields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{fields[key] || "未填写"}</dd></div>)}</dl>
        </details>
      </> : <>
        {createStudent && <fieldset disabled={!canEdit}>
          <legend>新建学生资料</legend>
          <StudentFieldsEditor fields={studentFields} change={value => {
            setStudentFields(value); setConfirmed(false); markDraft(true);
          }} />
        </fieldset>}
        <fieldset disabled={!canEdit}>
          <legend>成长档案写入预览</legend>
          <p className="muted">{review.revision ? "当前版本 " + review.revision + "。请确认每项修改。" : "首次创建成长档案，可先修改写入内容。"}</p>
          <div className="intake-growth-fields">
            {growthFields.map(({ key, label, limit }) => <div className="intake-field" key={key}>
              {Boolean(review.revision) && <div>
                <span className="muted">{label} · 当前</span>
                <p>{review.existing[key] || "未填写"}</p>
              </div>}
              <div>
                <label>{label}{review.revision ? " · 导入后" : ""}
                  <textarea value={fields[key]} maxLength={limit} rows={3} onChange={event => {
                    setFields({ ...fields, [key]: event.target.value }); setConfirmed(false); markDraft(true);
                  }} />
                </label>
                {review.source.growth[key] && review.source.growth[key] !== fields[key] && <details className="intake-disclosure">
                  <summary>查看来源建议</summary>
                  <p>{review.source.growth[key]}</p>
                  <button type="button" className="secondary" onClick={() => {
                    setFields({ ...fields, [key]: review.source.growth[key] }); setConfirmed(false); markDraft(true);
                  }}>采用来源建议</button>
                </details>}
              </div>
            </div>)}
          </div>
        </fieldset>
        {priorFields && <details className="intake-disclosure">
          <summary>查看上次提交的成长档案内容</summary>
          <dl>{growthFields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{priorFields[key] || "未填写"}</dd></div>)}</dl>
        </details>}
        <label className="intake-confirm">
          <input type="checkbox" required checked={confirmed} disabled={!canEdit}
            onChange={event => setConfirmed(event.target.checked)} />
          我已核对学生身份、来源和将写入的内容
        </label>
      </>}
      <div className="intake-actions">
        <button type="submit" className="primary" disabled={working || needsRefresh || (pending ? !review.pendingId : !confirmed)}>
          {pending ? "重试已确认的导入" : "确认导入此学生"}
        </button>
        {(needsRefresh || pending || review.state === "review" || notice?.kind === "pending") && <button type="button"
          className="secondary" disabled={working} onClick={refreshPreview}>重新读取保存状态</button>}
        {review.state === "ready" && !needsRefresh && <button type="button" className="secondary" disabled={working}
          onClick={refreshPreview}>重新核对身份</button>}
      </div>
    </form>}
    {done && chosenStudent && <button type="button" className="secondary" disabled={working}
      onClick={() => onImported(chosenStudent.id)}>在名单中定位学生</button>}
  </div>;
}

export function StudentIntakePanel({ api, students, student, onImported, onBusyChange, onClose }: {
  api: WorkspaceApi;
  students: Student[];
  student?: Student;
  onImported: (studentId: string) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [active, setActive] = useState(0);
  const [states, setStates] = useState<Record<string, Review["state"]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const mountedBusy = useRef(false);
  const dirty = useRef(false);
  const selected = files[active];

  function setOperationBusy(value: boolean) {
    mountedBusy.current = value;
    setBusy(value);
    onBusyChange(value);
  }

  function canLeave() {
    return !mountedBusy.current && (!dirty.current || window.confirm("此份导入有未确认的修改，离开会放弃修改。继续吗？"));
  }

  async function pick() {
    if (!canLeave()) return;
    setOperationBusy(true);
    setNotice("");
    try {
      const result = await api.pickStudentIntake();
      if (!result.ok) setNotice(result.message);
      else if (result.value.length) {
        dirty.current = false;
        setFiles(result.value);
        setActive(0);
        setStates({});
      }
    } catch {
      setNotice("无法读取所选文件。请重新选择 JSON。");
    } finally {
      setOperationBusy(false);
    }
  }

  return <section className="panel student-intake" aria-labelledby="student-intake-heading">
    <header className="intake-heading">
      <h1 id="student-intake-heading">导入学生资料</h1>
      <button className="secondary" type="button" disabled={busy} onClick={() => { if (canLeave()) onClose(); }}>返回档案</button>
    </header>
    <p className="growth-backup-warning" role="note">导入资料尚无经过验收的正式备份恢复保护。验收仅使用虚构学生资料。</p>
    <div className="intake-picker">
      <button className={files.length ? "secondary" : "primary"} type="button" disabled={busy} onClick={() => void pick()}>
        {files.length ? "重新选择 JSON" : "选择 JSON"}
      </button>
      <p className="muted">支持 sw-student-intake-v1，每份一名学生，一次最多选 20 份，逐人确认。</p>
    </div>
    {notice && <div className="notice failure" role="alert">{notice}</div>}
    {files.length > 0 && <div className={files.length > 1 ? "intake-layout intake-layout-batch" : "intake-layout"}>
      {files.length > 1 && <nav aria-label="待导入文件">
        <h2>待导入文件（{files.length}）</h2>
        <ul className="intake-queue">
          {files.map((file, index) => <li key={index}>
            <button type="button" aria-pressed={active === index} disabled={busy} onClick={() => {
              if (active === index || !canLeave()) return;
              dirty.current = false;
              setActive(index);
            }}>
              <strong>{"error" in file ? file.name : file.source.code}</strong>
              <span>{"error" in file ? "文件需修正" : states[file.token] ? intakeStatuses[states[file.token]] : "待预览"}</span>
            </button>
          </li>)}
        </ul>
      </nav>}
      {selected && ("error" in selected
        ? <div className="intake-editor"><h2>{selected.name}</h2><p className="notice failure" role="alert">{selected.error}</p></div>
        : <IntakeEditor key={selected.token} api={api} file={selected} students={students} currentStudent={student}
          setBusy={setOperationBusy} setQueueState={state => setStates(old => ({ ...old, [selected.token]: state }))}
          markDraft={value => { dirty.current = value; }} onImported={onImported} />)}
    </div>}
  </section>;
}
