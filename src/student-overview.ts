import type { AttendancePlan, LearningBlock, Lesson } from "./contracts";
import type { GrowthProfileView } from "./growth-profile";
import type { ParentFollowUpView } from "./parent-follow-up";
import type { StudentRecord } from "./student-records";
import { scoreRank, scoreTrend } from "./score-trend";

export interface OverviewSources {
  studentId: string;
  concerns: ParentFollowUpView;
  scores: StudentRecord[];
  growth: GrowthProfileView;
  history: Lesson[];
  visits: { plan: AttendancePlan; blocks: LearningBlock[] }[];
  now: number;
}

export type StudentOverviewData = ReturnType<typeof summarizeStudentOverview>;

export function summarizeStudentOverview({ studentId, concerns, scores, growth, history, visits, now }: OverviewSources) {
  const followUps = concerns.studentId === studentId ? concerns.concerns.filter(row => row.studentId === studentId).map(row => {
    const latest = row.followUps.find(item => item.studentId === studentId && item.concernId === row.requestId);
    return { id: row.requestId, concern: row.concern, status: latest?.status ?? "open" as const,
      nextOn: latest ? latest.nextOn : row.nextOn, reportedOn: row.reportedOn };
  }) : [];
  const outstanding = followUps.filter(row => row.status !== "resolved").sort((a, b) =>
    (a.nextOn || "9999-99-99").localeCompare(b.nextOn || "9999-99-99") || b.reportedOn.localeCompare(a.reportedOn));
  const selectedConcerns = outstanding.length ? outstanding.slice(0, 3) : followUps.slice(0, 1);

  const recent = scores.filter(row => row.studentId === studentId).sort((a, b) =>
    b.fields.takenOn.localeCompare(a.fields.takenOn) || b.savedAt - a.savedAt || b.id.localeCompare(a.id))[0];
  const records = recent ? scoreTrend(scores, studentId, recent.fields.subject).points : [];
  const latest = records.at(-1);
  const recentScore = latest && { id: latest.record.id, date: latest.record.fields.takenOn, subject: latest.record.fields.subject,
    name: latest.record.fields.assessment, score: latest.record.fields.score, maximum: latest.record.fields.maximum,
    rate: latest.rate, classRank: scoreRank(latest.record, "class"), gradeRank: scoreRank(latest.record, "grade") };
  const recentTrend = records.slice(-3).map(({ record, rate }) => ({ id: record.id, date: record.fields.takenOn, name: record.fields.assessment, rate }));

  const goals = growth.studentId === studentId ? growth.goals.filter(goal => goal.status === "active")
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.id.localeCompare(b.id)).slice(0, 3) : [];
  const situation = growth.studentId === studentId ? growth.currentSituation : "";
  const ownVisits = visits.filter(({ plan }) => plan.studentId === studentId && (plan.status === "planned" || plan.status === "confirmed" ||
    (plan.status === "attended" && plan.checkOutAt === null)));
  const attendance = ownVisits.filter(({ plan }) => plan.status !== "attended" && plan.endAt > now)
    .slice(0, 3).map(({ plan }) => ({ id: plan.id, startAt: plan.startAt, endAt: plan.endAt }));
  const tasks = ownVisits.flatMap(({ plan, blocks }) => blocks
    .filter(block => block.studentId === studentId && block.attendancePlanId === plan.id && (block.status === "planned" || block.status === "in_progress"))
    .flatMap(block => block.tasks.filter(task => task.status === "planned" || task.status === "in_progress")
      .map(({ id, content, status, subject }) => ({ id, visitId: plan.id, at: block.plannedStart, content, status, subject }))))
    .sort((a, b) => a.at - b.at).slice(0, 3);
  const latestAction = history.find(row => row.studentId === studentId && row.nextStep.trim());
  const nextAction = latestAction ? { id: latestAction.id, text: latestAction.nextStep, date: latestAction.date } : undefined;
  return { studentId, concerns: selectedConcerns, openConcerns: outstanding.length, recentScore, recentTrend,
    goals, situation, attendance, tasks, nextAction };
}
