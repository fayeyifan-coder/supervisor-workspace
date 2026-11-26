import type { StudentRecord } from "./student-records";

const numeric = /^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/;
function valid(record: StudentRecord): boolean {
  const { subject, category, takenOn, score, maximum } = record.fields;
  if (!subject?.trim() || !category?.trim() || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(takenOn ?? "") ||
      !numeric.test(score ?? "") || !numeric.test(maximum ?? "")) return false;
  const date = new Date(takenOn + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === takenOn &&
    Number(maximum) > 0 && Number(score) <= Number(maximum);
}

export function scoreTrend(records: readonly StudentRecord[], studentId: string, chosenSubject = "", category = "") {
  const own = records.filter(record => record.studentId === studentId);
  const usable = own.filter(valid);
  const subjects = [...new Set(usable.map(record => record.fields.subject))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const subject = subjects.includes(chosenSubject) ? chosenSubject : subjects[0] ?? "";
  const sameSubject = usable.filter(record => record.fields.subject === subject);
  const categories = [...new Set(sameSubject.map(record => record.fields.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  // A category chosen for a disappeared subject must not silently filter its fallback.
  const effectiveCategory = chosenSubject && chosenSubject !== subject ? "" : category;
  const filtered = sameSubject.filter(record => !effectiveCategory || record.fields.category === effectiveCategory)
    .sort((a, b) => a.fields.takenOn.localeCompare(b.fields.takenOn) || a.savedAt - b.savedAt || a.id.localeCompare(b.id));
  const maxima = new Set(filtered.map(record => Number(record.fields.maximum)));
  return { subjects, subject, categories, category: effectiveCategory, subjectChanged: Boolean(chosenSubject && chosenSubject !== subject),
    total: filtered.length, invalidCount: own.length - usable.length,
    rawAvailable: maxima.size === 1, maximum: filtered.length ? Number(filtered[0].fields.maximum) : null,
    points: filtered.slice(-12).map(record => ({ record, rate: Number(record.fields.score) / Number(record.fields.maximum) * 100 })) };
}
