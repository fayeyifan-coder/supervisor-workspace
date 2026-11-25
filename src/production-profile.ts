import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { verifyProfileData } from "./profile-activation";
import { WorkspaceFault } from "./database";

export const productionInstallRoot = "D:\\SupervisorWorkspace";
const acceptanceRoot = /^D:\\Codex-Development\\Builds\\sw-production-admission-[a-f0-9]{32}$/;
export const primaryMarker = "production-primary.initialized";
export const sha256Pattern = /^[a-f0-9]{64}$/;

export function productionRootOf(executable: string): string | undefined {
  const version = dirname(executable);
  const versions = dirname(version);
  const app = dirname(versions);
  const root = dirname(app);
  if ((root !== productionInstallRoot && !acceptanceRoot.test(root)) || !/^[a-f0-9]{40}$/.test(relative(versions, version)) ||
      executable !== join(root, "App", "Versions", relative(versions, version), "SupervisorWorkspace-MVP.exe")) return;
  return root;
}

export function isWithin(root: string, path: string): boolean {
  const prefix = resolve(root).toLowerCase();
  const candidate = resolve(path).toLowerCase();
  return candidate === prefix || candidate.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

function refuse(): never {
  throw new WorkspaceFault("recovery", "正式档案未完成激活，或安装位置、目录、初始化记录异常。请保留现场并核对部署记录。");
}

export function requireLocalDirectory(path: string): void {
  const drive = parse(path).root;
  if (!/^[A-Z]:\\$/.test(drive) || resolve(path) !== path) refuse();
  let current = drive;
  for (const segment of path.slice(drive.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync.native(current) !== current) refuse();
  }
}

export function plainFile(path: string, maxBytes = Infinity): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      entry.size > maxBytes || realpathSync.native(path) !== path) refuse();
}

export function productionLayout(root: string) {
  const owner = join(root, "Profiles", "Primary");
  return { owner, profile: join(owner, "profile"), exports: join(root, "Exports"), logs: join(root, "Logs") };
}

export function requireProductionProfile(root: string) {
  const layout = productionLayout(root);
  const { owner, profile, logs } = layout;
  for (const dir of [owner, profile, join(profile, "chromium"), layout.exports, logs, join(logs, "Crash")]) requireLocalDirectory(dir);
  plainFile(join(owner, primaryMarker), 1024);
  let marker: { version?: unknown; backupSha256?: unknown };
  try { marker = JSON.parse(readFileSync(join(owner, primaryMarker), "utf8")); }
  catch { return refuse(); }
  if (marker?.version !== "production-primary-v1" || typeof marker.backupSha256 !== "string" ||
      !sha256Pattern.test(marker.backupSha256) || ["restore.ready", "recovery", "activation.approved"].some(name =>
        lstatSync(join(profile, name), { throwIfNoEntry: false }))) refuse();
  verifyProfileData(profile, false, 2, 6);
  return layout;
}

export function createLocalDirectory(path: string): void {
  requireLocalDirectory(dirname(path));
  mkdirSync(path);
  requireLocalDirectory(path);
}
