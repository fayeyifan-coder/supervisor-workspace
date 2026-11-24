import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GrowthFields, GrowthGoal, GrowthGoalInput, GrowthObservation, GrowthObservationInput, GrowthProfileView, GrowthSaveInput, Student, WorkspaceApi } from "./contracts";

const blankFields: GrowthFields = {
  learningCharacteristics: "", communicationPreferences: "", currentSituation: "", strengths: "", weakAreas: "",
};

function today(): string {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}
function goalInput(goal: GrowthGoal): GrowthGoalInput {
  const { id, subject, targetScore, deadline, strategy, status } = goal;
  return { id, subject, targetScore, deadline, strategy, status };
}
function observationInput(row: GrowthObservation): GrowthObservationInput {
  const { id, observedOn, content } = row;
  return { id, observedOn, content };
}
function draftJson(fields: GrowthFields, goals: GrowthGoalInput[], observations: GrowthObservationInput[]): string {
  return JSON.stringify({ ...fields, goals, observations });
}
function prettyTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function GrowthProfilePanel({ student, api, onDirtyChange, onBusyChange }: {
  student: Student; api: WorkspaceApi; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [view, setView] = useState<GrowthProfileView>();
  const [profileFields, setProfileFields] = useState<GrowthFields>(blankFields);
  const [goals, setGoals] = useState<GrowthGoalInput[]>([]);
  const [observations, setObservations] = useState<GrowthObservationInput[]>([]);
  const [observationDate, setObservationDate] = useState(today());
  const [observationDraft, setObservationDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<GrowthSaveInput>();
  const [notice, setNotice] = useState<{ kind: "success" | "failure" | "pending"; text: string }>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const baseline = useRef("");
  const inFlight = useRef(false);
  const currentJson = draftJson(profileFields, goals, observations);
  const dirty = view !== undefined && (currentJson !== baseline.current || Boolean(observationDraft.trim()));
  const locked = loading || busy || pending !== undefined;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setView(undefined);
    setNotice(undefined);
    api.growthProfile(student.id).then(result => {
      if (!current) return;
      if (!result.ok) { setNotice({ kind: "failure", text: result.message }); return; }
      const data = result.value;
      const nextFields: GrowthFields = {
        learningCharacteristics: data.learningCharacteristics,
        communicationPreferences: data.communicationPreferences,
        currentSituation: data.currentSituation,
        strengths: data.strengths,
        weakAreas: data.weakAreas,
      };
      const nextGoals = data.goals.map(goalInput);
      const nextObservations = data.observations.map(observationInput);
      baseline.current = draftJson(nextFields, nextGoals, nextObservations);
      setView(data); setProfileFields(nextFields); setGoals(nextGoals); setObservations(nextObservations);
    }).catch(() => { if (current) setNotice({ kind: "failure", text: "无法读取成长档案，请重试。" }); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, student.id, reloadVersion]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(loading || busy || pending !== undefined); }, [loading, busy, pending, onBusyChange]);

  function accept(data: GrowthProfileView) {
    const nextFields: GrowthFields = {
      learningCharacteristics: data.learningCharacteristics,
      communicationPreferences: data.communicationPreferences,
      currentSituation: data.currentSituation,
      strengths: data.strengths,
      weakAreas: data.weakAreas,
    };
    const nextGoals = data.goals.map(goalInput), nextObservations = data.observations.map(observationInput);
    baseline.current = draftJson(nextFields, nextGoals, nextObservations);
    setView(data); setProfileFields(nextFields); setGoals(nextGoals); setObservations(nextObservations);
    setObservationDraft(""); setNotice({ kind: "success", text: `成长档案已保存（版本 ${data.revision}）。` }); setPending(undefined);
  }

  async function send(input: GrowthSaveInput) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    setNotice({ kind: "pending", text: "正在等待成长档案数据库确认保存…" });
    try {
      const result = await api.saveGrowthProfile(input);
      if (result.ok) accept(result.value);
      else if (result.code === "unknown") { setPending(input); setNotice({ kind: "pending", text: "保存结果暂不明确。可使用同一请求安全重试。" }); }
      else { setPending(undefined); setNotice({ kind: "failure", text: result.message }); }
    } catch {
      setPending(input); setNotice({ kind: "pending", text: "保存结果暂不明确。请使用同一请求安全重试。" });
    } finally { inFlight.current = false; setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || locked) return;
    void send({ requestId: crypto.randomUUID(), studentId: student.id, expectedRevision: view.revision,
      ...profileFields, goals, observations });
  }

  function addGoal() {
    setGoals(items => [...items, { id: crypto.randomUUID(), subject: "", targetScore: 0, deadline: today(), strategy: "", status: "active" }]);
  }
  function changeGoal(id: string, change: Partial<GrowthGoalInput>) {
    setGoals(items => items.map(item => item.id === id ? { ...item, ...change } : item));
  }
  function addObservation() {
    if (!observationDraft.trim()) { setNotice({ kind: "failure", text: "请先填写具体的学习行为观察。" }); return; }
    setObservations(rows => [...rows, { id: crypto.randomUUID(), observedOn: observationDate, content: observationDraft.trim() }]);
    setObservationDraft(""); setObservationDate(today()); setNotice(undefined);
  }
  function reload() {
    if (locked) return;
    if (dirty && !window.confirm("成长档案有未保存修改。重新读取会放弃这些修改，是否继续？")) return;
    setPending(undefined); setNotice(undefined); setReloadVersion(version => version + 1);
  }

  return <section className="panel growth-profile" aria-labelledby="growth-profile-heading">
    <div className="growth-heading">
      <div><h2 id="growth-profile-heading">成长档案</h2>
        <p className="muted">沿用 M1 的年级和学科；画像与观察可随时间更新。</p></div>
      <span className="growth-revision">{view?.exists ? `版本 ${view.revision}` : "尚未创建"}</span>
    </div>
    <p className="growth-backup-warning" role="note">独立本地数据库 growth.sqlite3 尚无经过验收的备份保护。当前阶段只用虚构学生资料。</p>
    {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "failure" ? "alert" : "status"}>
      {notice.text}{pending && <div className="retry-actions">
        <button className="secondary" disabled={busy} onClick={() => void send(pending)}>重试同一保存请求</button>
        <button className="secondary" disabled={busy} onClick={reload}>重新读取档案</button>
      </div>}
    </div>}
    {!loading && !view && notice?.kind === "failure" && <button className="secondary" type="button"
      onClick={() => setReloadVersion(version => version + 1)}>重新读取成长档案</button>}
    {loading && <p role="status" className="muted">正在读取该学生的成长档案…</p>}
    {!loading && view && <>
      <div className="growth-current" aria-label="当前重点">
        <div><h3>当前薄弱项</h3><p>{profileFields.weakAreas || "尚未记录"}</p></div>
        <div><h3>进行中的提分目标</h3>{goals.filter(goal => goal.status === "active").length
          ? <ul>{goals.filter(goal => goal.status === "active").map(goal => <li key={goal.id}>
            <strong>{goal.subject || "待填写学科"}</strong> · 目标 {goal.targetScore} 分 · 截止 {goal.deadline}
          </li>)}</ul> : <p>尚未设定</p>}</div>
      </div>
      <form onSubmit={save}>
        <fieldset disabled={locked} className="growth-fields">
          <label>当前学情<textarea rows={3} maxLength={2000} value={profileFields.currentSituation}
            onChange={event => setProfileFields(value => ({ ...value, currentSituation: event.target.value }))} /></label>
          <label>当前优势<textarea rows={3} maxLength={1500} value={profileFields.strengths}
            onChange={event => setProfileFields(value => ({ ...value, strengths: event.target.value }))} /></label>
          <label>当前薄弱项<textarea rows={3} maxLength={1500} value={profileFields.weakAreas}
            onChange={event => setProfileFields(value => ({ ...value, weakAreas: event.target.value }))} /></label>
          <label>学习特点<textarea rows={3} maxLength={2000} value={profileFields.learningCharacteristics}
            onChange={event => setProfileFields(value => ({ ...value, learningCharacteristics: event.target.value }))} /></label>
          <label>沟通偏好<textarea rows={2} maxLength={1000} value={profileFields.communicationPreferences}
            onChange={event => setProfileFields(value => ({ ...value, communicationPreferences: event.target.value }))} /></label>
        </fieldset>
        <section className="growth-subsection" aria-labelledby="growth-goals-heading">
          <div className="growth-subheading"><div><h3 id="growth-goals-heading">学科提分目标与干预策略</h3>
            <p className="muted">保留已暂停或已完成的目标，历史版本可回看。</p></div>
            <button className="secondary" type="button" disabled={locked} onClick={addGoal}>添加目标</button></div>
          {!goals.length && <p className="muted">尚未设定提分目标。</p>}
          <ul className="growth-goals">{goals.map(goal => <li key={goal.id}>
            <div className="growth-goal-row">
              <label>学科<input maxLength={40} required value={goal.subject} onChange={event => changeGoal(goal.id, { subject: event.target.value })} /></label>
              <label>目标分数<input type="number" min={0} max={100} step={1} required value={goal.targetScore}
                onChange={event => changeGoal(goal.id, { targetScore: Number(event.target.value) })} /></label>
              <label>期限<input type="date" required value={goal.deadline} onChange={event => changeGoal(goal.id, { deadline: event.target.value })} /></label>
              <label>目标状态<select value={goal.status} onChange={event => changeGoal(goal.id, { status: event.target.value as GrowthGoalInput["status"] })}>
                <option value="active">进行中</option><option value="paused">已暂停</option><option value="achieved">已完成</option>
              </select></label>
            </div>
            <label>干预策略<textarea rows={2} maxLength={1000} required value={goal.strategy}
              onChange={event => changeGoal(goal.id, { strategy: event.target.value })} /></label>
          </li>)}</ul>
        </section>
        <section className="growth-subsection" aria-labelledby="growth-observations-heading">
          <div className="growth-subheading"><div><h3 id="growth-observations-heading">按日期记录学习行为观察</h3>
            <p className="muted">已保存的观察只追加，不被画像修改覆盖。</p></div></div>
          <div className="growth-observation-add">
            <label>观察日期<input type="date" value={observationDate} disabled={locked} onChange={event => setObservationDate(event.target.value)} /></label>
            <label>具体观察<textarea rows={2} maxLength={1000} value={observationDraft} disabled={locked}
              onChange={event => setObservationDraft(event.target.value)} placeholder="记录日期、任务情境和可观察到的行为，不写固定性格标签。" /></label>
            <button className="secondary" type="button" disabled={locked || !observationDraft.trim()} onClick={addObservation}>加入本次保存</button>
          </div>
          {!observations.length && <p className="muted">还没有学习行为观察。</p>}
          <ol className="growth-observations">{[...observations].sort((a, b) => b.observedOn.localeCompare(a.observedOn)).map(row => {
            const saved = view.observations.some(item => item.id === row.id);
            return <li key={row.id}><time dateTime={row.observedOn}>{row.observedOn}</time><p>{row.content}</p>
              {!saved && <><span className="growth-unsaved">未保存</span>
                <button className="text-button" type="button" disabled={locked}
                  onClick={() => setObservations(items => items.filter(item => item.id !== row.id))}>移除</button></>}</li>;
          })}</ol>
        </section>
        <div className="growth-save-row">
          <button className="primary" type="submit" disabled={locked || (!dirty && view.exists) || Boolean(observationDraft.trim())}>保存成长档案</button>
          <button className="secondary" type="button" disabled={locked || !dirty} onClick={reload}>重新读取</button>
          {dirty && <span className="growth-unsaved" role="status">有未保存修改</span>}
        </div>
      </form>
      <section className="growth-history" aria-labelledby="growth-history-heading">
        <h3 id="growth-history-heading">修改历史与观察记录</h3>
        {!view.history.length && <p className="muted">保存首次档案后会在这里记录版本。</p>}
        <ol>{view.history.map(item => <li key={`${item.revision}-${item.requestId}`}>
          <details><summary>版本 {item.revision} · {prettyTime(item.changedAt)}</summary>
            <p><strong>当前学情：</strong>{item.snapshot.currentSituation || "未记录"}</p>
            <p><strong>优势：</strong>{item.snapshot.strengths || "未记录"}</p>
            <p><strong>薄弱项：</strong>{item.snapshot.weakAreas || "未记录"}</p>
            {item.snapshot.goals.map(goal => <p key={goal.id}><strong>{goal.subject} · {goal.targetScore} 分 · {goal.deadline}：</strong>{goal.strategy}（{goal.status}）</p>)}
            {item.snapshot.observations.map(row => <p key={row.id}><time dateTime={row.observedOn}>{row.observedOn}</time> · {row.content}</p>)}
          </details>
        </li>)}</ol>
      </section>
    </>}
  </section>;
}
