export const channels = {
  students: "mvp:students",
  history: "mvp:history",
  createStudent: "mvp:create-student",
  addLesson: "mvp:add-lesson",
  workItems: "m2b:work-items",
  searchWorkItems: "m2b:search-work-items",
  workHistory: "m2b:work-history",
  saveWorkItem: "m2b:save-work-item",
  setWorkItemStatus: "m2b:set-work-item-status",
  growthProfile: "m2c:growth-profile",
  saveGrowthProfile: "m2c:save-growth-profile",
  pickStudentIntake: "m2c:pick-student-intake",
  prepareStudentIntake: "m2c:prepare-student-intake",
  saveStudentIntake: "m2c:save-student-intake",
  studentIntakeHistory: "m2c:student-intake-history",
  exportProtection: "m2d:export",
  restoreProtection: "m2d:restore",
  activationStatus: "m2d:activation-status",
  activateRecovery: "m2d:activate-recovery",
  returnOriginalProfile: "m2d:return-original",
  scheduleAvailable: "r2b:schedule-available",
  scheduleWeek: "r2b:schedule-week",
  schedulePlan: "r2b:schedule-plan",
  saveSchedulePlan: "r2b:save-schedule-plan",
} as const;

export type { WorkChange, WorkItem, WorkItemInput, WorkStatus } from "./worklog";
export type { GrowthFields, GrowthGoal, GrowthGoalInput, GrowthHistory, GrowthObservation,
  GrowthObservationInput, GrowthProfileView, GrowthSaveInput, GrowthSnapshot, GoalStatus } from "./growth-profile";

export type { IntakeConfirm, IntakeFile, IntakeHistoryEntry, IntakeOutcome, IntakeReview, IntakeTarget } from "./student-intake";
import type { IntakeConfirm, IntakeFile, IntakeHistoryEntry, IntakeOutcome, IntakeReview, IntakeTarget } from "./student-intake";

export interface StudentInput {
  id: string;
  alias: string;
  grade: string;
  subjects: string;
  goal: string;
  notes: string;
}

export interface LessonInput {
  id: string;
  studentId: string;
  date: string;
  subject: string;
  task: string;
  completion: string;
  assessment: string;
  nextStep: string;
}

export type Student = StudentInput & { createdAt: number };
export type Lesson = LessonInput & { createdAt: number };
export type Failure = {
  ok: false;
  code: "invalid" | "conflict" | "busy" | "failed" | "unknown" | "recovery";
  message: string;
};
export type Result<T> = { ok: true; value: T } | Failure;

import type { ProtectionResult } from "./offline-protection";
export type { ProtectionResult } from "./offline-protection";

import type { AttendancePlan, SaveAttendancePlanInput } from "./operations";
export type { AttendancePlan } from "./operations";

export interface ScheduleWeekInput { monday: string; studentId?: string }
export type ScheduleSaveInput = SaveAttendancePlanInput & { endAt: number; kind: AttendancePlan["kind"] };

export interface WorkspaceApi {
  scheduleAvailable(): Promise<Result<boolean>>;
  scheduleWeek(input: ScheduleWeekInput): Promise<Result<AttendancePlan[]>>;
  schedulePlan(id: string): Promise<Result<AttendancePlan | null>>;
  saveSchedulePlan(input: ScheduleSaveInput): Promise<Result<AttendancePlan>>;
  exportProtection(): Promise<Result<ProtectionResult | null>>;
  restoreProtection(): Promise<Result<ProtectionResult | null>>;
  activationStatus(): Promise<Result<{ active: string | null; pending: boolean; location: string }>>;
  activateRecovery(): Promise<Result<boolean>>;
  returnOriginalProfile(): Promise<Result<boolean>>;
  students(): Promise<Result<Student[]>>;
  history(studentId: string): Promise<Result<Lesson[]>>;
  createStudent(input: StudentInput): Promise<Result<Student>>;
  addLesson(input: LessonInput): Promise<Result<Lesson>>;
  workItems(today: string): Promise<Result<import("./worklog").WorkItem[]>>;
  searchWorkItems(from: string, to: string, query?: string): Promise<Result<import("./worklog").WorkItem[]>>;
  workHistory(id: string): Promise<Result<import("./worklog").WorkChange[]>>;
  saveWorkItem(input: import("./worklog").WorkItemInput): Promise<Result<import("./worklog").WorkItem>>;
  setWorkItemStatus(id: string, status: import("./worklog").WorkStatus): Promise<Result<import("./worklog").WorkItem>>;
  pickStudentIntake(): Promise<Result<IntakeFile[]>>;
  prepareStudentIntake(token: string, target?: IntakeTarget): Promise<Result<IntakeReview>>;
  saveStudentIntake(input: IntakeConfirm): Promise<Result<IntakeOutcome>>;
  studentIntakeHistory(studentId: string): Promise<Result<IntakeHistoryEntry[]>>;
  growthProfile(studentId: string): Promise<Result<import("./growth-profile").GrowthProfileView>>;
  saveGrowthProfile(input: import("./growth-profile").GrowthSaveInput): Promise<Result<import("./growth-profile").GrowthProfileView>>;
}
