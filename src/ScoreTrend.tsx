import { useEffect, useRef, useState } from "react";
import type { StudentRecord } from "./student-records";
import { scoreTrend } from "./score-trend";

export function ScoreTrend({ records, studentId }: { records: StudentRecord[]; studentId: string }) {
  const [owner, setOwner] = useState(studentId);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [requestedMode, setMode] = useState("rate");
  const [resetNotice, setResetNotice] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [selection, setSelection] = useState<{ id: string; revision: number }[]>([]);
  const [page, setPage] = useState(0);
  const [recent, setRecent] = useState<12 | 30>();
  if (owner !== studentId) {
    setOwner(studentId); setSubject(""); setCategory(""); setMode("rate"); setResetNotice("");
    setFrom(""); setTo(""); setCompare(false); setSelection([]); setPage(0);
    setRecent(undefined);
  }
  const view = scoreTrend(records, studentId, subject, category, { from, to, recent, selectedIds: compare ? selection.map(row => row.id) : undefined });
  const currentSelection = selection.flatMap(item => {
    const row = view.filtered.find(record => record.id === item.id);
    return row ? [{ id: row.id, revision: row.revision }] : [];
  });
  if (!view.rangeError && JSON.stringify(currentSelection) !== JSON.stringify(selection)) {
    const removed = selection.length - currentSelection.length;
    setSelection(currentSelection);
    setResetNotice(removed ? `${removed} 条所选考试已不在当前筛选中，已清除选择。` : "所选考试已更新，当前采用最新保存版本。");
  }
  // Persist the reset, so a reappearing subject cannot revive its former category.
  if (view.subjectChanged) {
    setSubject(view.subject); setCategory(""); setMode("rate");
    setSelection([]); setPage(0);
    setResetNotice(subject + "学科已无有效成绩，类别筛选已清除。");
  }
  const mode = requestedMode === "raw" && view.rawAvailable ? "raw" : "rate";
  const pages = Math.max(1, Math.ceil(view.filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const visible = view.filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 720, 250); ctx.font = "12px system-ui"; ctx.textAlign = "right";
    const ceiling = mode === "raw" ? view.maximum! : 100;
    for (const fraction of [1, .75, .5, .25, 0]) {
      const y = 18 + (1 - fraction) * 165;
      ctx.fillStyle = "#43504c";
      ctx.fillText(mode === "raw" ? Number((ceiling * fraction).toFixed(2)) + "分" : fraction * 100 + "%", 84, y + 5);
      ctx.strokeStyle = "#d5dfd8"; ctx.beginPath(); ctx.moveTo(94, y); ctx.lineTo(685, y); ctx.stroke();
    }
    const locations = view.points.map(({ record, rate }, index) => ({
      x: view.points.length === 1 ? 385 : 106 + index * 564 / (view.points.length - 1),
      y: 183 - rate * 1.65, label: record.fields.takenOn,
    }));
    ctx.strokeStyle = "#17664d"; ctx.lineWidth = 2; ctx.beginPath();
    locations.forEach(({ x, y }, i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)); ctx.stroke();
    ctx.fillStyle = "#17664d";
    locations.forEach(({ x, y, label }, i) => {
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
      if (i === 0 || i === locations.length - 1 || i % Math.ceil(locations.length / 4) === 0) {
        ctx.textAlign = "center"; ctx.fillText(label, x, 211);
      }
    });
  }, [view, mode]);

  return <section className="score-trend" aria-label="成绩趋势可视化">
    <div className="score-trend-controls">
      <label>学科
        <select value={view.subject} disabled={!view.subjects.length} onChange={event => {
          setSubject(event.target.value); setCategory(""); setMode("rate"); setResetNotice(""); setPage(0);
        }}>
          {!view.subjects.length && <option value="">暂无学科</option>}
          {view.subjects.map(item => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label>考试类别
        <select value={view.category} onChange={event => { setSubject(view.subject); setCategory(event.target.value); setMode("rate"); setResetNotice(""); setPage(0); }}>
          <option value="">全部类别</option>
          {view.category && !view.categories.includes(view.category) && <option value={view.category}>{view.category}（已无记录）</option>}
          {view.categories.map(item => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label>趋势口径
        <select value={mode} onChange={event => setMode(event.target.value)}>
          <option value="rate">得分率</option>
          <option value="raw" disabled={!view.rawAvailable}>原始分数</option>
        </select>
      </label>
      <label>开始日期（含）<input type="date" aria-label="开始日期" value={from} onChange={event => { setFrom(event.target.value); setPage(0); }} /></label>
      <label>结束日期（含）<input type="date" aria-label="结束日期" value={to} onChange={event => { setTo(event.target.value); setPage(0); }} /></label>
      <button type="button" onClick={() => { setFrom(""); setTo(""); setCategory(""); setPage(0); }}>清除时间及类别筛选</button>
      <div className="retry-actions" role="group" aria-label="成绩快捷范围">
        {([12, 30, undefined] as const).map(value => <button type="button" key={value ?? "all"} aria-pressed={recent === value}
          onClick={() => { setRecent(value); setPage(0); }}>{value ? `最近${value}次` : "全部成绩"}</button>)}
      </div>
      <label className="score-compare-toggle"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />自定义考试对比</label>
    </div>
    {resetNotice && <p role="status">{resetNotice}</p>}
    {view.rangeError && <p role="alert">{view.rangeError}</p>}
    {compare && <p role="status">已选择 {view.points.length} 条考试；请在下方记录中勾选至少 2 条。同一学生、同一学科内对比。</p>}
    {view.invalidCount > 0 && <p role="status">{view.invalidCount} 条成绩缺少有效的学科、类别、日期或分数，未参与趋势；请核对原始记录。</p>}
    {!view.total ? <p role="status">{!view.subjects.length ? "暂无可用成绩，请先录入有效成绩。" : "当前学科和考试类别下没有成绩，请调整筛选。"}暂无可比较记录。</p> : <>
      <p className="muted">{view.subject} · {view.category || "全部类别"} · {mode === "rate" ? "得分率 = 得分 ÷ 满分" : `原始分数，满分 ${view.maximum}`} · 按考试日期排序的考试序列（等间距不代表日期间隔） · 学科全部 {view.subjectTotal} 次 / 筛选 {view.total} 次 / 绘图 {view.points.length} 次</p>
      {recent && <p className="muted">时间及类别筛选共 {view.rangeTotal} 次，当前查看最近 {recent} 次；按考试日期选取，同日合法记录独立保留。</p>}
      {view.mixedMaxima && <p className="muted">满分不同，使用得分率观察，不比较原始分数差值。</p>}
      {view.points.length === 1 && <p role="status">仅有 1 条成绩，暂无可比较记录。</p>}
      <p className="muted">考试类别和难度可能不同；得分率变化仅供对照，不能据此判断学习能力提高或下降。</p>
      <div className="score-trend-plot"><canvas ref={canvas} width={720} height={250} data-point-count={view.points.length} aria-hidden="true" /></div>
      <p className="muted">记录第 {view.total ? currentPage * 50 + 1 : 0}—{Math.min((currentPage + 1) * 50, view.total)} / {view.total} 条；分页不改变绘图和对比范围。</p>
      <ol className="score-trend-points" start={currentPage * 50 + 1}>
        {visible.map(({ id, fields, revision }) => <li key={id}>
          {compare && <label><input type="checkbox" aria-label={`对比 ${fields.assessment}`} checked={selection.some(row => row.id === id)} onChange={event => setSelection(items => event.target.checked ? [...items, { id, revision }] : items.filter(row => row.id !== id))} />参与对比</label>}
          <time dateTime={fields.takenOn}>{fields.takenOn}</time> {fields.assessment} · {fields.category} · {fields.score}/{fields.maximum}（{(Number(fields.score) / Number(fields.maximum) * 100).toFixed(1)}%）
        </li>)}
      </ol>
      {pages > 1 && <nav aria-label="成绩记录分页"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage + 1} / {pages} 页</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
    </>}
  </section>;
}
