import { useEffect, useRef, useState } from "react";
import type { AttendancePlan, LearningBlock, OperationCommand, PendingOperationState, Result, WorkspaceApi } from "./contracts";

type Changed = AttendancePlan | LearningBlock;

function descriptorFor(state: PendingOperationState | undefined) {
  if (state?.kind === "pending") return state.command;
  if (state?.kind === "damaged") return state.descriptor;
}

export function usePendingOperation(api: WorkspaceApi, onConfirmed: (request?: OperationCommand) => void) {
  const [state, setState] = useState<PendingOperationState>();
  const held = useRef(state);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [issue, setIssue] = useState("");

  async function hydrate() {
    try {
      const result = await api.pendingOperation();
      if (!result.ok) { setIssue(result.message); return; }
      held.current = result.value;
      setState(result.value);
      setIssue("");
    } catch { setIssue("无法读取待核对状态。请重试读取或重开工作台。"); }
  }

  useEffect(() => { void hydrate(); }, [api]);

  function dispatch(command: OperationCommand): Promise<Result<Changed>> {
    return command.command === "saveAttendancePlan" ? api.saveSchedulePlan(command) : api.applyLearningChange(command);
  }

  async function acknowledge(requestId: string, reviewed = false): Promise<boolean> {
    const result = await api.acknowledgeOperation(requestId, reviewed);
    if (!result.ok) setMessage(result.message);
    return result.ok;
  }

  async function run(command: OperationCommand): Promise<Result<Changed>> {
    if (active.current || held.current?.kind !== "empty" || issue) {
      return { ok: false, code: "busy", message: issue || "请先核对待确认的教务请求。" };
    }
    active.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await dispatch(command);
      if (result.ok || result.code === "conflict" || result.code === "invalid") {
        try { await acknowledge(command.requestId); }
        catch { setMessage("无法确认本地请求已结案，请重新读取或按原编号核对。"); }
      } else {
        setMessage(result.message);
      }
      return result;
    } catch {
      const message = "未收到保存回执。请核对原请求编号或安全重试。";
      setMessage(message);
      return { ok: false, code: "unknown", message };
    } finally {
      await hydrate();
      active.current = false;
      setBusy(false);
    }
  }

  async function recover(action: "read" | "retry" | "reviewed") {
    const snapshot = held.current;
    const descriptor = descriptorFor(snapshot);
    const command = snapshot?.kind === "pending" ? snapshot.command : undefined;
    if (!descriptor || active.current || (action === "retry" && !command)) return;
    active.current = true;
    setBusy(true);
    setMessage("正在核对原请求…");
    try {
      const { command: operation, requestId, id, studentId, expectedRevision } = descriptor;
      const receipt = await api.scheduleReceipt({ command: operation, requestId, id, studentId, expectedRevision });
      if (!receipt.ok) { setMessage(receipt.message); return; }
      if (receipt.value) {
        if (await acknowledge(requestId)) {
          setMessage("原请求已保存，正在重新读取记录。");
          if (command) onConfirmed(command);
          else onConfirmed();
        }
        return;
      }
      if (action === "reviewed" && snapshot?.kind === "damaged" && await acknowledge(requestId, true)) {
        setMessage("已结束无法恢复的请求。请依据已核对的数据库记录继续操作。");
        onConfirmed();
        return;
      }
      if (action !== "retry" || !command) {
        setMessage(command ? "当前档案尚无该请求的已提交回执。可用原请求安全重试。"
          : "当前档案尚无该请求的已提交回执。请在周课表和当日学习面板核对数据库事实。");
        return;
      }
      const result = await dispatch(command);
      if (result.ok) {
        if (await acknowledge(requestId)) {
          setMessage("原请求已保存，正在重新读取记录。");
          onConfirmed(command);
        }
      } else if ((result.code === "conflict" || result.code === "invalid") && await acknowledge(requestId)) {
        setMessage("原请求未保存。" + result.message);
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage("本次核对未完成，请重新读取待核对状态。");
    } finally {
      await hydrate();
      active.current = false;
      setBusy(false);
    }
  }

  return { state, descriptor: descriptorFor(state), busy, issue, message,
    blocked: !state || state.kind !== "empty" || busy || Boolean(issue), run, recover, hydrate };
}
