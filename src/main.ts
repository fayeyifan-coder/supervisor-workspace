import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent, type Session } from "electron";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { channels, type Failure, type Result } from "./contracts";
import { failure, WorkspaceDatabase, WorkspaceFault } from "./database";
import { closeStoresIndependently } from "./database-lifecycle";
import { WorkLogDatabase, type WorkStatus } from "./worklog";
import { GrowthProfileDatabase, GrowthProfileFault, type GrowthSaveInput } from "./growth-profile";

import { IntakeStore, StudentIntakeService, type IntakeConfirm, type IntakeFile, type IntakeTarget } from "./student-intake";
import { maxIntakeBytes } from "./intake-format";

const scheme = "supervisor-workspace-mvp";
const page = `${scheme}://workspace/index.html`;
const securityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'";
const appId = "cn.supervisorworkspace.desktop.mvp";
const title = "督学工作台";
let database: WorkspaceDatabase | undefined;
let workLog: WorkLogDatabase | undefined;
let growthProfile: GrowthProfileDatabase | undefined;
let intakeStore: IntakeStore | undefined;

protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);

async function serveUi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const localAsset = (
    request.method === "GET" && url.hostname === "workspace" &&
    url.protocol === `${scheme}:` && !url.username && !url.password &&
    !url.port && !url.search &&
    (url.pathname === "/index.html" || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(url.pathname))
  );
  if (!localAsset) return new Response(null, { status: 404 });
  const type = url.pathname.endsWith(".html") ? "text/html; charset=utf-8"
    : url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
  try {
    const bytes = await readFile(join(app.getAppPath(), "dist", url.pathname.slice(1)));
    return new Response(Uint8Array.from(bytes), { headers: {
      "Content-Type": type,
      "Content-Security-Policy": securityPolicy,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function restrictSession(ui: Session): void {
  ui.protocol.handle(scheme, serveUi);
  ui.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ui.setPermissionCheckHandler(() => false);
  ui.webRequest.onBeforeRequest(({ url }, callback) => {
    callback({ cancel: !url.startsWith(`${scheme}://workspace/`) });
  });
  ui.enableNetworkEmulation({ offline: true });
}

function isTrusted(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  const frame = event.senderFrame;
  return event.sender === window.webContents && frame !== null &&
    frame === window.webContents.mainFrame && frame.url === page;
}

function denied(): Failure {
  return { ok: false, code: "invalid", message: "此窗口无权访问本地记录。" };
}

async function readIntakeFile(path: string): Promise<string> {
  if (extname(path).toLowerCase() !== ".json") throw new WorkspaceFault("invalid", "请选择 JSON 文件。");
  const fd = await open(path, "r");
  try {
    const maxBytes = maxIntakeBytes;
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new WorkspaceFault("invalid", "请选择不超过 256 KiB 的普通 JSON 文件。");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new WorkspaceFault("invalid", "文件超过 256 KiB。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new WorkspaceFault("invalid", "文件不是有效的 UTF-8 JSON。"); }
  } finally { await fd.close(); }
}

async function start(profile: string): Promise<void> {
  app.setAppUserModelId(appId);
  const ui = session.fromPartition("supervisor-workspace-mvp-ui");
  restrictSession(ui);
  const path = join(profile, "data", "mvp.sqlite3");
  let startupError: Failure = { ok: false, code: "recovery", message: "MVP 数据库无法打开。请保留原目录后重开。" };
  try {
    database = WorkspaceDatabase.open(path, join(profile, "data", "mvp.initialized"));
  } catch (error) {
    const result = failure(error);
    if (result.code === "recovery" || result.code === "busy") startupError = result;
  }
  try {
    workLog = WorkLogDatabase.open(join(profile, "data", "worklog.sqlite3"), join(profile, "data", "worklog.initialized"));
  } catch (error) {
    const result = failure(error);
    if (result.code === "recovery" || result.code === "busy") startupError = result;
  }
  let growthStartupError: Failure = { ok: false, code: "recovery", message: "成长档案数据库无法打开。请保留文件后重开。" };
  try {
    growthProfile = GrowthProfileDatabase.open(join(profile, "data", "growth.sqlite3"), join(profile, "data", "growth.initialized"));
  } catch (error) { growthStartupError = failure(error); }

  let intake: StudentIntakeService | undefined;
  let intakeStartupError: Failure = { ok: false, code: "recovery", message: "导入功能需要可用的学生档案和成长档案。" };
  if (database && growthProfile) {
    try {
      intakeStore = IntakeStore.open(join(profile, "data", "student-intake.sqlite3"), join(profile, "data", "student-intake.initialized"));
      intake = new StudentIntakeService(intakeStore, database, growthProfile);
    } catch (error) { intakeStartupError = failure(error); }
  }

  const window = new BrowserWindow({
    title,
    width: 1100,
    height: 800,
    minWidth: 580,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f1f3ee",
    webPreferences: {
      session: ui,
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-redirect", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());

  function invoke<T>(event: IpcMainInvokeEvent, operation: (store: WorkspaceDatabase) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    if (!database) return startupError;
    try {
      return { ok: true, value: operation(database) };
    } catch (error) {
      return failure(error);
    }
  }
  ipcMain.handle(channels.students, event => invoke(event, store => store.students()));
  ipcMain.handle(channels.history, (event, id: unknown) => invoke(event, store => store.history(id)));
  ipcMain.handle(channels.createStudent, (event, raw: unknown) => invoke(event, store => store.createStudent(raw)));
  ipcMain.handle(channels.addLesson, (event, raw: unknown) => invoke(event, store => store.addLesson(raw)));
  const invokeWork = <T>(event: IpcMainInvokeEvent, operation: (store: WorkLogDatabase) => T): Result<T> => {
    if (!isTrusted(event, window)) return denied();
    if (!workLog) return startupError;
    try { return { ok: true, value: operation(workLog) }; } catch (error) { return failure(error); }
  };
  ipcMain.handle(channels.workItems, (event, day: string) => invokeWork(event, store => store.list(day)));
  ipcMain.handle(channels.searchWorkItems, (event, from: string, to: string, query?: string) =>
    invokeWork(event, store => store.search(from, to, query)));
  ipcMain.handle(channels.workHistory, (event, id: string) => invokeWork(event, store => store.history(id)));
  ipcMain.handle(channels.saveWorkItem, (event, input: unknown) => invokeWork(event, store => store.save(input,
    studentId => Boolean(database?.students().some(student => student.id === studentId)))));
  ipcMain.handle(channels.setWorkItemStatus, (event, id: string, status: WorkStatus) =>
    invokeWork(event, store => store.setStatus(id, status)));
  function invokeGrowth<T>(event: IpcMainInvokeEvent, studentId: unknown, operation: (store: GrowthProfileDatabase) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    if (!growthProfile) return growthStartupError;
    if (!database) return startupError;
    try {
      if (typeof studentId !== "string" || !database.students().some(student => student.id === studentId)) {
        throw new GrowthProfileFault("invalid", "关联的 M1 学生档案不存在，请重新选择学生。");
      }
      return { ok: true, value: operation(growthProfile) };
    } catch (error) { return failure(error); }
  }
  ipcMain.handle(channels.growthProfile, (event, studentId: unknown) =>
    invokeGrowth(event, studentId, store => store.load(studentId)));
  ipcMain.handle(channels.saveGrowthProfile, (event, raw: unknown) => {
    const studentId = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<GrowthSaveInput>).studentId : undefined;
    return invokeGrowth(event, studentId, store => store.save(raw, id => Boolean(database?.students().some(student => student.id === id))));
  });
  function invokeIntake<T>(event: IpcMainInvokeEvent, operation: (service: StudentIntakeService) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    if (!intake) return intakeStartupError;
    try { return { ok: true, value: operation(intake) }; } catch (error) { return failure(error); }
  }

  let pickingIntake = false;
  ipcMain.handle(channels.pickStudentIntake, async (event): Promise<Result<IntakeFile[]>> => {
    if (!isTrusted(event, window)) return denied();
    if (!intake) return intakeStartupError;
    if (pickingIntake) return { ok: false, code: "busy", message: "正在选择 JSON 文件。" };
    pickingIntake = true;
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        title: "选择学生资料 JSON", properties: ["openFile", "multiSelections"], filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!isTrusted(event, window)) return denied();
      if (canceled) return { ok: true, value: [] };
      if (filePaths.length > 20) return { ok: false, code: "invalid", message: "每批最多选择 20 份 JSON。" };
      intake.clearFiles();
      const results: IntakeFile[] = [];
      for (const path of filePaths) {
        const name = basename(path);
        try { results.push(intake.register(name, await readIntakeFile(path))); }
        catch (error) {
          results.push({ name, error: error instanceof WorkspaceFault ? error.message : "无法读取所选 JSON 文件。" });
        }
      }
      return { ok: true, value: results };
    } catch {
      return { ok: false, code: "failed", message: "无法打开 JSON 文件选择窗口。" };
    } finally { pickingIntake = false; }
  });
  ipcMain.handle(channels.prepareStudentIntake, (event, token: string, target?: IntakeTarget) =>
    invokeIntake(event, intake => intake.prepare(token, target)));
  ipcMain.handle(channels.saveStudentIntake, (event, input: IntakeConfirm) =>
    invokeIntake(event, intake => intake.confirm(input)));
  ipcMain.handle(channels.studentIntakeHistory, (event, studentId: string) =>
    invokeIntake(event, intake => intake.history(studentId)));

  window.once("ready-to-show", () => window.show());
  await window.loadURL(page);
}

function prepareProfile(profileName = "supervisor-workspace-mvp"): string {
  if (process.platform !== "win32") throw new Error("MVP 验收使用本机 D 盘。");
  let path = "D:\\";
  for (const [index, part] of ["Codex-Development", "Temp", profileName, "profile"].entries()) {
    path = join(path, part);
    ensureDirectory(path, index >= 2);
  }
  for (const directory of ["data", "chromium", "logs", "crash"]) ensureDirectory(join(path, directory), true);
  return path;
}

function ensureDirectory(path: string, create: boolean): void {
  if (create && !lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path);
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path) !== path) {
    throw new Error("MVP 使用独立的本机目录。");
  }
}

try {
  const syntheticM2CProfile = (process.env.M2C_SYNTHETIC_TEST === "1" && !app.isPackaged) ||
    (process.env.M2C_SYNTHETIC_PACKAGED === "1" && app.isPackaged);
  const syntheticM2BProfile = process.env.M2B_SYNTHETIC_TEST === "1" && !app.isPackaged;
  const requestedM2CProfile = process.env.M2C_SYNTHETIC_PROFILE ?? "supervisor-workspace-m2c-test";
  if (syntheticM2CProfile && !/^[A-Za-z0-9-]{1,64}$/.test(requestedM2CProfile)) throw new Error("M2-C 合成 Profile 名称无效。");
  const profileName = syntheticM2CProfile ? requestedM2CProfile
    : syntheticM2BProfile ? "supervisor-workspace-m2b-test" : "supervisor-workspace-mvp";
  const profile = prepareProfile(profileName);
  const userData = join(profile, "chromium");
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  app.setPath("crashDumps", join(profile, "crash"));
  app.setAppLogsPath(join(profile, "logs"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.focus();
    });
    app.on("window-all-closed", () => app.quit());
    app.on("will-quit", () => {
      for (const error of closeStoresIndependently(() => intakeStore?.close(), () => growthProfile?.close(), () => workLog?.close(), () => database?.close())) {
        console.error("Database close failed during application exit", error);
      }
    });
    app.whenReady().then(() => start(profile)).catch(() => {
      dialog.showErrorBox(title, "桌面窗口启动失败。请检查安装是否完整。");
      app.quit();
    });
  }
} catch {
  dialog.showErrorBox(title, "无法打开独立应用数据目录。请检查 Windows 本地应用数据目录及其权限。");
  app.quit();
}
