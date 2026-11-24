import { useEffect, useRef, useState } from "react";
import type { StudentRecord } from "./student-records";

export function ScoreTrend({ records }: { records: StudentRecord[] }) {
  const groups = new Map<string, { label: string; records: StudentRecord[] }>();
  for (const record of records) {
    const { subject, category } = record.fields;
    const key = JSON.stringify([subject, category]);
    const group = groups.get(key) ?? { label: subject + " · " + category, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const [chosen, setChosen] = useState("");
  const selected = groups.has(chosen) ? chosen : groups.keys().next().value ?? "";
  const points = [...(groups.get(selected)?.records ?? [])]
    .sort((a, b) => a.fields.takenOn.localeCompare(b.fields.takenOn) || a.savedAt - b.savedAt || a.id.localeCompare(b.id))
    .slice(-12);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 720, 218);
    ctx.font = "14px system-ui";
    ctx.textAlign = "right";
    for (const value of [100, 75, 50, 25, 0]) {
      const y = 18 + (100 - value) * 1.65;
      ctx.fillStyle = "#43504c";
      ctx.fillText(value + "%", 54, y + 5);
      ctx.strokeStyle = "#d5dfd8";
      ctx.beginPath();
      ctx.moveTo(64, y);
      ctx.lineTo(685, y);
      ctx.stroke();
    }
    const locations = points.map(({ fields }, index) => ({
      x: points.length === 1 ? 365 : 77 + index * 590 / (points.length - 1),
      y: 183 - Number(fields.score) / Number(fields.maximum) * 165,
      label: fields.takenOn.slice(5),
    }));
    ctx.strokeStyle = "#17664d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    locations.forEach(({ x, y }, index) => index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.stroke();
    ctx.fillStyle = "#17664d";
    ctx.textAlign = "center";
    locations.forEach(({ x, y, label }) => {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(label, x, 206);
    });
  });
  if (!points.length) return null;
  return <section className="score-trend" aria-label="同类成绩可视化">
    <label>学科与考试类别
      <select value={selected} onChange={event => setChosen(event.target.value)}>
        {[...groups].map(([key, group]) => <option key={key} value={key}>{group.label}</option>)}
      </select>
    </label>
    <p className="muted">最近 12 次 · 按日期顺序 · 得分率 = 得分 ÷ 满分</p>
    <div className="score-trend-plot"><canvas ref={canvas} width={720} height={218} aria-hidden="true" /></div>
    <ol className="score-trend-points">
      {points.map(({ id, fields }) => <li key={id}>
        <time dateTime={fields.takenOn}>{fields.takenOn}</time> {fields.assessment} · {fields.score}/{fields.maximum}（{(Number(fields.score) / Number(fields.maximum) * 100).toFixed(1)}%）
      </li>)}
    </ol>
  </section>;
}
