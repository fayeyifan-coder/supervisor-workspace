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
export interface PlanRecord { id: string; studentId: string; createdAt: number; source: PlanSource | null; initial: PlanDraft; versions?: PlanVersion[] }
export function emptyPlan(): PlanDraft {
  return { title:"", term:"", learner:"", grade:"", subjects:[], context:"", goals:"", habits:"", notes:"", entries:[] };
}
export const planUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function planDate(input: string): boolean { return input === "" || shanghaiMinute(input, "00:00") !== null; }

export interface PlanVersion {revision:number;effectiveOn:string;startsOn:string;endsOn:string;state:"draft"|"active"|"history";
  reason:string;changedAt:number;fields:PlanDraft}
export interface PlanVersionInput {studentId:string;planId:string;requestId:string;expectedRevision:number;effectiveOn:string;
  startsOn:string;endsOn:string;state:PlanVersion["state"];reason:string;fields:PlanDraft}

export interface PlanTaskLink {taskId:string;studentId:string;planId:string;revision:number;entryId:string;linkedAt:number}
export interface PlanTask {id:string;date:string;subject:string;content:string;status:"planned"|"in_progress"|"done"|"skipped";
 attendanceId:string|null;blockId:string;link:PlanTaskLink|null}
export interface PlanLinkInput {studentId:string;taskId:string;planId:string;revision:number;entryId:string}

export interface PlanBoardEntry {key:string;studentId:string;planId:string;planTitle:string;revision:number;entry:PlanEntry;actual:PlanTask[]}
export interface PlanBoardRow {
 studentId:string;alias:string;grade:string;lifecycle:"active"|"paused"|"archived";status:"active"|"missing"|"review"|"history";
 imported:number;plans:number;subjects:string[];
 today:{id:string;title:string;revision:number;subjects:string[];undated:number;unassigned:number}[];
 pending:{id:string;title:string}[];week:PlanBoardEntry[];month:PlanBoardEntry[];
}
export interface PlanBoardData {date:string;weekFrom:string;weekTo:string;monthFrom:string;monthTo:string;rows:PlanBoardRow[]}
