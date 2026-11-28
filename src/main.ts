import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { channels, type Failure, type Result, type WorkspaceInfo } from "./contracts";
import { failure as workspaceFailure, latestM1Version, WorkspaceDatabase, WorkspaceFault, type M1Version } from "./database";
import { closeStoresIndependently } from "./database-lifecycle";
import { WorkLogDatabase, type WorkStatus } from "./worklog";
import { GrowthProfileDatabase, GrowthProfileFault, type GrowthSaveInput } from "./growth-profile";

import { IntakeStore, StudentIntakeService, type IntakeConfirm, type IntakeFile, type IntakeTarget } from "./student-intake";
import { maxIntakeBytes } from "./intake-format";
import { captureProtection, prepareProtectionRestore, ProtectionFiles, requireSupportedProfileOpen, validateProtection,
  verifyProtectionStores, type ProtectionFormat } from "./offline-protection";
import { documentLimit, emptyPlan, type PlanPickResult, type PlanSourceCell } from "./study-plan-model";
import { readPlanBoard } from "./study-plan-overview";
import { linkPlanTask, listPlanTasks } from "./study-plan-links";
import { getDailyContext } from "./learning-daily";
import { DailyDrafts } from "./learning-drafts";
import { readTracking } from "./learning-tracking";
import { readReview } from "./learning-week-review";
import {applyBackupPageLimit,readBackupCapacity} from "./backup-capacity";
import { readWeeklyManagement } from "./learning-week-overview";
import { addManualStudyPlan, savePlanVersion, studentPlanViews } from "./study-plan-versions";
import { parseStudyPlan } from "./study-plan-docx";
import { addStudyPlan, digestDocument, listStudyPlans, planExists, planId, planObject, studyPlanSource } from "./study-plans";
import { OperationsDatabase } from "./operations";
import { summarizeStudentOverview } from "./student-overview";
import { shanghaiMinute, shanghaiParts, shiftDate } from "./schedule-calendar";
import { id as scheduleId, listFlexibleWeek, listScheduleWeek, object as scheduleObject, readSchedulePlan, saveSchedulePlan } from "./schedule-api";
import { applyLearningChange, readAttendanceBoard, readLearningDay, readScheduleReceipt } from "./learning-api";
import { StudentWriteRecovery } from "./student-write-recovery";
import { OperationsPending } from "./operations-pending";
import { ProfileWriteGate } from "./profile-write-gate";
import { isWithin, plainFile, productionInstallRoot, productionRootOf, requireLocalDirectory, requireProductionProfile } from "./production-profile";
import { readBackupStatus, recordSuccessfulBackup } from "./backup-status";
import { Diagnostics, sqliteErrorCode } from "./diagnostics";
import { BusinessExportPlans } from "./business-export";
import { BusinessExportFiles, requireExportDestination } from "./business-export-files";
import { adjustSigninPlan, loadSigninTemplate, readSigninPlan, signinPlanKey, signinWorkbook, writeSigninFile } from "./signin-sheets";
import { signinLabels } from "./signin-calendar";
import { activeName, approvedSelection, approveActiveProfile, checkOriginalProtectionMode, isParentFollowUpProfile, isStudentEditProfile, studentServicesVersion, originalProfileSegments, readActivation, recoveryName, restoredStudentVersion, saveActivation, verifyActiveProfile, verifyProfileData,
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
let diagnostics: Diagnostics | undefined;
const ipcFailure = new AsyncLocalStorage<{ sqliteCode?: number }>();

function failure(error: unknown): Failure {
  const context = ipcFailure.getStore();
  if (context) context.sqliteCode = sqliteErrorCode(error);
  return workspaceFailure(error);
}

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
      throw new WorkspaceFault("recovery", "五库档案中有数据库无法打开，请保留现场。");
    }
    operations = OperationsDatabase.open(join(profile, "data"), database, initializeOperations);
    if(m1Version>=16)for(const store of completeStores(format))applyBackupPageLimit(store.protectionConnection());
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

interface ProductionPaths { root: string; exports: string; logs: string }

