import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const filename = "last-verified-backup-v1.txt";
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function checkFile(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    info.size > 64 || realpathSync.native(path) !== path)) throw Error("Invalid backup status file.");
  return info;
}

export function readBackupStatus(profile: string): string | null {
  try {
    const path = join(profile, filename);
    if (!checkFile(path)) return null;
    const value = readFileSync(path, "utf8");
    return timestamp.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
  } catch { return null; }
}

export function recordSuccessfulBackup(profile: string, completedAt: Date): string {
  const value = completedAt.toISOString();
  const path = join(profile, filename);
  checkFile(path);
  const temp = join(profile, ".backup-status-" + randomUUID());
  writeFileSync(temp, value, { flag: "wx", flush: true });
  renameSync(temp, path);
  return value;
}
