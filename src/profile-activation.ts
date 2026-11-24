import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { m1Protection, WorkspaceFault } from "./database";
import { growthProtection } from "./growth-profile";
import { worklogProtection } from "./worklog";
import { intakeProtection } from "./student-intake";

export const recoveryName = /^sw-m2d-restore-[a-f0-9]{32}$/;
export const activeName = /^sw-m2d-active-[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const stateName = "profile-selection-v1.json";
const markerName = "profile-selection.initialized";
const markerContents = "profile-selection-v1\n";
const stores = [m1Protection, worklogProtection, growthProtection, intakeProtection];

interface Selection {
  name: string;
  digest: string;
}

type Pending = ({ kind: "restore" | "opening" | "resume" | "resuming" } & Selection) | { kind: "original" };
export interface ActivationState {
  version: 1;
  active: Selection | null;
  pending: Pending | null;
}

function invalid(message: string): never {
  throw new WorkspaceFault("recovery", message);
}

function selection(value: unknown, pattern: RegExp): value is Selection {
  if (!value || typeof value !== "object") return false;
  const { name, digest } = value as Partial<Selection>;
  return typeof name === "string" && pattern.test(name) && typeof digest === "string" && digestPattern.test(digest);
}

function plainFile(path: string, max = Infinity, optional = false) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry && optional) return false;
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > max ||
      realpathSync.native(path) !== path) invalid("档案文件缺失、类型异常或路径不受支持。请保留现场。");
  return true;
}

export function readActivation(owner: string): ActivationState {
  const path = join(owner, stateName);
  const initialized = plainFile(join(owner, markerName), 32, true);
  if (!plainFile(path, 2048, true)) {
    if (initialized) invalid("活动档案选择记录缺失。请保留原档案和恢复资料。");
    return { version: 1, active: null, pending: null };
  }
  let state: ActivationState;
  try { state = JSON.parse(readFileSync(path, "utf8")); }
  catch { return invalid("活动档案选择记录损坏。请保留原档案和恢复资料。"); }
  const pending = state?.pending;
  if (state?.version !== 1 || (state.active !== null && !selection(state.active, activeName)) ||
      (pending !== null && pending?.kind !== "original" &&
        !((pending?.kind === "restore" || pending?.kind === "opening") && selection(pending, recoveryName)) &&
        !((pending?.kind === "resume" || pending?.kind === "resuming") && selection(pending, activeName)))) {
    invalid("活动档案选择记录无效。请保留原档案和恢复资料。");
  }
  // The first state is empty until the initialization marker is durably published.
  if (initialized ? readFileSync(join(owner, markerName), "utf8") !== markerContents : state.active !== null || pending !== null) {
    invalid("档案选择初始化记录不完整。请保留原档案和恢复资料。");
  }
  return state;
}

function publishSelectionFile(owner: string, path: string, value: string) {
  const temporary = join(owner, ".profile-selection-" + randomUUID());
  writeFileSync(temporary, value, { flag: "wx", flush: true });
  renameSync(temporary, path);
}

export function saveActivation(owner: string, state: ActivationState): void {
  const path = join(owner, stateName);
  const marker = join(owner, markerName);
  const previous = readActivation(owner);
  if (!plainFile(marker, 32, true)) {
    publishSelectionFile(owner, path, JSON.stringify(previous));
    publishSelectionFile(owner, marker, markerContents);
  }
  publishSelectionFile(owner, path, JSON.stringify(state));
}
export function verifyActiveProfile(root: string, active: Selection, firstOpen: boolean): string {
  if (!selection(active, activeName)) return invalid("活动恢复档案编号无效。");
  const container = join(root, active.name);
  const profile = join(container, "profile");
  for (const directory of [container, profile]) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync.native(directory) !== directory) {
      invalid("恢复档案目录缺失或路径异常。请保留现场。");
    }
  }
  const marker = join(profile, "restore.ready");
  plainFile(marker, 64 * 1024);
  const record = JSON.parse(readFileSync(marker, "utf8"));
  const evidence = JSON.parse(Buffer.from(record.packageEvidenceBase64, "base64").toString("utf8"));
  if (record.format !== "sw-recovery-evidence-v1" || record.profileName !== active.name || evidence.packageSha256 !== active.digest) {
    invalid("活动恢复档案与选择记录不符。");
  }
  if (firstOpen && readdirSync(profile).some(name => name !== "data" && name !== "restore.ready")) {
    invalid("新恢复档案含未验证的文件。");
  }
  verifyProfileData(profile, firstOpen);
  if (!firstOpen && approvedSelection(root, active.name).digest !== active.digest) {
    invalid("活动恢复档案未经验证，或与激活记录不符。");
  }
  return profile;
}

export function approvedSelection(owner: string, name: string): Selection {
  if (!activeName.test(name)) return invalid("活动恢复档案编号无效。");
  const path = join(owner, name, "profile", "activation.approved");
  plainFile(path, 128);
  const digest = readFileSync(path, "utf8");
  if (!digestPattern.test(digest)) invalid("活动恢复档案的激活记录无效。");
  return { name, digest };
}

export function approveActiveProfile(profile: string, digest: string): void {
  writeFileSync(join(profile, "activation.approved"), digest, { flag: "wx", flush: true });
}

export function verifyProfileData(profile: string, firstOpen = false): void {
  const data = join(profile, "data");
  const entry = lstatSync(data, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync.native(data) !== data) {
    invalid("数据库目录缺失或路径异常。请保留现场。");
  }
  const names = new Set(readdirSync(data));
  for (const { key, marker } of stores) {
    const main = key + ".sqlite3";
    const metadata = key + ".initialized";
    plainFile(join(data, main));
    plainFile(join(data, metadata), 128);
    if (readFileSync(join(data, metadata), "utf8") !== marker) invalid("数据库初始化标记不匹配。");
    names.delete(main);
    names.delete(metadata);
    if (!firstOpen) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = key + ".sqlite3" + suffix;
        if (names.delete(sidecar)) plainFile(join(data, sidecar));
      }
    }
  }
  if (names.size > 0) invalid("恢复档案含未验证的数据库文件或侧车。");
}
