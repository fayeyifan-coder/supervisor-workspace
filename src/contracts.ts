export const channels = {
  students: "mvp:students",
  pickStudyPlans: "plan:pick", saveStudyPlan: "plan:save", studyPlans: "plan:list",
  studyPlanSource: "plan:source", createManualPlan: "plan:manual", savePlanVersion: "plan:version",
  planTasks: "plan:tasks", linkPlanTask: "plan:link-task", exportStudyPlanSource: "plan:export-source",
  history: "mvp:history",
  createStudent: "mvp:create-student",
  studentEditAvailable: "mvp:student-edit-available",
  studentEdit: "mvp:student-edit",
  saveStudentEdit: "mvp:save-student-edit",
  finishStudentEdit: "mvp:finish-student-edit",
  parentFollowUpAvailable: "mvp:parent-follow-up-available",
  parentFollowUp: "mvp:parent-follow-up",
  createParentConcern: "mvp:create-parent-concern",
  appendParentFollowUp: "mvp:append-parent-follow-up",
  studentRecordVersion: "mvp:student-record-version",
  studentRecords: "mvp:student-records",
  saveStudentRecord: "mvp:save-student-record",
  studentLifecycle: "mvp:student-lifecycle",
  studentOverview: "mvp:student-overview",
  saveStudentLifecycle: "mvp:save-student-lifecycle",
  studentWriteState: "mvp:student-write-state",
  resolveStudentWrite: "mvp:resolve-student-write",
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
  previewSignin: "r3:preview-signin",
  exportSignin: "r3:export-signin",
  prepareBusinessExport: "m2e:prepare-export",
  writeBusinessExport: "m2e:write-export",
  cancelBusinessExport: "m2e:cancel-export",
  restoreProtection: "m2d:restore",
  activationStatus: "m2d:activation-status",
  workspaceInfo: "mvp:workspace-info",
  activateRecovery: "m2d:activate-recovery",
  returnOriginalProfile: "m2d:return-original",
  scheduleAvailable: "r2b:schedule-available",
  scheduleConfiguration: "r3:schedule-configuration",
  changeCycleSchedule: "r3:change-cycle-schedule",
  scheduleFlexWeek: "r3:schedule-flex-week",
  scheduleWeek: "r2b:schedule-week",
  schedulePlan: "r2b:schedule-plan",
  attendanceBoard: "r2b:attendance-board",
  saveSchedulePlan: "r2b:save-schedule-plan",
  learningDay: "r2b:learning-day",
  applyLearningChange: "r2b:apply-learning-change",
  scheduleReceipt: "r2b:schedule-receipt",
  pendingOperation: "r2b:pending-operation",
  acknowledgeOperation: "r2b:acknowledge-operation",
} as const;

export type { WorkChange, WorkItem, WorkItemInput, WorkStatus } from "./worklog";
export type { GrowthFields, GrowthGoal, GrowthGoalInput, GrowthHistory, GrowthObservation,
  GrowthObservationInput, GrowthProfileView, GrowthSaveInput, GrowthSnapshot, GoalStatus } from "./growth-profile";

export type { IntakeConfirm, IntakeFile, IntakeHistorySummary, IntakeOutcome, IntakeReview, IntakeTarget } from "./student-intake";
import type { IntakeConfirm, IntakeFile, IntakeHistorySummary, IntakeOutcome, IntakeReview, IntakeTarget } from "./student-intake";

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

import type { LifecycleChange, LifecycleInput, LifecycleStatus, LifecycleView } from "./student-lifecycle";
export type Student = StudentInput & { createdAt: number; lifecycleStatus?: LifecycleStatus };
export type StudentEditFields = Omit<StudentInput, "id">;
export interface StudentEditInput {
  studentId: string;
  requestId: string;
  expectedRevision: number;
  fields: StudentEditFields;
}
export interface StudentEditRecord {
  requestId: string;
  revision: number;
  changedAt: number;
  before: StudentEditFields;
  after: StudentEditFields;
}
export interface StudentEditView {
  student: Student;
  revision: number;
  history: StudentEditRecord[];
  pending: StudentEditInput | null;
}
import type { ParentConcern, ParentConcernInput, ParentFollowUp, ParentFollowUpInput, ParentFollowUpView } from "./parent-follow-up";
export type { ParentConcern, ParentConcernInput, ParentFollowUp, ParentFollowUpInput, ParentFollowUpView } from "./parent-follow-up";
import type { StudentRecord, StudentRecordInput, StudentRecordKind, StudentRecordView } from "./student-records";
export type StudentWriteCommand =
  | { kind: "concern"; input: ParentConcernInput }
  | { kind: "followUp"; input: ParentFollowUpInput }
  | { kind: "record"; input: StudentRecordInput }
  | { kind: "lifecycle"; input: LifecycleInput };
