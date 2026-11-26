import { useEffect, useState } from "react";
import type { ProtectionResult, WorkspaceApi } from "./contracts";

const reminderInterval = 3 * 24 * 60 * 60 * 1000;

export function DataProtectionPanel({ api, backupFormat }: { api: WorkspaceApi; backupFormat?: 1 | 2 | null }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<ProtectionResult>();
  const [active, setActive] = useState<string | null>();
  const [pending, setPending] = useState(false);
  const [location, setLocation] = useState("");
  const [lastBackup, setLastBackup] = useState<string | null>();
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void api.activationStatus().then(response => {
      if (!response.ok) { setFailure(response.message); return; }
      setActive(response.value.active);
      setPending(response.value.pending);
      setLocation(response.value.location);
      setLastBackup(response.value.lastSuccessfulBackupAt);
    }).catch(() => setFailure("无法读取当前活动档案。"));
  }, [api]);

  async function schedule(action: "activateRecovery" | "returnOriginalProfile") {
    setBusy(true);
    setFailure("");
    try {
      const response = await api[action]();
      if (!response.ok) setFailure(response.message);
    } catch {
      setFailure("无法确认档案切换请求。请核对后再操作。");
    } finally { setBusy(false); }
  }

  async function run(kind: "export" | "restore") {
    setBusy(true);
    setFailure("");
    setResult(undefined);
    try {
      const response = kind === "export" ? await api.exportProtection() : await api.restoreProtection();
      if (!response.ok) setFailure(response.message);
      else if (response.value) {
        setResult(response.value);
        if (kind === "export") {
          const status = await api.activationStatus().catch(() => undefined);
          if (status?.ok) setLastBackup(status.value.lastSuccessfulBackupAt);
        }
      }
    } catch {
      setFailure("无法确认操作结果。请保留可能留下的文件。");
    } finally { setBusy(false); }
  }

  return <section className="panel worklog" aria-labelledby="protection-title">
    <h2 id="protection-title">离线数据保护</h2>
    <p className="muted">{backupFormat === 2 ? "SWBACK2 覆盖学生档案及其业务记录、工作日志、成长档案、JSON 导入和教务五库。" :
      backupFormat === 1 ? "SWBACK1 覆盖学生档案、工作日志、成长档案及 JSON 导入四库。" : "当前档案的完整备份能力尚未确认。"}
      恢复会创建独立档案。保存草稿并核对待确认请求后方可切换。最终确认后工作台将正常关闭，重开进入目标档案。</p>
    <p>最近一次已校验的本地备份：{lastBackup
      ? new Date(lastBackup).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
      : lastBackup === null ? "暂无记录" : "正在读取…"}</p>
    {(lastBackup === null || (lastBackup && clock - Date.parse(lastBackup) > reminderInterval)) &&
      <p className="muted" role="note">{lastBackup ? "已超过 3 天未备份，建议导出完整备份。" : "建议先导出一次完整备份。"}</p>}
    <p className="muted">历史备份时间仅表示该次导出和校验成功。请确认文件仍可用。独立介质备份需在本地导出后另行复制并核对 SHA-256。</p>
    {active !== undefined && <p>当前档案：{active ? "已激活的恢复档案" : "原始档案"}<br />{location}</p>}
    <div className="retry-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => void run("export")}>导出完整备份</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run("restore")}>验证并独立恢复</button>
      <button type="button" className="secondary" disabled={busy || pending || active === undefined} onClick={() => void schedule("activateRecovery")}>选择恢复档案</button>
      {active && <button type="button" className="secondary" disabled={busy || pending} onClick={() => void schedule("returnOriginalProfile")}>返回原始档案</button>}
    </div>
    {busy && <p className="worklog-notice" role="status">正在处理离线数据，请等待结果。</p>}
    {pending && <p className="worklog-notice" role="status">已确认切换，工作台正在正常关闭。请关闭后重新打开。</p>}
    {failure && <p className="notice failure" role="alert">{failure}</p>}
    {result && <div className="notice success" role="status">
      <p>{result.profileName ? "独立恢复副本已写入并核对。" : result.formatVersion === 2 ? "五库备份已写入并核对。" : "四库备份已写入并核对。"}</p>
      <p>{result.location}</p>
      <p>学生 {result.students} 名 · 工作事项 {result.workItems} 条 · 成长档案 {result.growthProfiles} 份 · 导入绑定 {result.intakeBindings} 个 · 待处理导入 {result.unfinishedImports} 笔</p>
      {result.formatVersion === 2 && <p>到校安排 {result.attendancePlans} 条 · 学习块 {result.learningBlocks} 个 · 学习任务 {result.learningTasks} 项</p>}
      {result.upgradedFromFour && <p>已从历史四库备份生成独立副本，教务库为空。</p>}
      {result.profileName && <p>请保留副本及备份包。需要使用副本时，选择其中的 restore.ready 并确认激活。</p>}
    </div>}
  </section>;
}
