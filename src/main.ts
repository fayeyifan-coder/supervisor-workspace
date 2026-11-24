import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent, type Session } from "electron";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { channels, type Failure } from "./contracts";
import { SampleDatabase } from "./database";

const scheme = "supervisor-pr1a";
const page = `${scheme}://workspace/index.html`;
const securityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'";
const appId = "cn.supervisorworkspace.desktop.pr1a";
const title = "督学工作台 · 桌面验证";
const localData = process.env.LOCALAPPDATA;
let database: SampleDatabase | undefined;

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
  return { ok: false, message: "此窗口无权访问本地记录。" };
}

async function start(profile: string): Promise<void> {
  app.setAppUserModelId(appId);
  const ui = session.fromPartition("supervisor-pr1a-ui");
  restrictSession(ui);
  const path = join(profile, "data", "workspace.sqlite3");
  let startupError = "";
  try {
    database = SampleDatabase.open(path, join(profile, "database.initialized"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    startupError = `数据库初始化失败（${reason}）。请关闭应用，检查并保留原文件：${path}`;
  }

  const window = new BrowserWindow({
    title,
    width: 840,
    height: 620,
    minWidth: 540,
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

  ipcMain.handle(channels.read, (event) => {
    if (!isTrusted(event, window)) return denied();
    if (!database) return { ok: false, message: startupError };
    try {
      return { ok: true, value: { ...database.details, record: database.read() } };
    } catch {
      return { ok: false, message: "读取测试记录失败。请关闭应用并保留原数据库文件。" };
    }
  });
  ipcMain.handle(channels.save, (event, raw: unknown) => {
    if (!isTrusted(event, window)) return denied();
    if (!database) return { ok: false, message: startupError };
    try {
      return { ok: true, value: database.save(raw) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      return { ok: false, message: `保存失败（${reason}）。输入仍在当前窗口中，可检查后重试。` };
    }
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL(page);
}

try {
  if (!localData || !isAbsolute(localData)) throw new Error("无法定位 Windows 本地应用数据目录。");
  const profile = join(localData, "SupervisorWorkspace", "PR1A", "桌面验证");
  const userData = join(profile, "chromium");
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  app.commandLine.appendSwitch("disable-background-networking");

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
    app.on("will-quit", () => database?.close());
    app.whenReady().then(() => start(profile)).catch(() => {
      dialog.showErrorBox(title, "桌面窗口启动失败。请检查安装是否完整。");
      app.quit();
    });
  }
} catch {
  dialog.showErrorBox(title, "无法打开独立应用数据目录。请检查 Windows 本地应用数据目录及其权限。");
  app.quit();
}
