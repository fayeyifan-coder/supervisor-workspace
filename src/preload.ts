import { contextBridge, ipcRenderer } from "electron";
import type { SaveSample, WorkspaceApi } from "./contracts";

// Keep literals here so this sandboxed preload needs only Electron's built-in module.
const api: WorkspaceApi = {
  read: () => ipcRenderer.invoke("sample-record:read"),
  save: (input: SaveSample) => ipcRenderer.invoke("sample-record:save", input),
};
contextBridge.exposeInMainWorld("supervisorWorkspace", Object.freeze(api));
