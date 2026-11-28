import { shanghaiMinute } from "./schedule-calendar";

export const documentLimit = 512 * 1024;
export const attachmentBudget = 12 * 1024 * 1024;
export const planTextLimit = 192 * 1024;

export interface PlanSourceCell {
  ref: string; text: string; span?: number; merge?: "start" | "continue";
}
export interface PlanEntry {
  id: string; subject: string; month: string; week: string; kind: "month" | "week" | "note";
  content: string; estimated: string; from: string; to: string; sources: string[];
}
export interface PlanDraft {
  title: string; term: string; learner: string; grade: string; subjects: string[];
  context: string; goals: string; habits: string; notes: string; entries: PlanEntry[];
}
export interface PlanDocumentReview {
  token: string; name: string; sha256: string; duplicate: boolean; fields: PlanDraft; cells: PlanSourceCell[]; warnings: string[];
}
export interface PlanPickResult { name: string; review?: PlanDocumentReview; issue?: string }
export interface PlanSource { sha256: string; filename: string; byteLength: number; importedAt: number }
export interface PlanRecord { id: string; studentId: string; createdAt: number; source: PlanSource | null; initial: PlanDraft }
export function emptyPlan(): PlanDraft {
  return { title:"", term:"", learner:"", grade:"", subjects:[], context:"", goals:"", habits:"", notes:"", entries:[] };
}
export const planUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function planDate(input: string): boolean { return input === "" || shanghaiMinute(input, "00:00") !== null; }
