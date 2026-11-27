import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { defaultScheduleHours, shanghaiMinute, shanghaiParts, shiftDate, weekday, type ScheduleHours } from "./schedule-calendar";
import { WorkspaceFault } from "./workspace-fault";

export type CycleKind = "long_term" | "fixed" | "flex";
export interface CycleSlot { id: string; day: number; start: string; end: string }
export interface CycleDefinition { kind: CycleKind; startsOn: string; endsOn: string | null; paused: boolean; slots: CycleSlot[]; durationMinutes?: number }
export interface CycleRule extends CycleDefinition { id: string; studentId: string; revision: number; changedAt: number }
export interface ScheduleConfiguration { rules: CycleRule[]; hours: ScheduleHours; hoursRevision: number }
export interface ScheduleOrigin { ruleId: string; revision: number; slotId: string; date: string }
export interface FlexWindow extends ScheduleOrigin { id: string; studentId: string; start: string; end: string; durationMinutes: number }
export type DayExceptionAction = "rescheduled" | "leave" | "cancelled" | "walk_in";
export interface DayException { action: DayExceptionAction; reason: string }
export interface GenerationResult { created: number; existing: number; inactive: number; conflicts: number; elapsed: number }
export type CycleCommand =
  | { action: "rule"; requestId: string; id: string; studentId: string; expectedRevision: number; definition: CycleDefinition }
  | { action: "hours"; requestId: string; expectedRevision: number; hours: ScheduleHours }
  | { action: "generate"; from: string; to: string; studentId?: string }
  | { action: "confirmFlex"; window: ScheduleOrigin; start: string }
  | { action: "arriveFlex"; window: ScheduleOrigin }
  | { action: "walkIn"; requestId: string; studentId: string; durationMinutes: number };
export type CycleResult = { action: "rule"; rule: CycleRule } |
  { action: "hours"; revision: number } | { action: "generate"; result: GenerationResult } |
  { action: "visit"; plan: import("./operations").AttendancePlan };