async function start(owner: string, profile: string, state: ActivationState, opened: ReturnType<typeof openProfile>, format: ProtectionFormat, m1Version: M1Version, production?: ProductionPaths): Promise<void> {
  const { startupError, growthStartupError, intakeStartupError, intake } = opened;
  app.setAppUserModelId(appId);
  const ui = session.fromPartition("supervisor-workspace-mvp-ui");
  const operationsPending = new OperationsPending(profile);
  const studentWrites = new StudentWriteRecovery(profile);
  const gate = new ProfileWriteGate(() => Boolean(state.pending));
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

  function handle<T, Args extends unknown[]>(channel: string,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Result<T> | Promise<Result<T>>) {
    ipcMain.handle(channel, (event, ...args: Args) => ipcFailure.run({}, async () => {
      let reply: Result<T>;
      try { reply = await operation(event, ...args); }
      catch (error) { reply = failure(error); }
      if (!reply.ok) diagnostics?.record(channel, reply.code, ipcFailure.getStore()?.sqliteCode);
      return reply;
    }));
  }

  function handleWrite<T, Args extends unknown[]>(channel: string,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Result<T> | Promise<Result<T>>) {
    handle(channel, async (event, ...args: Args) => {
      if (!isTrusted(event, window)) return denied();
      try { return await gate.write(() => operation(event, ...args)); }
      catch (error) { return failure(error); }
    });
  }

  function invoke<T>(event: IpcMainInvokeEvent, operation: (store: WorkspaceDatabase) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    if (!database) return startupError;
    try {
      return { ok: true, value: operation(database) };
    } catch (error) {
      return failure(error);
    }
  }
  handle(channels.students, event => invoke(event, store => store.students()));
  handle(channels.history, (event, id: unknown) => invoke(event, store => store.history(id)));
  handleWrite(channels.createStudent, (event, raw: unknown) => invoke(event, store => store.createStudent(raw)));
  handle(channels.studentEditAvailable, event => isTrusted(event, window)
    ? { ok: true, value: m1Version >= 2 && format === 2 && Boolean(database && operations) } : denied());
  handle(channels.studentEdit, (event, id: unknown) => invoke(event, store => store.studentEditView(id)));
  handleWrite(channels.saveStudentEdit, (event, raw: unknown) => invoke(event, store => store.saveStudentEdit(raw)));
  handleWrite(channels.finishStudentEdit, (event, raw: unknown) => invoke(event, store => store.finishStudentEdit(raw)));
  handle(channels.parentFollowUpAvailable, event => isTrusted(event, window)
    ? { ok: true, value: format === 2 && m1Version >= 3 && Boolean(database && operations) } : denied());
  handle(channels.parentFollowUp, (event, id: unknown) => invoke(event, store => store.parentFollowUp(id)));
  handleWrite(channels.createParentConcern, (event, raw: unknown) => invoke(event, store => {
    const command = store.studentWriteCommand("concern", raw);
    return studentWrites.run(store, command, () => store.createParentConcern(command.input));
  }));
  handleWrite(channels.appendParentFollowUp, (event, raw: unknown) => invoke(event, store => {
    const command = store.studentWriteCommand("followUp", raw);
    return studentWrites.run(store, command, () => store.appendParentFollowUp(command.input));
  }));
  handle(channels.studentRecordVersion, event => isTrusted(event, window)
    ? { ok: true, value: format === 2 && database && operations ? m1Version : 0 } : denied());
  handle(channels.studentRecords, (event, kind: unknown, studentId: unknown) =>
    invoke(event, store => store.studentRecords(kind, studentId)));
  handleWrite(channels.saveStudentRecord, (event, raw: unknown) => invoke(event, store => {
    const command = store.studentWriteCommand("record", raw);
    return studentWrites.run(store, command, () => store.saveStudentRecord(command.input));
  }));
  handle(channels.studentLifecycle, (event, studentId: unknown) => invoke(event, store => store.studentLifecycle(studentId)));
  handle(channels.studentOverview, (event, rawStudentId: unknown) => invoke(event, store => {
    const ops = operations, growth = growthProfile;
    if (m1Version < 8 || !ops || !growth) throw new WorkspaceFault("recovery", "当前档案尚未启用综合概览。");
    const studentId = scheduleId(rawStudentId);
    const concerns = store.parentFollowUp(studentId);
    const now = Date.now(), date = shanghaiParts(now).date;
    const start = shanghaiMinute(date, "00:00");
    const end = shanghaiMinute(shiftDate(date, 14), "00:00");
    if (start === null || end === null) throw new WorkspaceFault("failed", "无法确定到校查询日期。");
    ops.protectionConnection();
    const visits = ops.listAttendancePlans(start, end, studentId).map(plan =>
      ({ plan, blocks: ops.learningBlocksForAttendance(plan.id) }));
    return summarizeStudentOverview({ studentId, concerns, visits, now, scores: store.studentRecords("score", studentId).records,
      growth: growth.load(studentId), history: store.history(studentId),
      flexWindows: ops.flexibilityEnabled ? ops.flexWindows(date, shiftDate(date, 13), studentId) : undefined });
  }));
  handleWrite(channels.saveStudentLifecycle, (event, raw: unknown) => invoke(event, store => {
    const command = store.studentWriteCommand("lifecycle", raw);
    return studentWrites.run(store, command, () => store.saveStudentLifecycle(command.input));
  }));
  function requireStudentWriteSupport() {
    if (m1Version < 3 || format !== 2 || !operations) throw new WorkspaceFault("recovery", "当前档案没有启用学生资料请求恢复。");
  }
  handle(channels.studentWriteState, event => invoke(event, store => {
    requireStudentWriteSupport();
    return studentWrites.state(store);
  }));
  handleWrite(channels.resolveStudentWrite, (event, action: unknown, requestId: unknown) =>
    invoke(event, store => {
      requireStudentWriteSupport();
      return studentWrites.resolve(store, action, requestId);
    }));
  handleWrite(channels.addLesson, (event, raw: unknown) => invoke(event, store => store.addLesson(raw)));
  handle(channels.weeklyLearningManagement,(event,raw:unknown)=>invoke(event,store=>{
    if(m1Version<16||!operations||!workLog)throw new WorkspaceFault("invalid","当前档案尚不支持学习管理总览。");
    return readWeeklyManagement({m1:store.protectionConnection(),ops:operations.protectionConnection(),work:workLog.protectionConnection()},store.students(),raw);
  }));
  handle(channels.weeklyReview,(event,student:unknown,range:unknown)=>invoke(event,store=>{
    if(m1Version<16||!operations||!workLog)throw new WorkspaceFault("invalid","当前档案尚不支持每周复盘。");
    return readReview({m1:store.protectionConnection(),ops:operations.protectionConnection(),work:workLog.protectionConnection()},student,range);
  }));
  handleWrite(channels.saveWeeklyReview,(event,raw:unknown)=>invoke(event,store=>{
    if(m1Version<16||!operations||!workLog||operationsPending.state().kind!=="empty")throw new WorkspaceFault("recovery","复盘需要已确认的教务事实。");
    return store.saveWeeklyReview(operations.protectionConnection(),workLog.protectionConnection(),raw);
  }));
  handle(channels.learningTracking,(event,student:unknown)=>invoke(event,store=>{
    if(m1Version<15||!workLog)throw new WorkspaceFault("invalid","当前档案尚不支持单元检测。");
    return readTracking(store.protectionConnection(),workLog.protectionConnection(),student);
  }));
  handleWrite(channels.saveLearningTracking,(event,raw:unknown)=>invoke(event,store=>{
    if(m1Version<15||!workLog)throw new WorkspaceFault("invalid","当前档案尚不支持单元检测。");
    return store.saveLearningTracking(workLog.protectionConnection(),raw);
  }));
  const dailyDrafts=new DailyDrafts(profile);
  function draftStudent(store:WorkspaceDatabase,value:unknown){
    const id=planId(value);
    if(m1Version<14||!store.students().some(student=>student.id===id))throw new WorkspaceFault("invalid","快速登记草稿的学生身份无效。");
    return id;
  }
  handle(channels.quickLearningDraft,(event,studentId:unknown)=>invoke(event,store=>dailyDrafts.read(draftStudent(store,studentId))));
  handleWrite(channels.saveQuickLearningDraft,(event,studentId:unknown,raw:unknown)=>invoke(event,store=>dailyDrafts.save(draftStudent(store,studentId),raw)));
  handle(channels.dailyContext,(event,student:unknown,date:unknown)=>invoke(event,store=>{
    if(m1Version<14||!operations)throw new WorkspaceFault("invalid","当前档案尚不支持快速学习登记。");
    return getDailyContext(store.protectionConnection(),operations.protectionConnection(),student,date);
  }));
  handleWrite(channels.addQuickLesson,(event,raw:unknown)=>invoke(event,store=>{
    if(m1Version<14||!operations||operationsPending.state().kind!=="empty")throw new WorkspaceFault("recovery","请先完成教务待确认请求。");
    return store.addQuickLesson(operations.protectionConnection(),raw);
  }));
  function invokeSchedule<T>(event: IpcMainInvokeEvent,
      operation: (store: OperationsDatabase, students: () => ReturnType<WorkspaceDatabase["students"]>) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    const m1 = database;
    if (format !== 2 || !operations || !m1) {
      return { ok: false, code: "recovery", message: "排课需要可用的五库档案。" };
    }
    try { return { ok: true, value: operation(operations, () => m1.students()) }; }
    catch (error) { return failure(error); }
  }
  handle(channels.scheduleAvailable, event => isTrusted(event, window)
    ? { ok: true, value: format === 2 && Boolean(operations && database) } : denied());
  handle(channels.scheduleConfiguration, event => invokeSchedule(event, store => store.scheduleConfiguration()));
  handleWrite(channels.changeCycleSchedule, (event, raw: unknown) => invokeSchedule(event, store => {
    if (operationsPending.state().kind !== "empty") throw new WorkspaceFault("recovery", "请先核对原教务请求。");
    return store.changeCycleSchedule(raw);
  }));
  handle(channels.scheduleWeek, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => listScheduleWeek(store, students, raw)));
  handle(channels.scheduleFlexWeek, (event, raw: unknown) => invokeSchedule(event, (store, students) => listFlexibleWeek(store, students, raw)));
  handle(channels.attendanceBoard, event => invokeSchedule(event, readAttendanceBoard));
  handle(channels.schedulePlan, (event, raw: unknown) =>
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
  handleWrite(channels.saveSchedulePlan, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => {
      const command = { ...scheduleObject(raw), command: "saveAttendancePlan" };
      return performOperation(command, () => saveSchedulePlan(store, students, command));
    }));
  handle(channels.learningDay, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => {
      const day=readLearningDay(store, students, raw);
      if(m1Version<13)return day;
      const tasks=listPlanTasks(planningStore(),store.protectionConnection(),day.attendance.studentId,{attendanceId:day.attendance.id});
      const planningSources=Object.fromEntries(tasks.filter(task=>task.link)
        .map(({id,link,linkState})=>[id,{link,linkState}]));
      return {...day,planningSources};
    }));
  handleWrite(channels.applyLearningChange, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => {
      const command = scheduleObject(raw);
      return performOperation(command, () => applyLearningChange(store, students, command));
    }));
  handle(channels.scheduleReceipt, (event, raw: unknown) =>
    invokeSchedule(event, (store, students) => readScheduleReceipt(store, students, raw)));
  handle(channels.pendingOperation, event =>
    invokeSchedule(event, () => operationsPending.state()));
  handleWrite(channels.acknowledgeOperation, (event, raw: unknown, reviewed: unknown) =>
    invokeSchedule(event, (store, students) => {
      operationsPending.acknowledge(scheduleId(raw), reviewed === true, input => readScheduleReceipt(store, students, input));
      return null;
    }));
  const invokeWork = <T>(event: IpcMainInvokeEvent, operation: (store: WorkLogDatabase) => T): Result<T> => {
    if (!isTrusted(event, window)) return denied();
    if (!workLog) return startupError;
    try { return { ok: true, value: operation(workLog) }; } catch (error) { return failure(error); }
  };
  handle(channels.workItems, (event, day: string) => invokeWork(event, store => store.list(day)));
  handle(channels.searchWorkItems, (event, from: string, to: string, query?: string) =>
    invokeWork(event, store => store.search(from, to, query)));
  handle(channels.workHistory, (event, id: string) => invokeWork(event, store => store.history(id)));
  handleWrite(channels.saveWorkItem, (event, input: unknown) => invokeWork(event, store => store.save(input,
    studentId => Boolean(database?.students().some(student => student.id === studentId)))));
  handleWrite(channels.setWorkItemStatus, (event, id: string, status: WorkStatus) =>
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
  handle(channels.growthProfile, (event, studentId: unknown) =>
    invokeGrowth(event, studentId, store => store.load(studentId)));
  handleWrite(channels.saveGrowthProfile, (event, raw: unknown) => {
    const studentId = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<GrowthSaveInput>).studentId : undefined;
    return invokeGrowth(event, studentId, store => store.save(raw, id => Boolean(database?.students().some(student => student.id === id))));
  });
  function invokeIntake<T>(event: IpcMainInvokeEvent, operation: (service: StudentIntakeService) => T): Result<T> {
    if (!isTrusted(event, window)) return denied();
    if (!intake) return intakeStartupError;
    try { return { ok: true, value: operation(intake) }; } catch (error) { return failure(error); }
  }

  let pickingIntake = false;
  handleWrite(channels.pickStudentIntake, async (event): Promise<Result<IntakeFile[]>> => {
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
  handleWrite(channels.prepareStudentIntake, (event, token: string, target?: IntakeTarget) =>
    invokeIntake(event, intake => intake.prepare(token, target)));
  handleWrite(channels.saveStudentIntake, (event, input: IntakeConfirm) =>
    invokeIntake(event, intake => intake.confirm(input)));
  handle(channels.studentIntakeHistory, (event, studentId: string) =>
    invokeIntake(event, intake => intake.historySummary(studentId)));


  const recoveryFiles = protectionFiles();
  const businessPlans = new BusinessExportPlans();
  const businessFiles = new BusinessExportFiles(app.isPackaged ? join(process.resourcesPath, "recovery-io.exe") : join(__dirname, "recovery-io.exe"));
  const exportContext = () => profile + "|" + window.webContents.id;
  const exportForbiddenRoots = () => [owner, dirname(app.getPath("exe")), app.getAppPath(),
    "D:\\SupervisorWorkspace\\App", "D:\\SupervisorWorkspace\\Profiles", "D:\\SupervisorWorkspace\\Logs"];
  function businessExportStores() {
    if (format !== 2 || m1Version < 6 || !database) throw new WorkspaceFault("invalid", "业务导出需要五库 v6 或更新档案。");
    const stores = completeStores(format);
    if (database.hasPendingStudentEdits() || intakeStore?.hasUnsettledJobs() || operationsPending.state().kind !== "empty") throw new WorkspaceFault("recovery", "请先核对待确认的档案编辑、导入及教务请求，再生成导出。");
    studentWrites.requireSettled(database);
    return stores;
  }
  const recoveryRoot = format === 2 ? owner : profileRoot;
  let lastRecovery: string | undefined;
  async function protect<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<Result<T>> {
    if (!isTrusted(event, window)) return denied();
    try { return { ok: true, value: await gate.protect(operation) }; }
    catch (error) { return failure(error); }
  }

  async function requireSwitchReady(event: IpcMainInvokeEvent, freeze = false) {
    if (!isTrusted(event, window)) throw new WorkspaceFault("invalid", "工作窗口已经变化，请重试。");
    if (state.pending) throw new WorkspaceFault("conflict", "档案切换已确认，工作台正在退出。");
    for (const store of completeStores(format)) store.protectionConnection();
    if (database?.hasPendingStudentEdits() || intakeStore?.hasUnsettledJobs() || operationsPending.state().kind !== "empty") {
      throw new WorkspaceFault("recovery", "请先核对待确认的学生编辑、导入或教务请求，再切换档案。");
    }
    if (m1Version >= 3 && database) studentWrites.requireSettled(database);
    const ready: unknown = await window.webContents.executeJavaScript(
      "window.profileSwitchReady?.(" + (freeze ? "true" : "false") + ") === true");
    if (ready !== true || !isTrusted(event, window)) {
      throw new WorkspaceFault("busy", "请先保存或关闭未完成的表单，并等待操作结束。输入仍保留。");
    }
  }

  function queueProfileSwitch(pending: NonNullable<ActivationState["pending"]>) {
    const commit = () => saveActivation(owner, { ...state, pending }, Boolean(production));
    commitSwitchOnExit = commit;
    state.pending = pending;
    // The protection promise releases its gate before the next event-loop turn.
    setImmediate(() => {
      app.quit();
      setTimeout(() => {
        if (window.isDestroyed() || commitSwitchOnExit !== commit) return;
        commitSwitchOnExit = undefined;
        state.pending = null;
        diagnostics?.record("lifecycle:switch", "failed");
        void window.webContents.executeJavaScript("window.profileSwitchCancel?.()").catch(() => undefined);
        dialog.showErrorBox(title, "工作台未能正常退出，档案切换未安排。请核对当前档案后重试。");
      }, 5000).unref();
    });
  }

  handle(channels.exportProtection, event => protect(event, async () => {
    const stores = completeStores(format);
    const choice = await dialog.showOpenDialog(window, {
      title: "选择新备份所在的上级目录", properties: ["openDirectory"], defaultPath: production?.exports,
    });
    if (choice.canceled) return null;
    const parent = choice.filePaths[0];
    const ordinaryProfile = "D:\\Codex-Development\\Temp\\supervisor-workspace-mvp\\profile";
    if ((production && ((isWithin(production.root, parent) && !isWithin(production.exports, parent)) ||
      isWithin(profileRoot, parent))) ||
      [owner, ordinaryProfile].some(p => {
      const path = relative(p, parent);
      return !isAbsolute(path) && path !== ".." && !path.startsWith("..\\");
    })) throw new WorkspaceFault("invalid", "请选择应用数据目录之外的备份位置。");
    if (profile !== join(owner, "profile")) verifyProfileData(profile, false, format, m1Version);
    else if (production) requireProductionProfile(production.root);
    else checkOriginalProtectionMode(profile, format, false, m1Version);
    if (m1Version >= 3 && database) studentWrites.requireSettled(database);
    const result = await recoveryFiles.publish(parent, captureProtection(stores, app.getVersion(), format, m1Version));
    try { recordSuccessfulBackup(profile, new Date()); }
    catch (error) { diagnostics?.record("protection:backup-status", "failed", sqliteErrorCode(error)); }
    return result;
  }));
  const planDocuments = new Map<string, {filename:string;bytes:Buffer;sha256:string;cells:PlanSourceCell[];id:string}>();
  function planningStore() {
    if (m1Version < 11 || format !== 2 || !database) throw new WorkspaceFault("invalid","当前档案版本尚不支持半年学习规划。");
    return database.protectionConnection();
  }
  handleWrite(channels.pickStudyPlans, async (event): Promise<Result<PlanPickResult[]>> => {
    if (!isTrusted(event, window)) return denied();
    try {
      planningStore();
      const choice=await dialog.showOpenDialog(window,{title:"选择半年学习规划 Word 原件",properties:["openFile","multiSelections"],
        filters:[{name:"Word 规划",extensions:["docx","doc"]}]});
      if (!isTrusted(event,window)||state.pending) return denied();
      if (choice.canceled) return {ok:true,value:[]};
      if (!choice.filePaths.length||choice.filePaths.length>20) throw new WorkspaceFault("invalid","每次请选择 1 至 20 份 Word 文件。");
      planDocuments.clear();
      const db=planningStore(), results:PlanPickResult[]=[];
      for (const path of choice.filePaths) {
        const name=basename(path), extension=extname(name).toLowerCase();
        try {
          if (extension!==".docx"&&extension!==".doc") throw new WorkspaceFault("invalid","请选择 DOCX 或旧版 DOC。");
          plainFile(path,documentLimit);
          const entry=lstatSync(path);
          const handle=await open(path,"r");
          let bytes:Buffer;
          try {
            const opened=await handle.stat(), size=opened.size;
            if(!opened.isFile()||opened.dev!==entry.dev||opened.ino!==entry.ino||opened.mtimeMs!==entry.mtimeMs)
              throw new WorkspaceFault("conflict","Word 文件可能已改变，请重新选择。");
            if (size<8||size>documentLimit) throw new WorkspaceFault("invalid","单份 Word 原件须在 512 KiB 内。");
            bytes=Buffer.alloc(size+1);
            const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
            const after=await handle.stat();
            if (bytesRead!==size||after.size!==size||after.mtimeMs!==opened.mtimeMs) throw new WorkspaceFault("conflict","Word 文件可能已改变，请重新选择。");
            bytes=bytes.subarray(0,size);
          } finally { await handle.close(); }
          if (extension===".doc"&&!bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) {
            throw new WorkspaceFault("invalid","这不是可确认的旧版 Word 文件。");
          }
          const preview=extension===".docx"?parseStudyPlan(bytes):{fields:emptyPlan(),cells:[],warnings:["旧版 DOC 原件会保留。可在 Word 本地另存为 DOCX 后重新选择，或在此人工补全。"]};
          const token=randomUUID(), sha256=digestDocument(bytes);
          planDocuments.set(token,{filename:name,bytes,sha256,cells:preview.cells,id:randomUUID()});
          results.push({name,review:{token,name,sha256,duplicate:planExists(db,sha256),...preview}});
        } catch(error) { results.push({name,issue:error instanceof WorkspaceFault ? error.message : "文件无法读取，请在 Word 本地核对原件。"}); }
      }
      return {ok:true,value:results};
    } catch(error){ return failure(error); }
  });
  handleWrite(channels.saveStudyPlan,(event,raw:unknown)=>invoke(event,()=>{
    const request=planObject(raw), token=planId(request.token), source=planDocuments.get(token);
    if(!source||request.confirmed!==true)throw new WorkspaceFault("invalid","请重新选择 Word 文件，预览后人工确认学生。");
    return addStudyPlan(planningStore(),planId(request.studentId),request.fields,source,source.id);
  }));
  handle(channels.studyPlans,(event,id:unknown)=>invoke(event,()=>m1Version>=12
    ? studentPlanViews(planningStore(),planId(id)):listStudyPlans(planningStore(),planId(id))));
  handleWrite(channels.createManualPlan,(event,raw:unknown)=>invoke(event,()=>{
    if(m1Version<12)throw new WorkspaceFault("invalid","当前档案尚不支持手工规划。");
    const input=planObject(raw);
    return addManualStudyPlan(planningStore(),planId(input.studentId),planId(input.id),input.fields);
  }));
  handleWrite(channels.savePlanVersion,(event,raw:unknown)=>invoke(event,()=>{
    if(m1Version<12)throw new WorkspaceFault("invalid","当前档案尚不支持执行规划。");
    return savePlanVersion(planningStore(),raw,m1Version>=13);
  }));
  handle(channels.studyPlanBoard,(event,raw:unknown)=>invoke(event,store=>{
    if(m1Version<13||!operations)throw new WorkspaceFault("invalid","当前档案尚不支持学习规划总览。");
    return readPlanBoard(planningStore(),operations.protectionConnection(),store.students(),raw);
  }));
  handle(channels.planTasks,(event,id:unknown)=>invoke(event,()=>{
    if(m1Version<13||!operations)throw new WorkspaceFault("invalid","当前档案尚不支持任务来源关联。");
    return listPlanTasks(planningStore(),operations.protectionConnection(),planId(id));
  }));
  handleWrite(channels.linkPlanTask,(event,raw:unknown)=>invoke(event,()=>{
    if(m1Version<13||!operations||operationsPending.state().kind!=="empty") {
      throw new WorkspaceFault("recovery","请先完成原教务请求，再关联实际学习任务。");
    }
    return linkPlanTask(planningStore(),operations.protectionConnection(),raw);
  }));
  handle(channels.studyPlanSource,(event,id:unknown,plan:unknown)=>invoke(event,()=>{
    const {metadata,cells}=studyPlanSource(planningStore(),planId(id),planId(plan));
    return {metadata,cells};
  }));
  handle(channels.exportStudyPlanSource,(event,id:unknown,plan:unknown)=>protect(event,async()=>{
    const source=studyPlanSource(planningStore(),planId(id),planId(plan));
    const extension=extname(source.metadata.filename).toLowerCase();
    const choice=await dialog.showSaveDialog(window,{title:"在私有目录保存已核验的 Word 原件副本",
      defaultPath:join(production?.exports??"D:\\Codex-Development\\Exports",source.metadata.filename),
      filters:[{name:"Word 原件",extensions:[extension.slice(1)]}]});
    if(choice.canceled||!choice.filePath)return null;
    if(!isTrusted(event,window)||state.pending)throw new WorkspaceFault("busy","工作窗体已变化，请重新打开规划。");
    const destination=choice.filePath;
    if(extname(destination).toLowerCase()!==extension)throw new WorkspaceFault("invalid","原件副本必须保留原扩展名。");
    if(production&&isWithin(production.root,destination)&&!isWithin(production.exports,destination)) {
      throw new WorkspaceFault("invalid","请选择专用 Exports 或其余私有目录。");
    }
    requireExportDestination(dirname(destination),exportForbiddenRoots());
    const file=await open(destination,"wx");
    try { await file.writeFile(source.bytes); await file.sync(); }
    finally { await file.close(); }
    return destination;
  }));
  handle(channels.previewSignin, (event, input: unknown) => invokeSchedule(event, (store, students) => {
    if (state.pending) throw new WorkspaceFault("busy", "当前档案即将切换，请重新打开课表。");
    const preview = readSigninPlan(store, students(), input);
    return { preview, key: signinPlanKey(preview) };
  }));
  handle(channels.exportSignin, (event, raw: unknown) => protect(event, async () => {
    const store = operations, m1 = database;
    if (!store?.flexibilityEnabled || !m1 || state.pending || operationsPending.state().kind !== "empty") {
      throw new WorkspaceFault("recovery", "请先核对未决教务操作，再导出签到表。");
    }
    const { input, changes, key } = scheduleObject(raw);
    const students = m1.students();
    const preview = readSigninPlan(store, students, input);
    if (key !== signinPlanKey(preview)) throw new WorkspaceFault("conflict", "预计名单已变化，请重新预览并核对。");
    adjustSigninPlan(preview, students, changes);
    const filter = [{ name: "Excel 工作簿", extensions: ["xlsx"] }];
    const source = await dialog.showOpenDialog(window, { title: "选择本机签到表原始模板", properties: ["openFile"], filters: filter });
    if (source.canceled) return null;
    const destination = await dialog.showSaveDialog(window, { title: "保存预计签到表", filters: filter,
      defaultPath: join(production?.exports ?? "D:\\Codex-Development\\Exports", signinLabels[preview.input.kind] + "-" + preview.input.period + ".xlsx") });
    if (destination.canceled || !destination.filePath) return null;
    if (!isTrusted(event, window)) throw new WorkspaceFault("conflict", "工作窗口已变化，请重新预览。");
    const output = destination.filePath;
    if (production && isWithin(production.root, output) && !isWithin(production.exports, output)) {
      throw new WorkspaceFault("invalid", "请选择正式档案和程序以外的导出位置。");
    }
    requireExportDestination(dirname(output), exportForbiddenRoots());
    const content = await signinWorkbook(await loadSigninTemplate(source.filePaths[0]), preview);
    return writeSigninFile(output, content, preview, exportForbiddenRoots());
  }));
  handle(channels.prepareBusinessExport, (event, input: {includeSourceText: boolean}) => protect(event, async () => {
    if (!input || typeof input.includeSourceText !== "boolean" || Object.keys(input).join(",") !== "includeSourceText") throw new WorkspaceFault("invalid", "请选择本次全量导出范围。");
    const stores = businessExportStores();
    if (profile !== join(owner, "profile")) verifyProfileData(profile, false, format, m1Version);
    else if (production) requireProductionProfile(production.root);
    else checkOriginalProtectionMode(profile, format, false, m1Version);
    return businessPlans.prepare(exportContext(), captureProtection(stores, app.getVersion(), format, m1Version), input.includeSourceText);
  }));
  handle(channels.writeBusinessExport, (event, token: string) => protect(event, async () => {
    businessExportStores();
    businessPlans.peek(token, exportContext());
    const choice = await dialog.showOpenDialog(window, {title: "选择仓库外的业务导出目录（将新建独立文件夹）", properties: ["openDirectory"], defaultPath: production?.exports ?? "D:\\Codex-Development\\Exports"});
    if (!isTrusted(event, window)) throw new WorkspaceFault("invalid", "工作窗口已经变化，请重新预览。");
    if (choice.canceled) return null;
    const parent = choice.filePaths[0];
    if (production && isWithin(production.root, parent) && !isWithin(production.exports, parent)) throw new WorkspaceFault("invalid", "请选择正式档案和程序以外的导出位置，或使用专用 Exports 目录。");
    requireExportDestination(parent, exportForbiddenRoots());
    return businessFiles.publish(parent, businessPlans.take(token, exportContext()), exportForbiddenRoots());
  }));
  handle(channels.cancelBusinessExport, (event, token: string) => {
    if (!isTrusted(event, window)) return denied();
    businessPlans.cancel(token, exportContext()); return {ok: true, value: null};
  });
  handle(channels.restoreProtection, event => protect(event, async () => {
    const choice = await dialog.showOpenDialog(window, {
      title: "选择待验证的离线备份", properties: ["openFile"],
      filters: [{ name: "督学工作台离线备份", extensions: ["swbackup"] }],
    });
    if (choice.canceled) return null;
    const bytes = await recoveryFiles.read(choice.filePaths[0]);
    const summary = validateProtection(bytes).summary;
    const restoreVersion = production ? latestM1Version : m1Version;
    if (summary.m1Version > restoreVersion) throw new WorkspaceFault("invalid", "该备份使用较新的学生档案版本，不能降级恢复。");
    if (format === 1 && summary.formatVersion === 2) {
      throw new WorkspaceFault("invalid", "五库备份只能恢复到支持五库的环境。");
    }
    const legacy = format === 2 && summary.formatVersion === 1;
    const upgradeM1 = summary.m1Version < restoreVersion;
    const result = await dialog.showMessageBox(window, {
      type: "question", title: "恢复到独立档案", message: "备份校验通过。是否写入独立恢复副本？",
      detail: "备份时间 " + summary.createdAt + "\n学生 " + summary.students + " 名 · 工作事项 " + summary.workItems +
        " 条 · 成长档案 " + summary.growthProfiles + " 份\n导入绑定 " + summary.intakeBindings +
        " 个 · 未结束导入 " + summary.unfinishedImports + " 笔" +
        (legacy ? "\n历史四库包将生成全新的空教务库。" :
          format === 2 ? "\n到校安排 " + summary.attendancePlans + " 条" : "") +
        (upgradeM1 ? "\n学生档案将在全新副本中升级到 Schema v" + restoreVersion + "，原备份不变。" : "") +
        "\n恢复只生成副本。激活须另行确认。",
      buttons: ["取消", "写入恢复副本"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return null;
    const restored = await recoveryFiles.restore(recoveryRoot,
      legacy || upgradeM1 ? prepareProtectionRestore(bytes, format, restoreVersion) : bytes);
    lastRecovery = restored.location;
    return restored;
  }));
  handle(channels.activationStatus, event => isTrusted(event, window)
    ? { ok: true, value: { active: state.active?.name ?? null, pending: Boolean(state.pending), location: profile,
      lastSuccessfulBackupAt: readBackupStatus(profile) } } : denied());
  handle<WorkspaceInfo, []>(channels.workspaceInfo, event => isTrusted(event, window)
    ? { ok: true, value: { mode: production?.root === productionInstallRoot ? "production" : "synthetic",
      backupFormat: database && workLog && growthProfile && intakeStore && (format === 1 || operations) ? format : null,
      ...(m1Version>=16?{capacity:readBackupCapacity(completeStores(format).map(store=>store.protectionConnection()))}:{}) } }
    : denied());
  handle(channels.activateRecovery, event => protect(event, async () => {
    await requireSwitchReady(event);
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
    const targetVersion = production ? restoredStudentVersion(isRecovery ? recoveryRoot : owner, name) : m1Version;
    const checked = isRecovery ? await recoveryFiles.inspect(recoveryRoot, name, format, targetVersion) : undefined;
    const target = checked ? { name, digest: checked.digest } : approvedSelection(owner, name);
    if (checked ? state.active?.digest === target.digest : state.active?.name === name) {
      throw new WorkspaceFault("conflict", "这份资料已经是当前活动档案。");
    }
    if (isResume) verifyActiveProfile(owner, target, false, format, targetVersion);
    await requireSwitchReady(event);
    const result = await dialog.showMessageBox(window, {
      type: "warning", title: "切换工作档案", message: "确认后工作台将正常关闭，下次启动时打开所选档案。",
      detail: (checked ? "备份时间 " + checked.summary.createdAt + " · 学生 " + checked.summary.students + " 名" :
        "继续使用所选档案中已保存的记录") + "\n档案：" + selected +
        "\n当前档案保留在原目录。",
      buttons: ["取消", "确认切换并退出"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    await requireSwitchReady(event, true);
    queueProfileSwitch({ kind: isRecovery ? "restore" : "resume", ...target });
    return true;
  }));
  handle(channels.returnOriginalProfile, event => protect(event, async () => {
    if (!state.active) throw new WorkspaceFault("conflict", "当前没有可返回的原始档案切换。");
    await requireSwitchReady(event);
    const result = await dialog.showMessageBox(window, {
      type: "warning", title: "返回原始档案", message: "确认后工作台将正常关闭，下次启动时返回原始档案。",
      detail: "恢复档案和其中保存的记录会保留。之后可通过「选择恢复档案」重新打开。",
      buttons: ["取消", "确认返回并退出"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    await requireSwitchReady(event, true);
    queueProfileSwitch({ kind: "original" });
    return true;
  }));
  window.on("close", event => { if (gate.busy) event.preventDefault(); });

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

async function startSelected(owner: string, original: string, format: ProtectionFormat, originalVersion: M1Version, production?: ProductionPaths) {
  let m1Version = originalVersion;
  let state = readActivation(owner, Boolean(production));
  let profile = original;
  let opened: ReturnType<typeof openProfile>;
  try {
    if (state.pending?.kind === "opening" || state.pending?.kind === "resuming") throw new Error("Interrupted recovery activation.");
    if (state.pending?.kind === "restore") {
      const pending = state.pending;
      const files = protectionFiles();
      if (production) m1Version = restoredStudentVersion(owner, pending.name);
      saveActivation(owner, { ...state, pending: { ...pending, kind: "opening" } }, Boolean(production));
      const checked = await files.inspect(format === 2 ? owner : profileRoot, pending.name, format, m1Version);
      if (checked.digest !== pending.digest) throw new Error("Selected recovery copy changed.");
      const next = await files.restore(owner, checked.bytes, true);
      const active = { name: next.profileName, digest: pending.digest };
      const staged = await files.inspect(owner, active.name, format, m1Version, "activation");
      if (staged.digest !== pending.digest) throw new Error("Activation image does not match the selected backup.");
      profile = verifyActiveProfile(owner, active, true, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      approveActiveProfile(profile, active.digest);
      const committed: ActivationState = { ...state, active, pending: null };
      saveActivation(owner, committed, Boolean(production));
      state = committed;
    } else if (state.pending?.kind === "resume") {
      const { name, digest } = state.pending;
      if (production) m1Version = restoredStudentVersion(owner, name);
      saveActivation(owner, { ...state, pending: { kind: "resuming", name, digest } }, Boolean(production));
      const active = { name, digest };
      profile = verifyActiveProfile(owner, active, false, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      const committed: ActivationState = { ...state, active, pending: null };
      saveActivation(owner, committed, Boolean(production));
      state = committed;
    } else if (state.pending?.kind === "original") {
      if (production) requireProductionProfile(production.root);
      else checkOriginalProtectionMode(original, format, false, m1Version);
      opened = openProfile(original, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
      const committed: ActivationState = { ...state, active: null, pending: null };
      saveActivation(owner, committed, Boolean(production));
      state = committed;
    } else if (state.active) {
      if (production) m1Version = restoredStudentVersion(owner, state.active.name);
      profile = verifyActiveProfile(owner, state.active, false, format, m1Version);
      opened = openProfile(profile, format, m1Version);
      verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
    } else {
      const initializeOperations = !production && checkOriginalProtectionMode(original, format, true, m1Version);
      opened = openProfile(original, format, m1Version, initializeOperations);
      if (format === 2) verifyProtectionStores(completeStores(format), app.getVersion(), format, m1Version);
    }
  } catch (error) {
    diagnostics?.record("lifecycle:startup", failure(error).code, sqliteErrorCode(error));
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
      saveActivation(owner, { ...state, active: fallback, pending: fallback ? null : { kind: "original" } }, Boolean(production));
    }
    app.quit();
    return;
  }
  await start(owner, profile, state, opened, format, m1Version, production);
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
  const productionRoot = app.isPackaged ? productionRootOf(process.execPath) : undefined;
  const syntheticM2CProfile = !productionRoot && ((process.env.M2C_SYNTHETIC_TEST === "1" && !app.isPackaged) ||
    (process.env.M2C_SYNTHETIC_PACKAGED === "1" && app.isPackaged));
  const syntheticM2BProfile = process.env.M2B_SYNTHETIC_TEST === "1" && !app.isPackaged;
  const requestedM2CProfile = process.env.M2C_SYNTHETIC_PROFILE ?? "supervisor-workspace-m2c-test";
  if (syntheticM2CProfile && (!/^[A-Za-z0-9-]{1,64}$/.test(requestedM2CProfile) ||
      requestedM2CProfile.toLowerCase() === "supervisor-workspace-mvp")) throw new Error("合成 Profile 名称无效。");
  const profileName = syntheticM2CProfile ? requestedM2CProfile
    : syntheticM2BProfile ? "supervisor-workspace-m2b-test" : "supervisor-workspace-development";
  if (app.isPackaged && !productionRoot && !syntheticM2CProfile) {
    throw new WorkspaceFault("recovery", "请从已验证的版本化安装目录启动，并先完成正式档案激活。");
  }
  if (productionRoot) {
    requireLocalDirectory(dirname(process.execPath));
    plainFile(process.execPath);
    const helper = join(process.resourcesPath, "recovery-io.exe");
    plainFile(helper);
  }
  const installed = productionRoot ? requireProductionProfile(productionRoot) : undefined;
  const production = productionRoot && installed ? { root: productionRoot, exports: installed.exports, logs: installed.logs } : undefined;
  const m1Version: M1Version = production ? 6 : (syntheticM2CProfile ? studentServicesVersion(profileName) : undefined) ??
    (syntheticM2CProfile && isParentFollowUpProfile(profileName) ? 3
      : syntheticM2CProfile && isStudentEditProfile(profileName) ? 2 : 1);
  const format: ProtectionFormat = m1Version >= 2 || (syntheticM2CProfile && /^sw-r2a-[a-z0-9-]+$/.test(profileName)) ? 2 : 1;
  const profile = installed?.profile ?? prepareProfile(profileName, format);
  const owner = installed?.owner ?? dirname(profile);
  const userData = join(profile, "chromium");
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  app.setPath("crashDumps", production ? join(production.logs, "Crash") : join(profile, "crash"));
  app.setAppLogsPath(production?.logs ?? join(profile, "logs"));
  diagnostics = new Diagnostics(app.getPath("logs"), app.getVersion());
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
        diagnostics?.record("lifecycle:close", failure(error).code, sqliteErrorCode(error));
      }
      if (commitSwitchOnExit) {
        try {
          if (errors.length > 0) throw new Error("Database close failed.");
          commitSwitchOnExit();
        } catch (error) {
          diagnostics?.record("lifecycle:switch", failure(error).code, sqliteErrorCode(error));
          dialog.showErrorBox(title, "无法安排档案切换。请保留当前档案和恢复资料，重新打开后核对。");
        }
      }
    });
    app.whenReady().then(() => startSelected(owner, profile, format, m1Version, production)).catch(error => {
      diagnostics?.record("lifecycle:startup", failure(error).code, sqliteErrorCode(error));
      dialog.showErrorBox(title, error instanceof WorkspaceFault ? error.message : "桌面窗口启动失败。请保留档案并检查安装。");
      app.quit();
    });
  }
} catch (error) {
  dialog.showErrorBox(title, error instanceof WorkspaceFault ? error.message :
    "无法打开独立应用数据目录。请检查 Windows 本地应用数据目录及其权限。");
  app.quit();
}
