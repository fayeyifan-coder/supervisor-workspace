import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { AttendancePlan, LearningBlock, LearningChange, LearningDay, LearningDayInput, LearningTask,
  LearningTaskInput, Result, WorkspaceApi } from "./contracts";
import { shanghaiMinute, shanghaiParts } from "./schedule-calendar";
import "./attendance-learning.css";

type AttendanceAction = Extract<LearningChange, { command: "recordAttendance" }>["action"];
type BlockAction = Extract<LearningChange, { command: "recordLearningOutcome" }>["action"];
type TaskAction = Extract<LearningChange, { command: "recordTaskOutcome" }>["status"];
type Submit = (command: LearningChange, saved?: () => void) => void;
const attendanceLabels: Record<AttendancePlan["status"], string> = {
  planned: "待确认", confirmed: "已确认", attended: "已到校", absent: "缺席", cancelled: "已取消",
};
const blockLabels: Record<LearningBlock["status"], string> = {
  planned: "未开始", in_progress: "学习中", done: "已结束", cancelled: "已取消",
};
const taskLabels: Record<LearningTask["status"], string> = {
  planned: "未开始", in_progress: "进行中", done: "已完成", skipped: "已跳过",
};
const categoryLabels: Record<LearningTask["category"], string> = {
  foundation: "打地基", synchronous: "同步课", targeted_test: "薄弱项针对性测试", home_school: "家校作业",
};

function factTime(at: number | null) {
  if (at === null) return "—";
  const parts = shanghaiParts(at);
  return parts.date + " " + parts.time;
}

function range(start: number, end: number) {
  return shanghaiParts(start).time + "–" + shanghaiParts(end).time;
}

function change(target: LearningDayInput, id: string, expectedRevision: number) {
  return { ...target, id, expectedRevision, requestId: crypto.randomUUID() };
}

interface BlockDraft {
  id: string;
  revision: number;
  start: string;
  end: string;
  reason: string;
  notes: string;
}

function blockDraft(plan: AttendancePlan, block?: LearningBlock): BlockDraft {
  return { id: block?.id ?? crypto.randomUUID(), revision: block?.revision ?? 0,
    start: shanghaiParts(block?.plannedStart ?? plan.startAt).time,
    end: shanghaiParts(block?.plannedEnd ?? plan.endAt).time,
    reason: block?.outsideAttendanceReason ?? "", notes: block?.notes ?? "" };
}

function BlockForm({ plan, draft, locked, onDraft, onSave, onClose, latest }: {
  plan: AttendancePlan; draft: BlockDraft; locked: boolean; onDraft: (draft: BlockDraft) => void;
  onSave: (start: number, end: number, outside: boolean) => void; onClose: () => void; latest?: LearningBlock;
}) {
  const date = shanghaiParts(plan.startAt).date;
  const start = shanghaiMinute(date, draft.start), end = shanghaiMinute(date, draft.end);
  const outside = start !== null && end !== null && (start < plan.startAt || end > plan.endAt);
  const stale = latest && latest.revision !== draft.revision;
  const valid = start !== null && end !== null && start < end;
  return <form className="panel learning-block-form" aria-label="学习块表单" onSubmit={event => {
    event.preventDefault();
    if (valid && !locked && !stale) onSave(start, end, outside);
  }}>
    <h3>{draft.revision ? "调整学习块" : "新建学习块"} · {date}</h3>
    {stale && <div className="notice pending" role="alert">
      <p>当前版本已变更为 {range(latest.plannedStart, latest.plannedEnd)}，{blockLabels[latest.status]}。</p>
      {latest.outsideAttendanceReason && <p>最新时段说明：{latest.outsideAttendanceReason}</p>}
      {latest.notes && <p>最新备注：{latest.notes}</p>}
      {latest.status === "planned" && <button type="button" className="secondary" disabled={locked}
        onClick={() => onDraft({ ...draft, revision: latest.revision })}>核对后保留输入</button>}
    </div>}
    <fieldset className="field-grid" disabled={locked || Boolean(stale) || Boolean(latest && latest.status !== "planned")}>
      <label>学习块开始<input required type="time" value={draft.start} onChange={event => onDraft({ ...draft, start: event.target.value })} /></label>
      <label>学习块结束<input required type="time" value={draft.end} onChange={event => onDraft({ ...draft, end: event.target.value })} /></label>
      {outside && <label className="wide">超出到校时间的原因<input required maxLength={500} value={draft.reason}
        onChange={event => onDraft({ ...draft, reason: event.target.value })} /></label>}
      <label className="wide">学习块备注<input maxLength={1000} value={draft.notes} onChange={event => onDraft({ ...draft, notes: event.target.value })} /></label>
    </fieldset>
    {!valid && <p className="muted">学习块结束时间须晚于开始时间。</p>}
    <div className="learning-actions">
      <button type="submit" className="primary" disabled={locked || Boolean(stale) || !valid ||
        Boolean(latest && latest.status !== "planned")}>保存学习块</button>
      <button type="button" className="secondary" disabled={locked} onClick={onClose}>关闭学习块表单</button>
    </div>
  </form>;
}

