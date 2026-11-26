import { appendFileSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { channels, type Failure } from "./contracts";

const allowedChannels = new Set<string>([...Object.values(channels), "lifecycle:startup", "lifecycle:close",
  "lifecycle:switch", "protection:backup-status"]);
const allowedCategories = new Set<Failure["code"]>(["invalid", "conflict", "busy", "failed", "unknown", "recovery"]);

export function sqliteErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_SQLITE_ERROR" || !("errcode" in error)) return;
  const value = error.errcode;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65535) return value;
}

function regular(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync.native(path) !== path)) {
    throw Error("Invalid diagnostic file.");
  }
  return entry;
}

export class Diagnostics {
  constructor(private readonly directory: string, private readonly version: string,
    private readonly capacity = 128 * 1024) {}

  record(channel: string, category: Failure["code"], sqliteCode?: number): void {
    if (!allowedChannels.has(channel) || !allowedCategories.has(category) ||
      !/^\d+\.\d+\.\d+$/.test(this.version)) return;
    const record = { time: new Date().toISOString(), version: this.version, channel, category,
      ...(typeof sqliteCode === "number" && Number.isSafeInteger(sqliteCode) && sqliteCode >= 0 && sqliteCode <= 65535
        ? { sqliteCode } : {}) };
    const line = JSON.stringify(record) + "\n";
    const path = join(this.directory, "diagnostics.jsonl");
    try {
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync.native(this.directory) !== this.directory) return;
      const size = regular(path)?.size ?? 0;
      if (Buffer.byteLength(line) > this.capacity) return;
      if (size + Buffer.byteLength(line) > this.capacity) {
        const previous = join(this.directory, "diagnostics.1.jsonl");
        const oldest = join(this.directory, "diagnostics.2.jsonl");
        regular(oldest);
        if (regular(previous)) renameSync(previous, oldest);
        renameSync(path, previous);
      }
      appendFileSync(path, line, "utf8");
    } catch { /* Diagnostics must not change the outcome of a workspace operation. */ }
  }
}
