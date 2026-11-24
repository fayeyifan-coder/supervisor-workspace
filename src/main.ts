import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent, type Session } from "electron";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { channels, type Failure, type Result } from "./contracts";
import { failure, WorkspaceDatabase, WorkspaceFault, type M1Version } from "./database";
import { closeStoresIndependently } from "./database-lifecycle";
import { WorkLogDatabase, type WorkStatus } from "./worklog";
import { GrowthProfileDatabase, GrowthProfileFault, type GrowthSaveInput } from "./growth-profile";

import { IntakeStore, StudentIntakeService, type IntakeConfirm, type IntakeFile, type IntakeTarget } from "./student-intake";
import { maxIntakeBytes } from "./intake-format";
import { captureProtection, prepareProtectionRestore, ProtectionFiles, requireSupportedProfileOpen, validateProtection,
  verifyProtectionStores, type ProtectionFormat } from "./offline-protection";
import { OperationsDatabase } from "./operations";
import { id as scheduleId, listScheduleWeek, object as scheduleObject, readSchedulePlan, saveSchedulePlan } from "./schedule-api";
import { applyLearningChange, readLearningDay, readScheduleReceipt } from "./learning-api";
import { OperationsPending } from "./operations-pending";
import { activeName, approvedSelection, approveActiveProfile, checkOriginalProtectionMode, isParentFollowUpProfile, isStudentEditProfile, originalProfileSegments, readActivation, recoveryName, saveActivation, verifyActiveProfile, verifyProfileData,
  type ActivationState } from "./profile-activation";

const scheme = "supervisor-workspace-mvp";
const page = `${scheme}://workspace/index.html`;
const securityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'";
const appId = "cn.supervisorworkspace.desktop.mvp";
const title = "督学工作台";
const profileRoot = "D:\\Codex-Development\\Temp";
let database: WorkspaceDatabase | undefined;
let workLog: WorkLogDatabase | undefined;
let growthProfile: GrowthProfileDatabase | undefined;
let intakeStore: IntakeStore | undefined;
let operations: OperationsDatabase | undefined;
let commitSwitchOnExit: (() => void) | undefined;

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