export type StudentWriteState =
  | { kind: "empty" }
  | { kind: "damaged"; requestId?: string }
  | { kind: "pending"; command: StudentWriteCommand; outcome: "saved" | "notSaved" | "unknown" };
export type StudentWriteAction = "retry" | "confirm" | "discard" | "archive";
export type Lesson = LessonInput & { createdAt: number };
export type Failure = {
  ok: false;
  code: "invalid" | "conflict" | "busy" | "failed" | "unknown" | "recovery";
  message: string;
};
export type Result<T> = { ok: true; value: T } | Failure;

import type { ProtectionResult } from "./offline-protection";
export type { ProtectionResult } from "./offline-protection";

import type { AttendancePlan, LearningBlock, LearningTaskInput, SaveAttendancePlanInput } from "./operations";
export type { AttendancePlan, LearningBlock, LearningTask, LearningTaskInput } from "./operations";

export interface ScheduleWeekInput { monday: string; studentId?: string }
export type ScheduleSaveInput = SaveAttendancePlanInput & { endAt: number; kind: AttendancePlan["kind"] };

export interface LearningDayInput {
  attendanceId: string;
  studentId: string;
}

export type AttendanceBoardStatus = "upcoming" | "unchecked" | "checked_in" | "learning" | "checked_out" | "absent" | "cancelled" | "leave";
export interface AttendanceBoardDay {
  date: string;
  flexWindows?: import("./recurring-schedule").FlexWindow[];
  entries: { plan: AttendancePlan; status: AttendanceBoardStatus }[];
}

export interface LearningDay {
  attendance: AttendancePlan;
  blocks: LearningBlock[];
}

interface LearningChangeInput extends LearningDayInput {
  id: string;
  requestId: string;
  expectedRevision: number;
}

export type LearningChange = LearningChangeInput & (
  | { command: "recordAttendance"; action: "confirm" | "checkIn" | "checkOut" | "absent" | "cancel" | "leave"; reason?: string }
  | { command: "saveLearningBlock"; plannedStart: number; plannedEnd: number; outsideAttendanceReason?: string; notes?: string }
  | { command: "saveLearningTasks"; tasks: LearningTaskInput[] }
  | { command: "recordLearningOutcome"; action: "start" | "finish" | "cancel" }
  | { command: "recordTaskOutcome"; taskId: string; status: "in_progress" | "done" | "skipped"; resultNotes?: string }
);

export interface ScheduleReceiptInput {
  command: "saveAttendancePlan" | LearningChange["command"];
  requestId: string;
  id: string;
  studentId: string;
  expectedRevision: number;
}

export interface ScheduleReceipt { revision: number; savedAt: number }
export type OperationCommand = (ScheduleSaveInput & { command: "saveAttendancePlan" }) | LearningChange;
export type PendingOperationState =
  | { kind: "empty" }
  | { kind: "pending"; command: OperationCommand }
  | { kind: "damaged"; descriptor?: ScheduleReceiptInput };

export interface WorkspaceInfo {
  mode: "production" | "synthetic";
  backupFormat: 1 | 2 | null;
}

