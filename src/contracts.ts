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
} as const;

export type { WorkChange, WorkItem, WorkItemInput, WorkStatus } from "./worklog";

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

export interface WorkspaceApi {
  students(): Promise<Result<Student[]>>;
  history(studentId: string): Promise<Result<Lesson[]>>;
  createStudent(input: StudentInput): Promise<Result<Student>>;
  addLesson(input: LessonInput): Promise<Result<Lesson>>;
  workItems(today: string): Promise<Result<import("./worklog").WorkItem[]>>;
  searchWorkItems(from: string, to: string, query?: string): Promise<Result<import("./worklog").WorkItem[]>>;
  workHistory(id: string): Promise<Result<import("./worklog").WorkChange[]>>;
  saveWorkItem(input: import("./worklog").WorkItemInput): Promise<Result<import("./worklog").WorkItem>>;
  setWorkItemStatus(id: string, status: import("./worklog").WorkStatus): Promise<Result<import("./worklog").WorkItem>>;
}
