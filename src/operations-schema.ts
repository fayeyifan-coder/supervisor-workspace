import type { DatabaseSync } from "node:sqlite";
import { WorkspaceFault } from "./database";

const ddl = [
  `CREATE TABLE attendance_plans (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
    start_at INTEGER NOT NULL, end_at INTEGER NOT NULL CHECK (end_at > start_at),
    kind TEXT NOT NULL CHECK (kind IN ('regular','whole_day')),
    status TEXT NOT NULL CHECK (status IN ('planned','confirmed','attended','absent','cancelled')),
    check_in_at INTEGER, check_out_at INTEGER,
    outside_window INTEGER NOT NULL CHECK (outside_window IN (0,1)), exception_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK (check_out_at IS NULL OR (check_in_at IS NOT NULL AND check_out_at >= check_in_at)),
    CHECK ((status = 'attended') = (check_in_at IS NOT NULL)),
    CHECK ((outside_window = 0 AND exception_reason IS NULL) OR
      (outside_window = 1 AND exception_reason IS NOT NULL AND length(trim(exception_reason)) BETWEEN 1 AND 500)),
    UNIQUE (id, student_id)
  ) STRICT`,
  `CREATE INDEX attendance_by_student_time ON attendance_plans(student_id, start_at, end_at)`,
  `CREATE TABLE learning_blocks (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, attendance_plan_id TEXT,
    planned_start INTEGER NOT NULL, planned_end INTEGER NOT NULL CHECK (planned_end > planned_start),
    actual_start INTEGER, actual_end INTEGER,
    status TEXT NOT NULL CHECK (status IN ('planned','in_progress','done','cancelled')),
    outside_attendance_reason TEXT,
    notes TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK ((actual_start IS NOT NULL) = (status IN ('in_progress','done'))),
    CHECK ((actual_end IS NOT NULL) = (status = 'done')),
    CHECK (actual_end IS NULL OR actual_end > actual_start),
    FOREIGN KEY (attendance_plan_id, student_id) REFERENCES attendance_plans(id, student_id)
  ) STRICT`,
  `CREATE INDEX blocks_by_attendance ON learning_blocks(attendance_plan_id, planned_start, id)`,
  `CREATE TABLE learning_tasks (
    id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES learning_blocks(id),
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    category TEXT NOT NULL CHECK (category IN ('foundation','synchronous','targeted_test','home_school')),
    subject TEXT, content TEXT NOT NULL, knowledge_points TEXT, planned_target TEXT,
    status TEXT NOT NULL CHECK (status IN ('planned','in_progress','done','skipped')),
    result_notes TEXT, completed_at INTEGER,
    CHECK ((completed_at IS NOT NULL) = (status IN ('done','skipped'))),
    UNIQUE (block_id, position)
  ) STRICT`,
  `CREATE TABLE operation_requests (
    request_id TEXT PRIMARY KEY, command TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)), created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE operation_changes (
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('attendance','block')),
    entity_id TEXT NOT NULL, student_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
    request_id TEXT NOT NULL REFERENCES operation_requests(request_id),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)), changed_at INTEGER NOT NULL,
    PRIMARY KEY (entity_kind, entity_id, revision)
  ) STRICT`,
] as const;

export const operationsProtection = {
  key: "operations", marker: "operations-v1\n", applicationId: 0x53574f31, version: 1,
  tables: ["attendance_plans", "learning_blocks", "learning_tasks", "operation_requests", "operation_changes"],
  ddl,
} as const;

export function verifyOperationsStudentLinks(database: DatabaseSync, m1StudentIds: ReadonlySet<string>): void {
  const students = database.prepare(`SELECT student_id FROM attendance_plans
    UNION SELECT student_id FROM learning_blocks UNION SELECT student_id FROM operation_changes`).all();
  if (students.some(row => typeof row.student_id !== "string" || !m1StudentIds.has(row.student_id))) {
    throw new WorkspaceFault("recovery", "教务数据库包含找不到对应 M1 档案的学生记录。");
  }
}
