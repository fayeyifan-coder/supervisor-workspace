import { contextBridge, ipcRenderer } from "electron";
import type { LessonInput, StudentInput, WorkspaceApi } from "./contracts";

// The sandboxed preload only imports Electron at runtime.
const api: WorkspaceApi = {
  students: () => ipcRenderer.invoke("mvp:students"),
  history: (id: string) => ipcRenderer.invoke("mvp:history", id),
  createStudent: (input: StudentInput) => ipcRenderer.invoke("mvp:create-student", input),
  addLesson: (input: LessonInput) => ipcRenderer.invoke("mvp:add-lesson", input),
};
contextBridge.exposeInMainWorld("supervisorWorkspace", Object.freeze(api));
