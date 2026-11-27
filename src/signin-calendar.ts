import { mondayOf, shanghaiMinute, shiftDate, weekday, type ScheduleInterval } from "./schedule-calendar";

export type SigninKind = "weekday" | "saturday" | "sunday";
export interface SigninInput { kind: SigninKind; period: string; slots: ScheduleInterval[]; studentId?: string }
export interface SigninMember { studentId: string; alias: string; dates: string[] }
export interface SigninGroup { label: string; members: SigninMember[] }
export interface SigninPreview {
  input: SigninInput; dates: string[]; groups: SigninGroup[];
  warnings: { alias: string; date: string; time: string; reason: string }[];
}
export interface SigninChange { group: number; studentId: string; date: string; include: boolean }
export interface SigninResult { location: string; names: number; slots: number }
export const signinLabels: Record<SigninKind, string> = {
  weekday: "工作日周签到表", saturday: "周六月签到表", sunday: "周日月签到表",
};

export function defaultSigninSlots(): ScheduleInterval[] {
  return [{start: "08:00", end: "10:00"}, {start: "10:00", end: "12:00"},
    {start: "14:00", end: "16:00"}, {start: "16:00", end: "18:00"}];
}

export function signinDates(kind: SigninKind, period: string): string[] {
  if (kind === "weekday") {
    if (shanghaiMinute(period, "00:00") === null) return [];
    const monday = mondayOf(period);
    return [1, 2, 3, 4].map(offset => shiftDate(monday, offset));
  }
  const first = period + "-01";
  if (!/^\d{4}-\d{2}$/.test(period) || shanghaiMinute(first, "00:00") === null || period >= "9998-12") return [];
  const dates: string[] = [];
  for (let date = first; date.startsWith(period); date = shiftDate(date, 1)) {
    if (weekday(date) === (kind === "saturday" ? 6 : 0)) dates.push(date);
  }
  return dates;
}
