import type { LearningDay, LearningTaskInput } from "./contracts";
import type { OperationsDatabase } from "./operations";
import { id, instant, invalid, object, requireStudent, type StudentList } from "./schedule-api";
import { shanghaiParts } from "./schedule-calendar";

const learningCommands = ["recordAttendance", "saveLearningBlock", "saveLearningTasks",
  "recordLearningOutcome", "recordTaskOutcome"] as const;

function enumValue<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid("教务操作或状态无效。");
  return value;
}

function changeInput(request: Record<string, unknown>, students: StudentList) {
  const { expectedRevision } = request;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    invalid("教务记录版本无效。");
  }
  return { id: id(request.id), requestId: id(request.requestId),
    studentId: requireStudent(request.studentId, students), expectedRevision };
}

function requireAttendance(store: OperationsDatabase, attendanceId: unknown, studentId: string) {
  const plan = store.attendancePlan(id(attendanceId));
  if (!plan || plan.studentId !== studentId) invalid("到校安排不存在或不属于该学生。");
  return plan;
}

export function readLearningDay(store: OperationsDatabase, students: StudentList, raw: unknown): LearningDay {
  const request = object(raw);
  store.protectionConnection();
  const attendance = requireAttendance(store, request.attendanceId, requireStudent(request.studentId, students));
  return { attendance, blocks: store.learningBlocksForAttendance(attendance.id) };
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid("教务文本格式或长度无效。");
  return value;
}

export function applyLearningChange(store: OperationsDatabase, students: StudentList, raw: unknown) {
  const request = object(raw);
  const change = changeInput(request, students);
  const command = enumValue(request.command, learningCommands);
  const plan = requireAttendance(store, request.attendanceId, change.studentId);
  if (command === "recordAttendance") {
    if (change.id !== plan.id) invalid("签到记录与当前到校安排不一致。");
    return store.recordAttendance({ ...change,
      action: enumValue(request.action, ["confirm", "checkIn", "checkOut", "absent", "cancel"]) });
  }
  const block = store.learningBlock(change.id);
  if (block ? block.studentId !== change.studentId || block.attendancePlanId !== plan.id : command !== "saveLearningBlock") {
    invalid("学习块不存在或不属于当前学生和到校安排。");
  }
  switch (command) {
    case "saveLearningBlock": {
      const plannedStart = instant(request.plannedStart), plannedEnd = instant(request.plannedEnd);
      const date = shanghaiParts(plan.startAt).date;
      if (shanghaiParts(plannedStart).date !== date || shanghaiParts(plannedEnd).date !== date) {
        invalid("学习块须使用该次到校的机构日期。");
      }
      return store.saveLearningBlock({ ...change, attendancePlanId: plan.id, plannedStart, plannedEnd,
        outsideAttendanceReason: optionalText(request.outsideAttendanceReason, 500), notes: optionalText(request.notes, 1000) });
    }
    case "saveLearningTasks": {
      if (!Array.isArray(request.tasks) || request.tasks.length > 3) invalid("每个学习块最多三项任务。");
      const tasks = request.tasks.map(item => {
        const task = object(item), content = optionalText(task.content, 1000);
        if (!content?.trim()) invalid("请填写任务内容。");
        return { id: id(task.id), category: enumValue(task.category, ["foundation", "synchronous", "targeted_test", "home_school"]),
          content, subject: optionalText(task.subject, 100), knowledgePoints: optionalText(task.knowledgePoints, 1000),
          plannedTarget: optionalText(task.plannedTarget, 1000) } satisfies LearningTaskInput;
      });
      return store.saveLearningTasks({ ...change, tasks });
    }
    case "recordLearningOutcome":
      return store.recordLearningOutcome({ ...change, action: enumValue(request.action, ["start", "finish", "cancel"]) });
    case "recordTaskOutcome":
      return store.recordTaskOutcome({ ...change, taskId: id(request.taskId),
        status: enumValue(request.status, ["in_progress", "done", "skipped"]),
        resultNotes: optionalText(request.resultNotes, 1000) });
  }
}

export function readScheduleReceipt(store: OperationsDatabase, students: StudentList, raw: unknown) {
  const request = object(raw);
  const change = changeInput(request, students);
  return store.receipt(change.requestId, enumValue(request.command, ["saveAttendancePlan", ...learningCommands]),
    change.id, change.studentId, change.expectedRevision);
}