export interface WorkspaceApi {
  pickStudyPlans(): Promise<Result<import("./study-plan-model").PlanPickResult[]>>;
  saveStudyPlan(input: {token:string; studentId:string; confirmed:boolean; fields:import("./study-plan-model").PlanDraft}): Promise<Result<{id:string;duplicate:boolean}>>;
  createManualPlan(input:{studentId:string; id:string;fields:import("./study-plan-model").PlanDraft}): Promise<Result<string>>;
  savePlanVersion(input:import("./study-plan-model").PlanVersionInput): Promise<Result<import("./study-plan-model").PlanVersion>>;
  planTasks(studentId:string): Promise<Result<import("./study-plan-model").PlanTask[]>>;
  linkPlanTask(input:import("./study-plan-model").PlanLinkInput): Promise<Result<import("./study-plan-model").PlanTaskLink>>;
  studyPlans(studentId: string): Promise<Result<import("./study-plan-model").PlanRecord[]>>;
  studyPlanSource(studentId:string,id:string): Promise<Result<{metadata: import("./study-plan-model").PlanSource;cells:import("./study-plan-model").PlanSourceCell[]}>>;
  exportStudyPlanSource(studentId:string,id:string): Promise<Result<string|null>>;
  previewSignin(input: import("./signin-calendar").SigninInput): Promise<Result<{preview: import("./signin-calendar").SigninPreview; key: string}>>;
  exportSignin(input: {input: import("./signin-calendar").SigninInput; key: string; changes: import("./signin-calendar").SigninChange[]}): Promise<Result<import("./signin-calendar").SigninResult | null>>;
  prepareBusinessExport(input: {includeSourceText: boolean}): Promise<Result<import("./business-export").BusinessExportPreview>>;
  writeBusinessExport(token: string): Promise<Result<import("./business-export").BusinessExportResult | null>>;
  cancelBusinessExport(token: string): Promise<Result<null>>;
  workspaceInfo(): Promise<Result<WorkspaceInfo>>;
  learningDay(input: LearningDayInput): Promise<Result<LearningDay>>;
  applyLearningChange(input: LearningChange): Promise<Result<AttendancePlan | LearningBlock>>;
  scheduleReceipt(input: ScheduleReceiptInput): Promise<Result<ScheduleReceipt | null>>;
  pendingOperation(): Promise<Result<PendingOperationState>>;
  acknowledgeOperation(requestId: string, reviewed?: boolean): Promise<Result<null>>;
  scheduleAvailable(): Promise<Result<boolean>>;
  scheduleConfiguration(): Promise<Result<import("./recurring-schedule").ScheduleConfiguration>>;
  changeCycleSchedule(input: import("./recurring-schedule").CycleCommand): Promise<Result<import("./recurring-schedule").CycleResult>>;
  scheduleFlexWeek(input: ScheduleWeekInput): Promise<Result<import("./recurring-schedule").FlexWindow[]>>;
  scheduleWeek(input: ScheduleWeekInput): Promise<Result<AttendancePlan[]>>;
  attendanceBoard(): Promise<Result<AttendanceBoardDay>>;
  schedulePlan(id: string): Promise<Result<AttendancePlan | null>>;
  saveSchedulePlan(input: ScheduleSaveInput): Promise<Result<AttendancePlan>>;
  exportProtection(): Promise<Result<ProtectionResult | null>>;
  restoreProtection(): Promise<Result<ProtectionResult | null>>;
  activationStatus(): Promise<Result<{ active: string | null; pending: boolean; location: string; lastSuccessfulBackupAt: string | null }>>;
  activateRecovery(): Promise<Result<boolean>>;
  returnOriginalProfile(): Promise<Result<boolean>>;
  students(): Promise<Result<Student[]>>;
  history(studentId: string): Promise<Result<Lesson[]>>;
  createStudent(input: StudentInput): Promise<Result<Student>>;
  studentEditAvailable(): Promise<Result<boolean>>;
  studentEdit(studentId: string): Promise<Result<StudentEditView>>;
  saveStudentEdit(input: StudentEditInput): Promise<Result<StudentEditRecord>>;
  finishStudentEdit(input: Pick<StudentEditInput, "studentId" | "requestId"> & { discard?: boolean }): Promise<Result<null>>;
  parentFollowUpAvailable(): Promise<Result<boolean>>;
  parentFollowUp(studentId: string): Promise<Result<ParentFollowUpView>>;
  createParentConcern(input: ParentConcernInput): Promise<Result<ParentConcern>>;
  appendParentFollowUp(input: ParentFollowUpInput): Promise<Result<ParentFollowUp>>;
  studentWriteState(): Promise<Result<StudentWriteState>>;
  resolveStudentWrite(action: StudentWriteAction, requestId?: string): Promise<Result<null>>;
  studentRecordVersion(): Promise<Result<number>>;
  studentRecords(kind: StudentRecordKind, studentId: string): Promise<Result<StudentRecordView>>;
  saveStudentRecord(input: StudentRecordInput): Promise<Result<StudentRecord>>;
  studentLifecycle(studentId: string): Promise<Result<LifecycleView>>;
  studentOverview(studentId: string): Promise<Result<import("./student-overview").StudentOverviewData>>;
  saveStudentLifecycle(input: LifecycleInput): Promise<Result<LifecycleChange>>;
  addLesson(input: LessonInput): Promise<Result<Lesson>>;
  workItems(today: string): Promise<Result<import("./worklog").WorkItem[]>>;
  searchWorkItems(from: string, to: string, query?: string): Promise<Result<import("./worklog").WorkItem[]>>;
  workHistory(id: string): Promise<Result<import("./worklog").WorkChange[]>>;
  saveWorkItem(input: import("./worklog").WorkItemInput): Promise<Result<import("./worklog").WorkItem>>;
  setWorkItemStatus(id: string, status: import("./worklog").WorkStatus): Promise<Result<import("./worklog").WorkItem>>;
  pickStudentIntake(): Promise<Result<IntakeFile[]>>;
  prepareStudentIntake(token: string, target?: IntakeTarget): Promise<Result<IntakeReview>>;
  saveStudentIntake(input: IntakeConfirm): Promise<Result<IntakeOutcome>>;
  studentIntakeHistory(studentId: string): Promise<Result<IntakeHistorySummary>>;
  growthProfile(studentId: string): Promise<Result<import("./growth-profile").GrowthProfileView>>;
  saveGrowthProfile(input: import("./growth-profile").GrowthSaveInput): Promise<Result<import("./growth-profile").GrowthProfileView>>;
}
