import type { StudentRecord } from "./student-records";

const numeric = /^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/;
function validDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export interface TrendOptions { from?: string; to?: string; selectedIds?: readonly string[]; recent?: 12 | 30 }
function valid(record: StudentRecord): boolean {
  const { subject, category, takenOn, score, maximum } = record.fields;
  if (!subject?.trim() || !category?.trim() || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(takenOn ?? "") ||
      !numeric.test(score ?? "") || !numeric.test(maximum ?? "")) return false;
  const date = new Date(takenOn + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === takenOn &&
    Number(maximum) > 0 && Number(score) <= Number(maximum);
}

export type RankDimension = "class" | "grade";

export function scoreRank(record: StudentRecord, dimension: RankDimension) {
  const rank = record.fields[dimension + "Rank"];
  const size = record.fields[dimension + "Size"];
  return { rank: rank ? Number(rank) : null, size: size ? Number(size) : null };
}

export function rankTrend(points: readonly { record: StudentRecord }[], dimension: RankDimension) {
  const ranks = points.map(({ record }) => scoreRank(record, dimension).rank);
  const available = ranks.filter((rank): rank is number => rank !== null);
  return { ranks, count: available.length, bottom: available.reduce((maximum, rank) => Math.max(maximum, rank), 1) };
}

export function scoreTrend(records: readonly StudentRecord[], studentId: string, chosenSubject = "", category = "", options: TrendOptions = {}) {
  const own = records.filter(record => record.studentId === studentId);
  const usable = own.filter(valid);
  const subjects = [...new Set(usable.map(record => record.fields.subject))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const subject = subjects.includes(chosenSubject) ? chosenSubject : subjects[0] ?? "";
  const sameSubject = usable.filter(record => record.fields.subject === subject);
  const categories = [...new Set(sameSubject.map(record => record.fields.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  // A category chosen for a disappeared subject must not silently filter its fallback.
  const effectiveCategory = chosenSubject && chosenSubject !== subject ? "" : category;
  const { from = "", to = "", selectedIds } = options;
  const rangeError = (from && !validDate(from)) || (to && !validDate(to))
    ? "请输入有效的起止日期。" : from && to && from > to ? "开始日期不能晚于结束日期。" : "";
  const matched = sameSubject.filter(record => !rangeError && (!effectiveCategory || record.fields.category === effectiveCategory) &&
    (!from || record.fields.takenOn >= from) && (!to || record.fields.takenOn <= to))
    .sort((a, b) => a.fields.takenOn.localeCompare(b.fields.takenOn) || a.savedAt - b.savedAt || a.id.localeCompare(b.id));
  const filtered = options.recent ? matched.slice(-options.recent) : matched;
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds);
  const participating = filtered.filter(record => !selected || selected.has(record.id));
  const maxima = new Set(participating.map(record => Number(record.fields.maximum)));
  return { subjects, subject, categories, category: effectiveCategory, subjectChanged: Boolean(chosenSubject && chosenSubject !== subject),
    subjectTotal: sameSubject.length, rangeTotal: matched.length, total: filtered.length, filtered, rangeError,
    removedSelection: selectedIds?.filter(id => !filtered.some(record => record.id === id)) ?? [], invalidCount: own.length - usable.length,
    rawAvailable: maxima.size === 1, mixedMaxima: maxima.size > 1, maximum: participating.length ? Number(participating[0].fields.maximum) : null,
    points: participating.map(record => ({ record, rate: Number(record.fields.score) / Number(record.fields.maximum) * 100 })) };
}