function openProfile(profile: string, format: ProtectionFormat, m1Version: M1Version, initializeOperations = false) {
  const path = join(profile, "data", "mvp.sqlite3");
  let startupError: Failure = { ok: false, code: "recovery", message: "MVP 数据库无法打开。请保留原目录后重开。" };
  try {
    database = WorkspaceDatabase.open(path, join(profile, "data", "mvp.initialized"), m1Version);
  } catch (error) {
    if (m1Version >= 2) throw error;
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
  if (format === 2) {
    if (!database || !workLog || !growthProfile || !intakeStore) {
      throw new WorkspaceFault("recovery", "五库合成档案中有数据库无法打开，请保留现场。");
    }
    operations = OperationsDatabase.open(join(profile, "data"), database, initializeOperations);
  }
  return { startupError, growthStartupError, intakeStartupError, intake };
}

function protectionFiles() {
  return new ProtectionFiles(app.isPackaged
    ? join(process.resourcesPath, "recovery-io.exe") : join(__dirname, "recovery-io.exe"));
}

function completeStores(format: ProtectionFormat) {
  if (!database || !workLog || !growthProfile || !intakeStore || (format === 2) !== Boolean(operations)) {
    throw new WorkspaceFault("recovery", "档案所需数据库必须全部可用。请保留原档案及备份。");
  }
  return operations ? [database, workLog, growthProfile, intakeStore, operations] : [database, workLog, growthProfile, intakeStore];
}

async function start(owner: string, profile: string, state: ActivationState, opened: ReturnType<typeof openProfile>, format: ProtectionFormat, m1Version: M1Version): Promise<void> {
  const { startupError, growthStartupError, intakeStartupError, intake } = opened;
  app.setAppUserModelId(appId);
  const ui = session.fromPartition("supervisor-workspace-mvp-ui");
  const operationsPending = new OperationsPending(profile);
  restrictSession(ui);
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
  ipcMain.handle(channels.studentEditAvailable, event => isTrusted(event, window)
    ? { ok: true, value: m1Version >= 2 && format === 2 && Boolean(database && operations) } : denied());
  ipcMain.handle(channels.studentEdit, (event, id: unknown) => invoke(event, store => store.studentEditView(id)));
  function writeStudentData<T>(event: IpcMainInvokeEvent, operation: (store: WorkspaceDatabase) => T): Result<T> {
    return invoke(event, store => {
      if (protecting || state.pending) throw new WorkspaceFault("busy", "档案正在备份或切换，请完成后重试。");
      return operation(store);
    });
  }
  ipcMain.handle(channels.saveStudentEdit, (event, raw: unknown) => writeStudentData(event, store => store.saveStudentEdit(raw)));
  ipcMain.handle(channels.finishStudentEdit, (event, raw: unknown) => writeStudentData(event, store => store.finishStudentEdit(raw)));
  ipcMain.handle(channels.parentFollowUpAvailable, event => isTrusted(event, window)
    ? { ok: true, value: format === 2 && m1Version === 3 && Boolean(database && operations) } : denied());
  ipcMain.handle(channels.parentFollowUp, (event, id: unknown) => invoke(event, store => store.parentFollowUp(id)));
  ipcMain.handle(channels.createParentConcern, (event, raw: unknown) => writeStudentData(event, store => store.createParentConcern(raw)));
  ipcMain.handle(channels.appendParentFollowUp, (event, raw: unknown) => writeStudentData(event, store => store.appendParentFollowUp(raw)));
  ipcMain.handle(channels.addLesson, (event, raw: unknown) => invoke(event, store => store.addLesson(raw)));
  function invokeSchedule<T>(event: IpcMainInvokeEvent,
      operation: (store: OperationsDatabase, students: () => ReturnType<WorkspaceDatabase["students"]>) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    const m1 = database;
    if (format !== 2 || !operations || !m1) {
      return { ok: false, code: "recovery", message: "排课只在独立五库合成档案中提供。" };
    }
    try { return { ok: true, value: operation(operations, () => m1.students()) }; }
    catch (error) { return failure(error); }
  }
  ipcMain.handle(channels.scheduleAvailable, event => isTrusted(event, window)
    ? { ok: true, value: format === 2 && Boolean(operations && database) } : denied());
  ipcMain.handle(channels.scheduleWeek, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => listScheduleWeek(store, students, raw)));
  ipcMain.handle(channels.schedulePlan, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => readSchedulePlan(store, students, raw)));
  function performOperation<T>(command: Record<string, unknown>, operation: () => T): T {
    const requestId = operationsPending.begin(command);
    try {
      const result = operation();
      operationsPending.remember(requestId);
      return result;
    } catch (error) {
      const { code } = failure(error);
      if (code === "invalid" || code === "conflict") operationsPending.remember(requestId);
      throw error;
    }
  }
  ipcMain.handle(channels.saveSchedulePlan, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => {
      const command = { ...scheduleObject(raw), command: "saveAttendancePlan" };
      return performOperation(command, () => saveSchedulePlan(store, students, command));
    }));
  ipcMain.handle(channels.learningDay, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => readLearningDay(store, students, raw)));
  ipcMain.handle(channels.applyLearningChange, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => {
      const command = scheduleObject(raw);
      return performOperation(command, () => applyLearningChange(store, students, command));
    }));
  ipcMain.handle(channels.scheduleReceipt, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => readScheduleReceipt(store, students, raw)));
  ipcMain.handle(channels.pendingOperation, event =>
    invokeSchedule(event, () => operationsPending.state()));
  ipcMain.handle(channels.acknowledgeOperation, (event, raw: unknown, reviewed: unknown) =>
    invokeSchedule(event, (store, students) => {
      operationsPending.acknowledge(scheduleId(raw), reviewed === true, input => readScheduleReceipt(store, students, input));
      return null;
    }));
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
    invokeIntake(event, intake => intake.historySummary(studentId)));


  const recoveryFiles = protectionFiles();
  const recoveryRoot = format === 2 ? owner : profileRoot;
  let protecting = false;
  let lastRecovery: string | undefined;
  function protect<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<Result<T>> {
    if (!isTrusted(event, window)) return Promise.resolve(denied());
    if (protecting) return Promise.resolve({ ok: false, code: "busy", message: "正在执行离线数据保护操作。" });
    protecting = true;
    return operation().then(value => ({ ok: true, value }) as const, failure)
      .finally(() => { protecting = false; });
  }

  ipcMain.handle(channels.exportProtection, event => protect(event, async () => {
    const stores = completeStores(format);
    const choice = await dialog.showOpenDialog(window, { title: "选择新备份所在的上级目录", properties: ["openDirectory"] });
    if (choice.canceled) return null;
    const parent = choice.filePaths[0];
    const ordinaryProfile = "D:\\Codex-Development\\Temp\\supervisor-workspace-mvp\\profile";
    if ([owner, ordinaryProfile].some(p => {
      const path = relative(p, parent);
      return !isAbsolute(path) && path !== ".." && !path.startsWith("..\\");
    })) throw new WorkspaceFault("invalid", "请选择应用数据目录之外的备份位置。");
    if (profile === join(owner, "profile")) checkOriginalProtectionMode(profile, format, false, m1Version);
    else verifyProfileData(profile, false, format, m1Version);
    return recoveryFiles.publish(parent, captureProtection(stores, app.getVersion(), format, m1Version));
  }));
  ipcMain.handle(channels.restoreProtection, event => protect(event, async () => {
    const choice = await dialog.showOpenDialog(window, {
      title: "选择待验证的离线备份", properties: ["openFile"],
      filters: [{ name: "督学工作台离线备份", extensions: ["swbackup"] }],
    });
    if (choice.canceled) return null;
    const bytes = await recoveryFiles.read(choice.filePaths[0]);
    const summary = validateProtection(bytes).summary;
    if (summary.m1Version > m1Version) throw new WorkspaceFault("invalid", "该备份使用较新的学生档案版本，不能降级恢复。");
    if (format === 1 && summary.formatVersion === 2) {
      throw new WorkspaceFault("invalid", "五库备份只能恢复到五库合成验收环境。");
    }
    const legacy = format === 2 && summary.formatVersion === 1;
    const upgradeM1 = summary.m1Version < m1Version;
    const result = await dialog.showMessageBox(window, {
      type: "question", title: "恢复到独立档案", message: "备份校验通过。是否写入独立恢复副本？",
      detail: "备份时间 " + summary.createdAt + "\n学生 " + summary.students + " 名 · 工作事项 " + summary.workItems +
        " 条 · 成长档案 " + summary.growthProfiles + " 份\n导入绑定 " + summary.intakeBindings +
        " 个 · 未结束导入 " + summary.unfinishedImports + " 笔" +
        (legacy ? "\n历史四库包将生成全新的空教务库。" :
          format === 2 ? "\n到校安排 " + summary.attendancePlans + " 条" : "") +
        (upgradeM1 ? "\n学生档案将在全新副本中升级到 Schema v" + m1Version + "，原备份不变。" : "") +
        "\n恢复只生成副本。激活须另行确认。",
      buttons: ["取消", "写入恢复副本"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return null;
    const restored = await recoveryFiles.restore(recoveryRoot,
      legacy || upgradeM1 ? prepareProtectionRestore(bytes, format, m1Version) : bytes);
    lastRecovery = restored.location;
    return restored;
  }));
  ipcMain.handle(channels.activationStatus, event => isTrusted(event, window)
    ? { ok: true, value: { active: state.active?.name ?? null, pending: Boolean(state.pending), location: profile } } : denied());
  ipcMain.handle(channels.activateRecovery, event => protect(event, async () => {
    if (state.pending) throw new WorkspaceFault("conflict", "已安排档案切换。请先正常关闭并重新打开工作台。");
    const choice = await dialog.showOpenDialog(window, {
      title: "选择独立恢复副本或已激活过档案中的 restore.ready", properties: ["openFile"],
      defaultPath: lastRecovery && join(lastRecovery, "restore.ready"),
      filters: [{ name: "恢复完成记录", extensions: ["ready"] }],
    });
    if (choice.canceled) return false;
    const selected = choice.filePaths[0];
    const name = basename(dirname(dirname(selected)));
    const isRecovery = recoveryName.test(name) && selected === join(recoveryRoot, name, "profile", "restore.ready");
    const isResume = activeName.test(name) && selected === join(owner, name, "profile", "restore.ready");
    if (!isRecovery && !isResume) {
      throw new WorkspaceFault("invalid", "请选择独立恢复副本或本工作区已激活过的档案中的 restore.ready。");
    }
    const checked = isRecovery ? await recoveryFiles.inspect(recoveryRoot, name, format, m1Version) : undefined;
    const target = checked ? { name, digest: checked.digest } : approvedSelection(owner, name);
    if (checked ? state.active?.digest === target.digest : state.active?.name === name) {
      throw new WorkspaceFault("conflict", "这份资料已经是当前活动档案。");
    }
    if (isResume) verifyActiveProfile(owner, target, false, format, m1Version);
    const result = await dialog.showMessageBox(window, {
      type: "warning", title: "切换工作档案", message: "下次打开工作台时切换到所选档案？",
      detail: (checked ? "备份时间 " + checked.summary.createdAt + " · 学生 " + checked.summary.students + " 名" :
        "继续使用所选档案中已保存的记录") + "\n档案：" + selected +
        "\n当前档案及其后续改动保留在原目录。请先保存当前编辑，再正常关闭工作台。",
      buttons: ["取消", "确认下次激活"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    const pending = { kind: isRecovery ? "restore" : "resume", ...target } as const;
    commitSwitchOnExit = () => saveActivation(owner, { ...state, pending });
    state.pending = pending;
    return true;
  }));
  ipcMain.handle(channels.returnOriginalProfile, event => protect(event, async () => {
    if (!state.active || state.pending) throw new WorkspaceFault("conflict", "当前无法安排返回原始档案。");
    const result = await dialog.showMessageBox(window, {
      type: "warning", title: "返回原始档案", message: "下次打开工作台时返回原始档案？",
      detail: "恢复档案和其中保存的记录会保留。之后可通过「选择恢复档案」重新打开。",
      buttons: ["取消", "确认返回"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    const pending = { kind: "original" as const };
    commitSwitchOnExit = () => saveActivation(owner, { ...state, pending });
    state.pending = pending;
    return true;
  }));
  window.on("close", event => { if (protecting) event.preventDefault(); });

  window.once("ready-to-show", () => window.show());
  await window.loadURL(page);
}

function prepareProfile(profileName: string, format: ProtectionFormat): string {
  if (process.platform !== "win32") throw new Error("MVP 验收使用本机 D 盘。");
  // Recovery artifacts and managed active copies enter only via the explicit activation route.
  requireSupportedProfileOpen(profileName);
  let path = "D:\\";
  for (const [index, part] of ["Codex-Development", "Temp", ...originalProfileSegments(profileName, format)].entries()) {
    path = join(path, part);
    ensureDirectory(path, index >= 2);
  }
  requireSupportedProfileOpen(profileName, ["restore.ready", "recovery", "activation.approved"].some(name =>
    Boolean(lstatSync(join(path, name), { throwIfNoEntry: false }))));
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

async function startSelected(owner: string, original: string, format: ProtectionFormat, m1Version: M1Version) {
  let state = readActivation(owner);
  let profile = original;
  let opened: ReturnType<typeof openProfile>;
  try {
    if (state.pending?.kind === "opening" || state.pending?.kind === "resuming") throw new Error("Interrupted recovery activation.");
    if (state.pending?.kind === "restore") {
      const pending = state.pending;
      const files = protectionFiles();
      saveActivation(owner, { ...state, pending: { ...pending, kind: "opening" } });
      const checked = await files.inspect(format === 2 ? owner : profileRoot, pending.name, format, m1Version);
      if (checked.digest !== pending.digest) throw new Error("Selected recovery copy changed.");
      const next = await files.restore(owner, checked.bytes, true);
      const active = { name: next.profileName, digest: pending.digest };
      profile = verifyActiveProfile(owner, active, true, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      approveActiveProfile(profile, active.digest);
      const committed: ActivationState = { ...state, active, pending: null };
      saveActivation(owner, committed);
      state = committed;
    } else if (state.pending?.kind === "resume") {
      const { name, digest } = state.pending;
      saveActivation(owner, { ...state, pending: { kind: "resuming", name, digest } });
      const active = { name, digest };
      profile = verifyActiveProfile(owner, active, false, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      const committed: ActivationState = { ...state, active, pending: null };
      saveActivation(owner, committed);
      state = committed;
    } else if (state.pending?.kind === "original") {
      checkOriginalProtectionMode(original, format, false, m1Version);
      opened = openProfile(original, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      const committed: ActivationState = { ...state, active: null, pending: null };
      saveActivation(owner, committed);
      state = committed;
    } else if (state.active) {
      profile = verifyActiveProfile(owner, state.active, false, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
    } else {
      const initializeOperations = checkOriginalProtectionMode(original, format, true, m1Version);
      opened = openProfile(original, format, m1Version, initializeOperations);
      if (format === 2) verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
    }
  } catch {
    const closes = closeOpenStores();
    const fallback = state.pending ? state.active : null;
    const canReturn = closes.length === 0 && (fallback !== null || state.pending?.kind !== "original");
    const result = await dialog.showMessageBox({
      type: "error", title: "档案切换中止", message: "无法确认档案切换。已保留原档案和所有恢复资料。",
      detail: canReturn ? "可在下次启动时" + (fallback ? "返回上一个活动档案。" : "返回原始档案。") +
        "请确认后关闭并重新打开工作台。" : "关闭工作台前，请保留现有档案与备份。",
      buttons: canReturn ? ["保留现场并退出", fallback ? "安排返回上一个档案" : "安排返回原始档案"] : ["保留现场并退出"],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response === 1 && canReturn) {
      saveActivation(owner, { ...state, active: fallback, pending: fallback ? null : { kind: "original" } });
    }
    app.quit();
    return;
  }
  await start(owner, profile, state, opened, format, m1Version);
}

function closeOpenStores() {
  const errors = closeStoresIndependently(() => operations?.close(), () => intakeStore?.close(), () => growthProfile?.close(), () => workLog?.close(), () => database?.close());
  operations = undefined;
  intakeStore = undefined;
  growthProfile = undefined;
  workLog = undefined;
  database = undefined;
  return errors;
}

try {
  const syntheticM2CProfile = (process.env.M2C_SYNTHETIC_TEST === "1" && !app.isPackaged) ||
    (process.env.M2C_SYNTHETIC_PACKAGED === "1" && app.isPackaged);
  const syntheticM2BProfile = process.env.M2B_SYNTHETIC_TEST === "1" && !app.isPackaged;
  const requestedM2CProfile = process.env.M2C_SYNTHETIC_PROFILE ?? "supervisor-workspace-m2c-test";
  if (syntheticM2CProfile && (!/^[A-Za-z0-9-]{1,64}$/.test(requestedM2CProfile) ||
      requestedM2CProfile.toLowerCase() === "supervisor-workspace-mvp")) throw new Error("合成 Profile 名称无效。");
  const profileName = syntheticM2CProfile ? requestedM2CProfile
    : syntheticM2BProfile ? "supervisor-workspace-m2b-test" : "supervisor-workspace-mvp";
  const m1Version: M1Version = syntheticM2CProfile && isParentFollowUpProfile(profileName) ? 3
    : syntheticM2CProfile && isStudentEditProfile(profileName) ? 2 : 1;
  const format: ProtectionFormat = m1Version >= 2 || (syntheticM2CProfile && /^sw-r2a-[a-z0-9-]+$/.test(profileName)) ? 2 : 1;
  const profile = prepareProfile(profileName, format);
  const owner = dirname(profile);
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
      const errors = closeOpenStores();
      for (const error of errors) {
        console.error("Database close failed during application exit", error);
      }
      if (commitSwitchOnExit) {
        try {
          if (errors.length > 0) throw new Error("Database close failed.");
          commitSwitchOnExit();
        } catch {
          dialog.showErrorBox(title, "无法安排档案切换。请保留当前档案和恢复资料，重新打开后核对。");
        }
      }
    });
    app.whenReady().then(() => startSelected(owner, profile, format, m1Version)).catch(error => {
      dialog.showErrorBox(title, error instanceof WorkspaceFault ? error.message : "桌面窗口启动失败。请保留档案并检查安装。");
      app.quit();
    });
  }
} catch (error) {
  dialog.showErrorBox(title, error instanceof WorkspaceFault ? error.message :
    "无法打开独立应用数据目录。请检查 Windows 本地应用数据目录及其权限。");
  app.quit();
}
