import { createHash } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationCommand, PendingOperationState, ScheduleReceiptInput } from "./contracts";
import { WorkspaceFault } from "./database";
import { id, invalid, object } from "./schedule-api";

const commands = new Set(["saveAttendancePlan", "recordAttendance", "saveLearningBlock", "saveLearningTasks",
  "recordLearningOutcome", "recordTaskOutcome"]);
const maxPayload = 32 * 1024;
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

function identity(input: unknown): ScheduleReceiptInput {
  const raw = object(input);
  const { command, expectedRevision } = raw;
  if (typeof command !== "string" || !commands.has(command) || typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid("待核对请求格式无效。");
  return { command: command as ScheduleReceiptInput["command"], requestId: id(raw.requestId), id: id(raw.id),
    studentId: id(raw.studentId), expectedRevision };
}

function read(path: string, limit: number): string | undefined {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > limit) {
    throw new WorkspaceFault("recovery", "待核对请求文件异常。请保留现场并核对数据库事实。");
  }
  return readFileSync(path, "utf8");
}

export class OperationsPending {
  private readonly marker: string;
  private readonly payload: string;
  private determinedId: string | undefined;

  constructor(profile: string) {
    this.marker = join(profile, "operations-request.pending");
    this.payload = join(profile, "operations-request.json");
  }

  state(): PendingOperationState {
    let descriptor: ScheduleReceiptInput | undefined;
    try {
      const marker = read(this.marker, 2048);
      if (marker === undefined) return read(this.payload, maxPayload) === undefined
        ? { kind: "empty" } : { kind: "damaged" };
      const parsed = object(JSON.parse(marker));
      descriptor = identity(parsed.identity);
      const payload = read(this.payload, maxPayload);
      if (payload === undefined || parsed.sha256 !== digest(payload)) return { kind: "damaged", descriptor };
      const command = JSON.parse(payload) as OperationCommand;
      if (JSON.stringify(identity(command)) !== JSON.stringify(descriptor)) return { kind: "damaged", descriptor };
      return { kind: "pending", command };
    } catch {
      return { kind: "damaged", descriptor };
    }
  }

  begin(command: Record<string, unknown>): string {
    const descriptor = identity(command);
    const payload = JSON.stringify(command);
    if (Buffer.byteLength(payload) > maxPayload) invalid("待核对请求超过允许长度。");
    const existing = this.state();
    if (existing.kind !== "empty") {
      if (existing.kind === "pending" && JSON.stringify(existing.command) === payload) return descriptor.requestId;
      throw new WorkspaceFault("recovery", "另有待核对请求，请先读取数据库并核对。");
    }
    // The marker precedes the payload. SQLite must not start unless both writes have been flushed.
    writeFileSync(this.marker, JSON.stringify({ identity: descriptor, sha256: digest(payload) }), { flag: "wx", flush: true });
    writeFileSync(this.payload, payload, { flag: "wx", flush: true });
    this.determinedId = undefined;
    return descriptor.requestId;
  }

  remember(requestId: string): void {
    this.determinedId = requestId;
  }

  acknowledge(requestId: string, reviewed: boolean, lookup: (request: ScheduleReceiptInput) => unknown): void {
    const state = this.state();
    if (state.kind === "empty") return;
    const descriptor = state.kind === "pending" ? identity(state.command) : state.descriptor;
    if (!descriptor || descriptor.requestId !== requestId) {
      throw new WorkspaceFault("recovery", "无法确认原请求身份。请保留现场并核对数据库。");
    }
    if (this.determinedId !== requestId && !lookup(descriptor) && !(state.kind === "damaged" && reviewed)) {
      throw new WorkspaceFault("unknown", "尚无该请求的已提交回执，请继续核对或用原请求重试。");
    }
    // If removal is interrupted, a remaining marker keeps the request in recovery.
    if (read(this.payload, maxPayload) !== undefined) unlinkSync(this.payload);
    unlinkSync(this.marker);
    this.determinedId = undefined;
  }
}