function toTaskInput(task: LearningTask): LearningTaskInput {
  return { id: task.id, category: task.category, content: task.content, subject: task.subject ?? undefined,
    knowledgePoints: task.knowledgePoints ?? undefined, plannedTarget: task.plannedTarget ?? undefined };
}

function TaskForm({ block, target, locked, submit, afterClose }: {
  block: LearningBlock; target: LearningDayInput; locked: boolean; submit: Submit; afterClose: () => void;
}) {
  const [tasks, setTasks] = useState(() => block.tasks.map(toTaskInput));
  const [revision, setRevision] = useState(block.revision);
  const stale = revision !== block.revision;
  const disabled = locked || stale || block.status !== "planned";
  function patch(index: number, fields: Partial<LearningTaskInput>) {
    setTasks(previous => previous.map((task, i) => i === index ? { ...task, ...fields } : task));
  }
  return <form className="learning-task-form" aria-label="任务计划表单" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    submit({ ...change(target, block.id, revision), command: "saveLearningTasks", tasks }, afterClose);
  }}>
    <h4>任务计划 · 每块最多三项</h4>
    {stale && <div className="notice pending" role="alert">
      <p>任务版本已变更。请核对本学习块上方的已保存任务。</p>
      {block.status === "planned" && <button type="button" className="secondary" disabled={locked}
        onClick={() => setRevision(block.revision)}>核对后保留任务输入</button>}
    </div>}
    <fieldset disabled={disabled}>
      {tasks.map((task, index) => <div className="field-grid learning-task-fields" key={task.id}>
        <label>任务类别
          <select value={task.category} onChange={event => patch(index, { category: event.target.value as LearningTask["category"] })}>
            {(Object.entries(categoryLabels)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>学科<input value={task.subject ?? ""} maxLength={100} onChange={event => patch(index, { subject: event.target.value })} /></label>
        <label className="wide">具体内容<input required maxLength={1000} value={task.content}
          onChange={event => patch(index, { content: event.target.value })} /></label>
        <label>知识点<input value={task.knowledgePoints ?? ""} maxLength={1000}
          onChange={event => patch(index, { knowledgePoints: event.target.value })} /></label>
        <label>预期目标<input value={task.plannedTarget ?? ""} maxLength={1000}
          onChange={event => patch(index, { plannedTarget: event.target.value })} /></label>
        <button type="button" className="secondary" onClick={() => setTasks(previous => previous.filter(row => row.id !== task.id))}>移除这项任务</button>
      </div>)}
      <div className="learning-actions">
        <button type="button" className="secondary" disabled={tasks.length >= 3} onClick={() => setTasks(previous => previous.length < 3
          ? [...previous, { id: crypto.randomUUID(), category: "foundation", content: "" }] : previous)}>添加任务</button>
        <button type="submit" className="primary">保存任务计划</button>
      </div>
    </fieldset>
    <button type="button" className="secondary learning-close-editor" disabled={locked} onClick={afterClose}>关闭任务表单</button>
  </form>;
}

function TaskRow({ task, block, target, locked, submit, source }: {
  task: LearningTask; block: LearningBlock; target: LearningDayInput; locked: boolean; submit: Submit;
  source?: NonNullable<LearningDay["planningSources"]>[string];
}) {
  const [result, setResult] = useState<{ text: string; revision: number }>();
  const active = block.status === "in_progress" && (task.status === "planned" || task.status === "in_progress");
  const stale = result !== undefined && result.revision !== block.revision;
  function update(status: TaskAction) {
    if (!active || locked || stale) return;
    submit({ ...change(target, block.id, result?.revision ?? block.revision), command: "recordTaskOutcome",
      taskId: task.id, status, resultNotes: result?.text ?? task.resultNotes ?? undefined }, () => setResult(undefined));
  }
  return <li className="learning-task" id={"learning-task-" + task.id} tabIndex={-1}>
    <div className="learning-task-head">
      <h4>{categoryLabels[task.category]}{task.subject && " · " + task.subject}</h4>
      <span className="learning-status">{taskLabels[task.status]}</span>
    </div>
    <p>{task.content}</p>
    {source?.linkState==="review"&&<p className="notice pending" role="status">规划来源待重新核对。任务结果仍可如实记录，请到学生学习规划确认来源。</p>}
    {source?.link&&source.linkState!=="review"&&<p className="muted">{source.linkState==="historical"?"历史关联":"计划关联"} · 规划第 {source.link.revision} 版</p>}
    {(task.knowledgePoints || task.plannedTarget || task.resultNotes || task.completedAt !== null) && <dl>
      {task.knowledgePoints && <div><dt>知识点</dt><dd>{task.knowledgePoints}</dd></div>}
      {task.plannedTarget && <div><dt>预期目标</dt><dd>{task.plannedTarget}</dd></div>}
      {task.resultNotes && <div><dt>已存结果</dt><dd>{task.resultNotes}</dd></div>}
      {task.completedAt !== null && <div><dt>记录时间</dt><dd>{factTime(task.completedAt)}</dd></div>}
    </dl>}
    {active && <>
      <label>任务结果<textarea rows={2} maxLength={1000} disabled={locked}
        value={result?.text ?? task.resultNotes ?? ""} onChange={event =>
          setResult({ text: event.target.value, revision: result?.revision ?? block.revision })} /></label>
      {stale && <div className="notice pending" role="alert">任务版本已变化。<button type="button" className="secondary"
        disabled={locked} onClick={() => setResult({ ...result, revision: block.revision })}>核对后保留结果输入</button></div>}
      <div className="learning-actions">
        {task.status === "planned" && <button className="secondary" type="button" disabled={locked || stale}
          onClick={() => update("in_progress")}>标记进行中</button>}
        <button className="secondary" type="button" disabled={locked || stale} onClick={() => update("done")}>记录完成</button>
        <button className="secondary" type="button" disabled={locked || stale} onClick={() => update("skipped")}>标记跳过</button>
      </div>
    </>}
    {!active && result && result.text.trim() !== task.resultNotes && <p className="notice pending">保留的未提交结果：{result.text}</p>}
  </li>;
}

function BlockCard({ block, target, locked, checkedOut, submit, onEdit, sources }: {
  block: LearningBlock; target: LearningDayInput; locked: boolean; checkedOut: boolean; submit: Submit; onEdit: () => void;
  sources?: LearningDay["planningSources"];
}) {
  const [taskForm, setTaskForm] = useState(false);
  const waiting = block.status === "planned";
  const hasActiveTask = block.tasks.some(task => task.status === "in_progress");
  const progress = block.tasks.filter(task => task.status === "done" || task.status === "skipped").length;
  function update(action: BlockAction) {
    if (action === "cancel" && !window.confirm("确认取消这个学习块？")) return;
    submit({ ...change(target, block.id, block.revision), command: "recordLearningOutcome", action });
  }
  return <article className="panel learning-block" aria-label={"学习块 " + range(block.plannedStart, block.plannedEnd)}>
    <header className="learning-task-head"><h3>{range(block.plannedStart, block.plannedEnd)}</h3>
      <span className="learning-status">{blockLabels[block.status]}</span></header>
    <p className="muted">任务已记录 {progress}/{block.tasks.length}</p>
    {block.outsideAttendanceReason && <p>超出到校时段原因：{block.outsideAttendanceReason}</p>}
    {block.notes && <p>{block.notes}</p>}
    {(block.actualStart !== null || block.actualEnd !== null) && <dl className="learning-times">
      <div><dt>实际开始</dt><dd>{factTime(block.actualStart)}</dd></div>
      <div><dt>实际结束</dt><dd>{factTime(block.actualEnd)}</dd></div>
    </dl>}
    <div className="learning-actions">
      {waiting && <>
        <button className="primary" type="button" disabled={locked || taskForm || checkedOut} onClick={() => update("start")}>开始学习块</button>
        <button className="secondary" type="button" disabled={locked} onClick={onEdit}>调整学习块</button>
        <button className="secondary" type="button" disabled={locked || taskForm} onClick={() => setTaskForm(true)}>编辑任务计划</button>
        <button className="secondary" type="button" disabled={locked || taskForm} onClick={() => update("cancel")}>取消学习块</button>
      </>}
      {block.status === "in_progress" && <button className="primary" type="button" disabled={locked || hasActiveTask}
        onClick={() => update("finish")}>结束学习块</button>}
    </div>
    {waiting && block.tasks.some(task=>sources?.[task.id]?.link) && <p className="muted">调整学习时段、任务学科或内容后，请重新核对规划来源。</p>}
    {waiting && checkedOut && <p className="muted">本次到校已签退，不能开始学习块。</p>}
    {block.status === "in_progress" && hasActiveTask && <p className="muted">请先完成或跳过进行中的任务，再结束学习块。</p>}
    {block.tasks.length ? <ol className="learning-task-list">{block.tasks.map(task =>
      <TaskRow key={task.id} task={task} block={block} target={target} locked={locked} submit={submit} source={sources?.[task.id]} />)}</ol>
      : <p className="muted learning-no-tasks">这个学习块还没有任务。</p>}
    {taskForm && <TaskForm block={block} target={target} locked={locked} submit={submit} afterClose={() => setTaskForm(false)} />}
  </article>;
}

export function AttendanceLearningPanel({ api, target, alias, reloadVersion, confirmedRequestId, blocked, submit, onBack, leaveGuard, focusTaskId, allowLeave, onQuickLearning, backLabel = "返回课表" }: {
  api: WorkspaceApi; target: LearningDayInput; alias: string; reloadVersion: number; confirmedRequestId?: string; blocked: boolean;
  submit: (command: LearningChange) => Promise<Result<AttendancePlan | LearningBlock>>; onBack: () => void; backLabel?: string; focusTaskId?: string; allowLeave?: boolean;
  leaveGuard: Ref<() => boolean>;
  onQuickLearning?: (studentId:string,attendanceId:string,date:string)=>void;
}) {
  const [data, setData] = useState<LearningDay>();
  const [reload, setReload] = useState(0);
  const [readError, setReadError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const queryKey = target.attendanceId + "/" + reload + "/" + reloadVersion;
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const [draft, setDraft] = useState<BlockDraft>();
  const [busy, setBusy] = useState(false);
  const [leaveReason, setLeaveReason] = useState<string>();
  const running = useRef(false);
  const pendingEditor = useRef<{ command: LearningChange; close: () => void } | undefined>(undefined);
  const focusedTask = useRef<string>(undefined);
  function canLeave() {
    return !running.current && (!(draft || leaveReason) || window.confirm("确认离开未保存的表单？"));
  }
  useImperativeHandle(leaveGuard, () => canLeave);
  useEffect(() => {
    let ignore = false;
    const query = { attendanceId: target.attendanceId, studentId: target.studentId };
    setReadError("");
    api.learningDay(query).then(result => {
      if (ignore) return;
      setLoadedKey(queryKey);
      if (!result.ok) { setReadError(result.message); return; }
      setData(result.value);
      const editor = pendingEditor.current;
      if (editor && editor.command.requestId === confirmedRequestId &&
          result.value.blocks.some(block => block.id === editor.command.id && block.revision > editor.command.expectedRevision)) {
        // Only close the editor whose request succeeded, after its saved revision is visible.
        pendingEditor.current = undefined;
        editor.close();
        setNotice({ error: false, text: "已核对并读取保存后的学习记录。" });
      }
    }).catch(() => { if (!ignore) setReadError("无法读取到校记录，请重试。"); });
    return () => { ignore = true; };
  }, [api, queryKey, target.attendanceId, target.studentId, confirmedRequestId]);
  function reread() { setReload(value => value + 1); }

  useEffect(() => {
    if (!focusTaskId || focusedTask.current === focusTaskId || !data || data.attendance.id !== target.attendanceId) return;
    const task = document.getElementById("learning-task-" + focusTaskId);
    if (!task) return;
    focusedTask.current = focusTaskId;
    task.scrollIntoView({ block: "center" });
    task.focus({ preventScroll: true });
  }, [focusTaskId, data, target.attendanceId]);

  const plan = data?.attendance;
  const locked = blocked || busy || loadedKey !== queryKey || Boolean(readError);
  async function save(command: LearningChange, saved?: () => void) {
    if (running.current || locked) return;
    running.current = true;
    setBusy(true);
    setNotice(undefined);
    pendingEditor.current = saved ? { command, close: saved } : undefined;
    try {
      const result = await submit(command);
      if (result.ok) {
        pendingEditor.current = undefined;
        setNotice({ error: false, text: "已保存。" });
        saved?.();
        reread();
      } else if (result.code !== "unknown") {
        if (result.code === "conflict" || result.code === "invalid") pendingEditor.current = undefined;
        setNotice({ error: true, text: result.message });
        if (result.code === "conflict") reread();
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function attendance(action: AttendanceAction) {
    if (!plan) return;
    if ((action === "cancel" || action === "absent") &&
        !window.confirm(action === "cancel" ? "确认取消本次到校安排？" : "确认标记本次缺席？")) return;
    void save({ ...change(target, plan.id, plan.revision), command: "recordAttendance", action });
  }
  function saveBlock(start: number, end: number, outside: boolean) {
    if (!draft) return;
    void save({ ...change(target, draft.id, draft.revision), command: "saveLearningBlock",
      plannedStart: start, plannedEnd: end, notes: draft.notes,
      outsideAttendanceReason: outside ? draft.reason : undefined }, () => setDraft(undefined));
  }

  function saveLeave() {
    if (!plan || !leaveReason?.trim()) return;
    void save({ ...change(target, plan.id, plan.revision), command: "recordAttendance", action: "leave", reason: leaveReason }, () => setLeaveReason(undefined));
  }

  const waiting = plan && (plan.status === "planned" || plan.status === "confirmed");
  const started = plan && plan.startAt <= Date.now();
  const hasStartedBlock = data?.blocks.some(block => block.actualStart !== null);
  const hasActiveBlock = data?.blocks.some(block => block.status === "in_progress");
  const hasLiveBlock = data?.blocks.some(block => block.status !== "cancelled");
  const mayAddBlock = plan && plan.status !== "absent" && plan.status !== "cancelled";
  const hasActions = waiting || (plan?.status === "attended" && plan.checkOutAt === null);

  return <section className="schedule-page learning-day" aria-labelledby="learning-day-title">
    <header className="schedule-heading">
      <div><button className="schedule-back" type="button" disabled={busy} onClick={() => { if (canLeave()) onBack(); }}>{backLabel}</button>
        <h1 id="learning-day-title" tabIndex={-1}>{alias} · 当日学习</h1>
        {plan && <p className="muted">{shanghaiParts(plan.startAt).date} · {plan.kind === "whole_day" ? "全天到校" : "普通到校"}</p>}</div>
      <button className="secondary" type="button" disabled={busy} onClick={reread}>重新读取本次到校</button>
    </header>
    {readError && <p className="notice failure" role="alert">
      {readError}{data && " 下方是上次读取的记录，写入已暂停。"}
    </p>}
    {data && loadedKey !== queryKey && !readError &&
      <p className="notice pending" role="status">正在从数据库核对。下方暂时显示上次读取的记录。</p>}
    {!data && !readError && <p className="muted" role="status">正在读取本次到校…</p>}
    {notice && <p className={"notice " + (notice.error ? "failure" : "success")} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {data && plan && <>
      <section className="panel learning-attendance" aria-labelledby="attendance-title">
        <header className="learning-task-head"><h2 id="attendance-title">到校记录</h2>
          <span className="learning-status">{plan.dayException?.action === "leave" ? "已请假" : plan.checkOutAt === null ? attendanceLabels[plan.status] : "已签退"}</span></header>
        <dl className="learning-times">
          <div><dt>计划到校</dt><dd>{range(plan.startAt, plan.endAt)}</dd></div>
          <div><dt>实际签到</dt><dd>{factTime(plan.checkInAt)}</dd></div>
          <div><dt>实际签退</dt><dd>{factTime(plan.checkOutAt)}</dd></div>
        </dl>
        {plan.exceptionReason && <p>时段外例外原因：{plan.exceptionReason}</p>}
        {hasActions && <div className="learning-actions">
          {waiting && <>
            <button type="button" className="primary" disabled={locked} onClick={() => attendance("checkIn")}>签到</button>
            {plan.status === "planned" && !started && <button type="button" className="secondary" disabled={locked}
              onClick={() => attendance("confirm")}>确认到校安排</button>}
            {started && !hasStartedBlock && <button type="button" className="secondary" disabled={locked}
              onClick={() => attendance("absent")}>标记缺席</button>}
            {!started && !hasLiveBlock && <button type="button" className="secondary" disabled={locked}
              onClick={() => attendance("cancel")}>取消到校</button>}
            {allowLeave && !hasLiveBlock && leaveReason === undefined && <button type="button" className="secondary"
              disabled={locked} onClick={() => setLeaveReason("")}>登记请假</button>}
            {leaveReason !== undefined && <label>请假原因<input value={leaveReason} maxLength={500} onChange={event => setLeaveReason(event.target.value)} />
              <button type="button" disabled={locked || !leaveReason.trim()} onClick={saveLeave}>保存请假</button>
              <button type="button" className="secondary" onClick={() => setLeaveReason(undefined)}>关闭请假输入</button></label>}
          </>}
          {plan.status === "attended" && plan.checkOutAt === null && <button type="button" className="primary"
            disabled={locked || hasActiveBlock} onClick={() => attendance("checkOut")}>签退</button>}
        </div>}
        {waiting && hasStartedBlock && <p className="notice pending" role="status">
          本次未签到，已有实际学习记录。请核对到校情况，确认已到后点击「签到」。本次无法标记缺席。
        </p>}
        {waiting && !started && hasLiveBlock && <p className="muted">取消到校前，须先核对关联学习块。</p>}
        {plan.status === "attended" && plan.checkOutAt === null && hasActiveBlock &&
          <p className="muted">请先结束进行中的学习块，再签退。</p>}
        {!hasActions && <p className="muted">本次出勤已结案，保留原记录供核对。</p>}
      </section>
      <div className="learning-task-head learning-blocks-head">
        <h2>学习块 · {data.blocks.length}</h2>
        {mayAddBlock && <button type="button" className="secondary" disabled={locked || Boolean(draft)}
          onClick={() => setDraft(blockDraft(plan))}>新建学习块</button>}
      </div>
      {onQuickLearning&&plan.checkInAt!==null&&<button type="button" className="secondary" disabled={locked}
        onClick={()=>onQuickLearning(plan.studentId,plan.id,shanghaiParts(plan.checkInAt!).date)}>快速学习登记</button>}
      {draft && <BlockForm plan={plan} draft={draft} latest={data.blocks.find(block => block.id === draft.id)}
        locked={locked} onDraft={setDraft} onSave={saveBlock} onClose={() => setDraft(undefined)} />}
      {!data.blocks.length && !draft && <p className="muted">这次到校还没有学习块。</p>}
      <div className="learning-block-list">{data.blocks.map(block => <BlockCard key={block.id} block={block} target={target}
        checkedOut={plan.checkOutAt !== null} locked={locked} sources={data.planningSources} submit={(command, saved) => void save(command, saved)} onEdit={() => {
          if (!draft || window.confirm("确认关闭当前学习块表单？")) setDraft(blockDraft(plan, block));
        }} />)}</div>
    </>}
  </section>;
}
