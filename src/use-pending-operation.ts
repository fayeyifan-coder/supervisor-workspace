import { useRef, useState } from "react";
import type { AttendancePlan, LearningBlock, LearningChange, Result, ScheduleSaveInput, WorkspaceApi } from "./contracts";

export type OperationCommand = (ScheduleSaveInput & { command: "saveAttendancePlan" }) | LearningChange;
type Changed = AttendancePlan | LearningBlock;
const key = "supervisor-operations.pending.v1";
const commands = new Set(["saveAttendancePlan", "recordAttendance", "saveLearningBlock", "saveLearningTasks",
  "recordLearningOutcome", "recordTaskOutcome"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function load(): { command?: OperationCommand; issue?: string } {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return {};
    const request = JSON.parse(value);
    if (request && commands.has(request.command) && [request.requestId, request.id, request.studentId]
      .every(id => typeof id === "string" && uuid.test(id)) && Number.isSafeInteger(request.expectedRevision) &&
      request.expectedRevision >= 0) return { command: request };
  } catch { /* An unreadable request must never be replaced by a new one. */ }
  return { issue: "无法读取待核对请求。请保留当前档案并重开核对。" };
}

export function usePendingOperation(api: WorkspaceApi, onConfirmed: (request: OperationCommand) => void) {
  const [initial] = useState(load);
  const [pending, setPending] = useState(initial.command);
  const held = useRef(pending);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [message, setMessage] = useState("");

  function clear(): boolean {
    try { localStorage.removeItem(key); }
    catch {
      setMessage("无法清除本地待核对记录。请重开后按原编号核对。");
      return false;
    }
    held.current = undefined;
    setPending(undefined);
    return true;
  }

  function dispatch(command: OperationCommand): Promise<Result<Changed>> {
    if (command.command === "saveAttendancePlan") return api.saveSchedulePlan(command);
    return api.applyLearningChange(command);
  }

  async function run(command: OperationCommand): Promise<Result<Changed>> {
    if (active.current || held.current || initial.issue) {
      return { ok: false, code: "busy", message: initial.issue ?? "请先核对待确认的教务请求。" };
    }
    try { localStorage.setItem(key, JSON.stringify(command)); }
    catch { return { ok: false, code: "failed", message: "无法暂存本次请求，保存未执行。" }; }
    held.current = command;
    active.current = true;
    setBusy(true);
    setPending(command);
    setMessage("");
    try {
      const result = await dispatch(command);
      if (result.ok || result.code !== "unknown") clear();
      else setMessage(result.message);
      return result;
    } catch {
      const message = "未收到保存回执。请核对原请求编号或安全重试。";
      setMessage(message);
      return { ok: false, code: "unknown", message };
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function recover(retry: boolean) {
    const request = held.current;
    if (!request || active.current || initial.issue) return;
    active.current = true;
    setBusy(true);
    setMessage("正在核对原请求…");
    try {
      const { command, requestId, id, studentId, expectedRevision } = request;
      const receipt = await api.scheduleReceipt({ command, requestId, id, studentId, expectedRevision });
      if (!receipt.ok) { setMessage(receipt.message); return; }
      if (receipt.value) {
        if (clear()) setMessage("原请求已保存，正在重新读取记录。");
        onConfirmed(request);
        return;
      }
      if (!retry) { setMessage("当前档案尚无该请求的已提交回执。可用原请求安全重试。"); return; }

      const result = await dispatch(request);
      if (result.ok) {
        if (clear()) setMessage("原请求已保存，正在重新读取记录。");
        onConfirmed(request);
      } else if (result.code === "conflict" || result.code === "invalid") {
        if (clear()) setMessage("原请求未保存。" + result.message);
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage("本次核对未完成，原请求仍可重试。");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return { pending, busy, message: initial.issue ?? message, blocked: Boolean(pending || initial.issue || busy), run, recover };
}
