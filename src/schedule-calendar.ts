export const minute = 60_000;
const day = 1_440 * minute;

export function attendanceCounts(plans: readonly { studentId: string }[]): { students: number; visits: number } {
  return { students: new Set(plans.map(plan => plan.studentId)).size, visits: plans.length };
}

export function isLateArrival(plan: { startAt: number; checkInAt: number | null }): boolean {
  return plan.checkInAt !== null && Math.floor(plan.checkInAt / minute) > Math.floor(plan.startAt / minute);
}
const institution = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function shanghaiParts(at: number): { date: string; time: string } {
  const parts = Object.fromEntries(institution.formatToParts(at).map(part => [part.type, part.value]));
  return { date: parts.year.padStart(4, "0") + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute };
}

function calendarDate(date: string): number {
  return Date.parse(date + "T00:00:00Z");
}

export function shiftDate(date: string, days: number): string {
  return new Date(calendarDate(date) + days * day).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(calendarDate(date)).getUTCDay();
}

export function mondayOf(date: string): string {
  return shiftDate(date, -((weekday(date) + 6) % 7));
}

export function openingHours(date: string): { start: string; end: string } | null {
  switch (weekday(date)) {
    case 1: return null;
    case 0:
    case 6: return { start: "08:00", end: "18:00" };
    default: return { start: "16:00", end: "21:00" };
  }
}

export function shanghaiMinute(date: unknown, time: unknown): number | null {
  // The scheduling calendar starts after the last Shanghai daylight-saving transition.
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1992-01-01" || date >= "9999-01-01" ||
      typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const instant = Date.parse(date + "T" + time + ":00+08:00");
  if (!Number.isFinite(instant)) return null;
  const parts = shanghaiParts(instant);
  return parts.date === date && parts.time === time ? instant : null;
}

export function weekRange(monday: unknown): { startAt: number; endAt: number } | null {
  const startAt = shanghaiMinute(monday, "00:00");
  if (startAt === null || typeof monday !== "string" || weekday(monday) !== 1) return null;
  const endAt = shanghaiMinute(shiftDate(monday, 7), "00:00");
  return endAt === null ? null : { startAt, endAt };
}
