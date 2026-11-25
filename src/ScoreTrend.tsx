import { useEffect, useRef, useState } from "react";
import type { StudentRecord } from "./student-records";
import { scoreTrend } from "./score-trend";

export function ScoreTrend({ records, studentId }: { records: StudentRecord[]; studentId: string }) {
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [requestedMode, setMode] = useState("rate");
  const [resetNotice, setResetNotice] = useState("");
  const view = scoreTrend(records, studentId, subject, category);
  // Persist the reset, so a reappearing subject cannot revive its former category.
  if (view.subjectChanged) {
    setSubject(view.subject); setCategory(""); setMode("rate");
    setResetNotice(subject + "学科已无有效成绩，类别筛选已清除。");
  }
  const mode = requestedMode === "raw" && view.rawAvailable ? "raw" : "rate";
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
          setSubject(event.target.value); setCategory(""); setMode("rate"); setResetNotice("");
        }}>
          {!view.subjects.length && <option value="">暂无学科</option>}
          {view.subjects.map(item => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label>考试类别
        <select value={view.category} onChange={event => { setSubject(view.subject); setCategory(event.target.value); setMode("rate"); setResetNotice(""); }}>
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
    </div>
    {resetNotice && <p role="status">{resetNotice}</p>}
    {view.invalidCount > 0 && <p role="status">{view.invalidCount} 条成绩缺少有效的学科、类别、日期或分数，未参与趋势；请核对原始记录。</p>}
    {!view.total ? <p role="status">{!view.subjects.length ? "暂无可用成绩，请先录入有效成绩。" : "当前学科和考试类别下没有成绩，请调整筛选。"}暂无可比较记录。</p> : <>
      <p className="muted">{view.subject} · {view.category || "全部类别"} · {mode === "rate" ? "得分率 = 得分 ÷ 满分" : `原始分数，满分 ${view.maximum}`} · 按考试日期排序 · 显示最近 {view.points.length} / {view.total} 次</p>
      {!view.rawAvailable && <p className="muted">满分不同，使用得分率观察，不比较原始分数差值。</p>}
      {view.total === 1 && <p role="status">仅有 1 条成绩，暂无可比较记录。</p>}
      <p className="muted">考试类别和难度可能不同；得分率变化仅供对照，不能据此判断学习能力提高或下降。</p>
      <div className="score-trend-plot"><canvas ref={canvas} width={720} height={250} aria-hidden="true" /></div>
      <ol className="score-trend-points">
        {view.points.map(({ record: { id, fields }, rate }) => <li key={id}>
          <time dateTime={fields.takenOn}>{fields.takenOn}</time> {fields.assessment} · {fields.category} · {fields.score}/{fields.maximum}（{rate.toFixed(1)}%）
        </li>)}
      </ol>
    </>}
  </section>;
}
