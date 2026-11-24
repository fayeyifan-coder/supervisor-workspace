import { contextBridge, ipcRenderer } from "electron";
import type { IntakeConfirm, IntakeTarget, LearningChange, LearningDayInput, LessonInput, ScheduleReceiptInput, ScheduleSaveInput, ScheduleWeekInput, StudentInput, WorkspaceApi } from "./contracts";
import type { WorkItemInput, WorkStatus } from "./worklog";
import type { GrowthSaveInput } from "./growth-profile";

// The sandboxed preload only imports Electron at runtime.
const api: WorkspaceApi = {
  scheduleAvailable: () => ipcRenderer.invoke("r2b:schedule-available"),
  scheduleWeek: (input: ScheduleWeekInput) => ipcRenderer.invoke("r2b:schedule-week", input),
  schedulePlan: (id: string) => ipcRenderer.invoke("r2b:schedule-plan", id),
  saveSchedulePlan: (input: ScheduleSaveInput) => ipcRenderer.invoke("r2b:save-schedule-plan", input),
  learningDay: (input: LearningDayInput) => ipcRenderer.invoke("r2b:learning-day", input),
  applyLearningChange: (input: LearningChange) => ipcRenderer.invoke("r2b:apply-learning-change", input),
  scheduleReceipt: (input: ScheduleReceiptInput) => ipcRenderer.invoke("r2b:schedule-receipt", input),
  pendingOperation: () => ipcRenderer.invoke("r2b:pending-operation"),
  acknowledgeOperation: (requestId: string, reviewed?: boolean) =>
    ipcRenderer.invoke("r2b:acknowledge-operation", requestId, reviewed),
  students: () => ipcRenderer.invoke("mvp:students"),
  exportProtection: () => ipcRenderer.invoke("m2d:export"),
  restoreProtection: () => ipcRenderer.invoke("m2d:restore"),
  activationStatus: () => ipcRenderer.invoke("m2d:activation-status"),
  activateRecovery: () => ipcRenderer.invoke("m2d:activate-recovery"),
  returnOriginalProfile: () => ipcRenderer.invoke("m2d:return-original"),
  history: (id: string) => ipcRenderer.invoke("mvp:history", id),
  createStudent: (input: StudentInput) => ipcRenderer.invoke("mvp:create-student", input),
  addLesson: (input: LessonInput) => ipcRenderer.invoke("mvp:add-lesson", input),
  workItems: (day: string) => ipcRenderer.invoke("m2b:work-items", day),
  searchWorkItems: (from: string, to: string, query?: string) => ipcRenderer.invoke("m2b:search-work-items", from, to, query),
  workHistory: (id: string) => ipcRenderer.invoke("m2b:work-history", id),
  saveWorkItem: (input: WorkItemInput) => ipcRenderer.invoke("m2b:save-work-item", input),
  setWorkItemStatus: (id: string, status: WorkStatus) => ipcRenderer.invoke("m2b:set-work-item-status", id, status),
  pickStudentIntake: () => ipcRenderer.invoke("m2c:pick-student-intake"),
  prepareStudentIntake: (token: string, target?: IntakeTarget) => ipcRenderer.invoke("m2c:prepare-student-intake", token, target),
  saveStudentIntake: (input: IntakeConfirm) => ipcRenderer.invoke("m2c:save-student-intake", input),
  studentIntakeHistory: (studentId: string) => ipcRenderer.invoke("m2c:student-intake-history", studentId),
  growthProfile: (studentId: string) => ipcRenderer.invoke("m2c:growth-profile", studentId),
  saveGrowthProfile: (input: GrowthSaveInput) => ipcRenderer.invoke("m2c:save-growth-profile", input),
};
contextBridge.exposeInMainWorld("supervisorWorkspace", Object.freeze(api));
