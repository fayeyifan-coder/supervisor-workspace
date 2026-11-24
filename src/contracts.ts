export const channels = {
  students: "mvp:students",
  history: "mvp:history",
  createStudent: "mvp:create-student",
  addLesson: "mvp:add-lesson",
} as const;

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
}