const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const minute = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const maximumDate = "9998-12-31";
const ruleColumns = "id, revision, student_id AS studentId, request_id AS requestId, definition_json AS definition, changed_at AS changedAt";

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }
function conflict(message: string): never { throw new WorkspaceFault("conflict", message); }
export function scheduleObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("排课输入无效。");
  return raw as Record<string, unknown>;
}
export function scheduleId(value: unknown): string {
  if (typeof value !== "string" || !identifier.test(value)) invalid("排课身份无效。");
  return value;
}
function dateOf(value: unknown): string {
  if (typeof value !== "string" || shanghaiMinute(value, "00:00") === null) invalid("请输入有效的机构日期。");
  return value;
}
function versionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid("排课版本无效。");
  return value;
}
function interval(raw: unknown) {
  const { start, end } = scheduleObject(raw);
  if (typeof start !== "string" || typeof end !== "string" || !minute.test(start) || !minute.test(end) || start >= end) {
    invalid("时段须为同日有效的起止时间。");
  }
  return { start, end };
}
function compareTimes(left: { start: string; end: string }, right: { start: string; end: string }) {
  return left.start.localeCompare(right.start) || left.end.localeCompare(right.end);
}
function overlaps(left: { start: string; end: string }, right: { start: string; end: string }) {
  return left.start < right.end && right.start < left.end;
}
export function hoursOf(raw: unknown): ScheduleHours {
  if (!Array.isArray(raw) || raw.length !== 7) invalid("营业时间需包含一周七天。");
  return raw.map(day => {
    if (!Array.isArray(day) || day.length > 8) invalid("每日最多配置 8 段营业时间。");
    const periods = day.map(interval).sort(compareTimes);
    if (periods.some((slot, i) => i > 0 && overlaps(periods[i - 1], slot))) invalid("同日营业时间不能重叠。");
    return periods;
  });
}
function durationOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 15 || value > 480) invalid("预计学习时间为 15 至 480 分钟。");
  return value;
}
export function cycleDefinition(raw: unknown): CycleDefinition {
  const { kind, startsOn, endsOn, paused, slots, durationMinutes } = scheduleObject(raw);
  if (kind !== "long_term" && kind !== "fixed" && kind !== "flex") invalid("请选择有效排课类型。");
  if (typeof paused !== "boolean" || !Array.isArray(slots) || !slots.length || slots.length > 42) invalid("周期规则需要 1 至 42 个时段。");
  const first = dateOf(startsOn);
  const last = endsOn === null ? null : dateOf(endsOn);
  if (last && last < first) invalid("结束日期不能早于生效日期。");
  const entries = slots.map(rawSlot => {
    const slot = scheduleObject(rawSlot);
    const day = slot.day;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) invalid("周期时段的星期无效。");
    return { id: scheduleId(slot.id), day, ...interval(slot) };
  }).sort((a, b) => a.day - b.day || compareTimes(a, b));
  if (new Set(entries.map(slot => slot.id)).size !== entries.length ||
      entries.some((slot, i) => i > 0 && entries[i - 1].day === slot.day && overlaps(entries[i - 1], slot))) {
    invalid("该学生的周期时段重复或重叠。");
  }
  if (kind !== "flex") return { kind, startsOn: first, endsOn: last, paused, slots: entries };
  const duration = durationOf(durationMinutes ?? 120);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  if (entries.some(slot => slot.day === 0 || slot.day === 6 || minutes(slot.end) - minutes(slot.start) < duration)) {
    invalid("弹性安排限工作日，窗口须覆盖预计学习时长。");
  }
  return { kind, startsOn: first, endsOn: last, paused, slots: entries, durationMinutes: duration };
}
function decodeRule(row: Record<string, unknown>): CycleRule {
  assertCanonical(row.definition, cycleDefinition);
  return { id: scheduleId(row.id), studentId: scheduleId(row.studentId), revision: versionOf(row.revision),
    changedAt: Number(row.changedAt), ...cycleDefinition(JSON.parse(String(row.definition))) };
}
function assertCanonical(raw: unknown, parse: (input: unknown) => unknown) {
  if (typeof raw !== "string" || JSON.stringify(parse(JSON.parse(raw))) !== raw) invalid("排课历史内容不符合格式。");
}
export function recurringConfiguration(db: DatabaseSync): ScheduleConfiguration {
  const rules = db.prepare(`SELECT ${ruleColumns} FROM schedule_rule_revisions ORDER BY id, revision DESC`).all().map(decodeRule);
  const hours = db.prepare("SELECT revision,definition_json FROM schedule_hours_revisions ORDER BY revision DESC LIMIT 1").get();
  return { rules, hours: hours ? hoursOf(JSON.parse(String(hours.definition_json))) : defaultScheduleHours(), hoursRevision: Number(hours?.revision ?? 0) };
}
export function currentRules(rules: readonly CycleRule[]): CycleRule[] {
  const seen = new Set<string>();
  return rules.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
export function scheduleCommand(raw: unknown): CycleCommand {
  const data = scheduleObject(raw);
  if (data.action === "generate") {
    const from = dateOf(data.from), to = dateOf(data.to);
    if (to < from || Date.parse(to) - Date.parse(from) > 30 * 86_400_000) invalid("单次生成日期范围最多 31 天。");
    return { action: "generate", from, to, studentId: data.studentId === undefined ? undefined : scheduleId(data.studentId) };
  }
  if (data.action === "walkIn") return { action: "walkIn", requestId: scheduleId(data.requestId),
    studentId: scheduleId(data.studentId), durationMinutes: durationOf(data.durationMinutes ?? 120) };
  if (data.action === "confirmFlex" || data.action === "arriveFlex") {
    const value = scheduleObject(data.window);
    const window = { ruleId: scheduleId(value.ruleId), revision: versionOf(value.revision), slotId: scheduleId(value.slotId), date: dateOf(value.date) };
    if (data.action === "arriveFlex") return { action: data.action, window };
    if (typeof data.start !== "string" || !minute.test(data.start)) invalid("请选择具体预约开始时间。");
    return { action: data.action, window, start: data.start };
  }
  const requestId = scheduleId(data.requestId), expectedRevision = versionOf(data.expectedRevision);
  if (data.action === "hours") return { action: "hours", requestId, expectedRevision, hours: hoursOf(data.hours) };
  if (data.action !== "rule") return invalid("排课操作无效。");
  return { action: "rule", requestId, expectedRevision, id: scheduleId(data.id), studentId: scheduleId(data.studentId), definition: cycleDefinition(data.definition) };
}
function effectiveRulePeriods(rules: readonly CycleRule[]): CycleRule[] {
  const nextStart = new Map<string, string>();
  const periods: CycleRule[] = [];
  // History is ordered by rule ID and descending revision. A newer start closes earlier periods.
  for (const rule of rules) {
    const next = nextStart.get(rule.id);
    if (next && rule.startsOn >= next) continue;
    nextStart.set(rule.id, rule.startsOn);
    const cutoff = next ? shiftDate(next, -1) : null;
    const endsOn = cutoff && (!rule.endsOn || cutoff < rule.endsOn) ? cutoff : rule.endsOn;
    periods.push({ ...rule, endsOn });
  }
  return periods;
}

function periodsIntersect(a: CycleDefinition, b: CycleDefinition, weekDay: number) {
  const from = a.startsOn > b.startsOn ? a.startsOn : b.startsOn;
  const endA = a.endsOn ?? maximumDate, endB = b.endsOn ?? maximumDate;
  const to = endA < endB ? endA : endB;
  return from <= to && shiftDate(from, (weekDay - weekday(from) + 7) % 7) <= to;
}
export function persistCycleRule(db: DatabaseSync, input: Extract<CycleCommand, { action: "rule" }>, now: number): CycleRule {
  const { id, studentId, requestId, expectedRevision, definition } = input;
  const encoded = JSON.stringify(definition), next = expectedRevision + 1;
  const prior = db.prepare(`SELECT ${ruleColumns} FROM schedule_rule_revisions WHERE request_id=?`).get(requestId);
  if (prior) {
    if (prior.id !== id || prior.studentId !== studentId || prior.revision !== next || prior.definition !== encoded) conflict("该保存编号已用于另一条周期规则。");
    return decodeRule(prior);
  }
  const { rules } = recurringConfiguration(db);
  const current = currentRules(rules).find(rule => rule.id === id);
  if ((current?.revision ?? 0) !== expectedRevision || (current && current.studentId !== studentId)) conflict("规则已有新版本或归属不同，请重新读取。");
  if (!definition.paused && effectiveRulePeriods(rules).some(rule => rule.studentId === studentId && rule.id !== id && !rule.paused &&
    (rule.kind === "flex") === (definition.kind === "flex") &&
    rule.slots.some(existing => definition.slots.some(slot => slot.day === existing.day && overlaps(slot, existing) &&
      periodsIntersect(definition, rule, slot.day))))) conflict("同一学生已有重叠的长期或固定规则。");
  db.prepare("INSERT INTO schedule_rule_revisions VALUES(?,?,?,?,?,?)").run(id, next, studentId, requestId, encoded, now);
  return { ...definition, id, studentId, revision: next, changedAt: now };
}
export function persistScheduleHours(db: DatabaseSync, input: Extract<CycleCommand, { action: "hours" }>, now: number): number {
  const next = input.expectedRevision + 1;
  const encoded = JSON.stringify(input.hours);
  const prior = db.prepare("SELECT revision,definition_json FROM schedule_hours_revisions WHERE request_id=?").get(input.requestId);
  if (prior) {
    if (prior.revision !== next || prior.definition_json !== encoded) conflict("该保存编号已用于另一版营业时间。");
    return next;
  }
  const current = Number(db.prepare("SELECT max(revision) AS n FROM schedule_hours_revisions").get()?.n ?? 0);
  if (current !== input.expectedRevision) conflict("营业时间已更新，请重新读取。");
  db.prepare("INSERT INTO schedule_hours_revisions VALUES(?,?,?,?)").run(next, input.requestId, encoded, now);
  return next;
}
export function storedScheduleHours(db: DatabaseSync): ScheduleHours {
  const row = db.prepare("SELECT definition_json FROM schedule_hours_revisions ORDER BY revision DESC LIMIT 1").get();
  return row ? hoursOf(JSON.parse(String(row.definition_json))) : defaultScheduleHours();
}
export function rangeFitsHours(start: number, end: number, hours: ScheduleHours) {
  const a = shanghaiParts(start), b = shanghaiParts(end);
  return hours[weekday(a.date)].some(interval => a.time >= interval.start && b.time <= interval.end);
}
export function dateApplies(rule: CycleDefinition, date: string, slot: CycleSlot) {
  return date >= rule.startsOn && (!rule.endsOn || date <= rule.endsOn) && weekday(date) === slot.day;
}
export function stableScheduleId(...parts: string[]) {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export function verifyRecurringHistory(db: DatabaseSync, students: ReadonlySet<string>, flexEnabled: boolean) {
  const revisions = new Map<string, CycleRule>();
  const prior = new Map<string, CycleRule>();
  for (const row of db.prepare(`SELECT ${ruleColumns} FROM schedule_rule_revisions ORDER BY id,revision`).all()) {
    const rule = decodeRule(row);
    const prev = prior.get(rule.id);
    if ((!flexEnabled && rule.kind === "flex") || !students.has(rule.studentId) || rule.revision !== (prev?.revision ?? 0) + 1 ||
      (prev && prev.studentId !== rule.studentId)) invalid("周期规则的修订或学生归属无效。");
    scheduleId(row.requestId);
    prior.set(rule.id, rule);
    revisions.set(rule.id + "/" + rule.revision, rule);
  }
  let version = 0;
  for (const row of db.prepare("SELECT * FROM schedule_hours_revisions ORDER BY revision").all()) {
    if (row.revision !== ++version) invalid("营业时间修订不连续。");
    scheduleId(row.request_id);
    assertCanonical(row.definition_json, hoursOf);
  }
  for (const row of db.prepare("SELECT o.*,a.student_id FROM schedule_origins o JOIN attendance_plans a ON a.id=o.plan_id").all()) {
    const rule = revisions.get(row.rule_id + "/" + row.rule_revision);
    const slot = rule?.slots.find(item => item.id === row.slot_id);
    const date = dateOf(row.occurrence_date);
    if (!rule || rule.paused || !slot || rule.studentId !== row.student_id || !dateApplies(rule, date, slot) ||
      row.plan_id !== stableScheduleId("plan", rule.id, slot.id, date)) invalid("单日安排与原周期规则不一致。");
  }
}
