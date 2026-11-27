import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudentWriteCommand, StudentWriteState } from "./contracts";
import type { WorkspaceDatabase } from "./database";
import { WorkspaceFault } from "./workspace-fault";

type JournalEntry = Exclude<StudentWriteState, { kind: "pending" }> | { kind: "pending"; command: StudentWriteCommand };
const limit = 16 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const requestPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function inspect(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) {
    throw new WorkspaceFault("recovery", "待核对请求的文件路径异常，请保留现场。");
  }
  return entry;
}

function read(path: string) {
  const file = inspect(path);
  if (!file) return;
  if (file.size > limit) throw new WorkspaceFault("recovery", "待核对请求文件大小异常。");
  return readFileSync(path, "utf8");
}

export class StudentWriteRecovery {
  private readonly marker: string;
  private readonly body: string;

  constructor(private readonly profile: string) {
    this.marker = join(profile, "student-write.pending");
    this.body = join(profile, "student-write.json");
  }

  private entry(store: WorkspaceDatabase): JournalEntry {
    let requestId: string | undefined;
    try {
      const marker = read(this.marker);
      if (marker === undefined) return read(this.body) === undefined ? { kind: "empty" } : { kind: "damaged" };
      const header = JSON.parse(marker);
      if (typeof header?.requestId === "string" && requestPattern.test(header.requestId)) requestId = header.requestId;
      const body = read(this.body);
      if (requestId && body && header.sha256 === hash(body)) {
        const raw = JSON.parse(body);
        if (raw.kind === "record" || raw.kind === "concern" || raw.kind === "followUp" || raw.kind === "lifecycle") {
          const command = store.studentWriteCommand(raw.kind, raw.input);
          if (command.input.requestId === requestId && JSON.stringify(command) === body) return { kind: "pending", command };
        }
      }
    } catch {
      // Keep both original files for review. A missing or unreadable payload must never be replayed.
    }
    return { kind: "damaged", requestId };
  }

  state(store: WorkspaceDatabase): StudentWriteState {
    const entry = this.entry(store);
    if (entry.kind !== "pending") return entry;
    try { return { ...entry, outcome: store.studentWriteCommitted(entry.command) ? "saved" : "notSaved" }; }
    catch { return { ...entry, outcome: "unknown" }; }
  }

  requireSettled(store: WorkspaceDatabase): void {
    if (this.entry(store).kind !== "empty") {
      throw new WorkspaceFault("recovery", "请先核对上方待确认的学生资料请求。");
    }
  }

  run<T>(store: WorkspaceDatabase, command: StudentWriteCommand, save: () => T, retainFailure = false): T {
    const entry = this.entry(store);
    const body = JSON.stringify(command);
    if (entry.kind === "empty") {
      if (Buffer.byteLength(body) > limit) throw new WorkspaceFault("invalid", "待核对请求超过大小限制。");
      // Neither a half-written marker nor an incomplete payload can reach SQLite.
      writeFileSync(this.marker, JSON.stringify({ requestId: command.input.requestId, sha256: hash(body) }), { flag: "wx", flush: true });
      writeFileSync(this.body, body, { flag: "wx", flush: true });
    } else if (entry.kind !== "pending" || JSON.stringify(entry.command) !== body) {
      throw new WorkspaceFault("recovery", "请先核对上方待确认的学生资料请求。");
    }
    try { return save(); }
    catch (error) {
      // A rolled back validation/conflict is a known no-write result. A COMMIT or rollback error is reported as unknown.
      if (!retainFailure && error instanceof WorkspaceFault && (error.code === "invalid" || error.code === "conflict")) {
        try { this.clear(); }
        catch { throw new WorkspaceFault("unknown", "未能结束原请求，请核对待确认记录。"); }
      }
      throw error;
    }
  }

  resolve(store: WorkspaceDatabase, action: unknown, requestId: unknown): null {
    const entry = this.state(store);
    if (action === "archive" && entry.kind === "damaged" && entry.requestId === requestId) {
      // Preserve evidence, including partial files, in a fresh directory; never overwrite it.
      const files = [this.body, this.marker].filter(path => Boolean(inspect(path)));
      const folder = join(this.profile, "student-write-evidence-" + randomUUID());
      mkdirSync(folder);
      for (const path of files) renameSync(path, join(folder, path === this.body ? "payload.json" : "marker.json"));
      return null;
    }
    if (entry.kind === "empty" && action === "confirm" && typeof requestId === "string" && requestPattern.test(requestId)) return null;
    if (entry.kind !== "pending" || entry.command.input.requestId !== requestId) {
      throw new WorkspaceFault("conflict", "该编号与当前待核对请求不一致。");
    }
    if ((action === "confirm" && entry.outcome === "saved") || (action === "discard" && entry.outcome === "notSaved")) {
      this.clear();
      return null;
    }
    if (action === "retry" && entry.outcome === "notSaved") {
      const command = entry.command;
      this.run(store, command, () => {
        if (command.kind === "concern") store.createParentConcern(command.input);
        else if (command.kind === "followUp") store.appendParentFollowUp(command.input);
        else if (command.kind === "lifecycle") store.saveStudentLifecycle(command.input);
        else store.saveStudentRecord(command.input);
      }, true);
      return null;
    }
    throw new WorkspaceFault("unknown", "当前状态不允许此操作，请重新核对保存结果。");
  }

  private clear(): void {
    unlinkSync(this.body);
    unlinkSync(this.marker);
  }
}
