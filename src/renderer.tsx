import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { DatabaseDetails, Result, SampleRecord, WorkspaceApi } from "./contracts";
import "./styles.css";

declare global {
  interface Window {
    supervisorWorkspace: WorkspaceApi;
  }
}

type Ready = DatabaseDetails & { record: SampleRecord | null };
type View =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; data: Ready };

const format = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" });

function App() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    window.supervisorWorkspace.read().then((result) => {
      if (result.ok) {
        setContent(result.value.record?.content ?? "");
        setView({ state: "ready", data: result.value });
      } else {
        setView({ state: "failed", message: result.message });
      }
    }).catch(() => setView({ state: "failed", message: "无法连接本地数据服务。请关闭后重开。" }));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view.state !== "ready" || saving) return;
    setSaving(true);
    setSaveError("");
    setMessage("");
    let result: Result<SampleRecord>;
    try {
      result = await window.supervisorWorkspace.save({
        content,
        expectedRevision: view.data.record?.revision ?? null,
      });
    } catch {
      result = { ok: false, message: "无法连接本地数据服务，输入仍保留在窗口中。" };
    }
    setSaving(false);
    if (result.ok) {
      setContent(result.value.content);
      setView({ state: "ready", data: { ...view.data, record: result.value } });
      setMessage("已保存到本机。");
    } else {
      setSaveError(result.message);
    }
  }

  const record = view.state === "ready" ? view.data.record : null;

  return (
    <main className="shell" data-ui>
      <header className="masthead">
        <p className="product">督学工作台</p>
        <span className="scope">Windows 桌面验证</span>
      </header>
      <section className="content" aria-labelledby="record-title">
        <div className="heading">
          <h1 id="record-title">本地测试记录</h1>
          <p>填写一条虚构记录，保存后重开此窗口即可核对。</p>
        </div>
        {view.state === "loading" && <p role="status">正在打开本地数据库…</p>}
        {view.state === "failed" && <p className="error" role="alert">{view.message}</p>}
        {view.state === "ready" && (
          <form onSubmit={save}>
            <label htmlFor="test-content">测试内容</label>
            <textarea id="test-content" value={content} readOnly={saving} rows={3}
              maxLength={400} required onChange={event => {
                setContent(event.target.value);
                setMessage("");
              }} />
            <div className="actions">
              <button type="submit" disabled={saving || !content.trim() || content.trim() === record?.content}>
                {saving ? "正在保存…" : "保存记录"}
              </button>
              <span role="status">{message || (record ? `已保存 · 第 ${record.revision} 版` : "尚无保存记录")}</span>
            </div>
            {saveError && <p className="error" role="alert">{saveError}</p>}
          </form>
        )}
      </section>
      {view.state === "ready" && (
        <section className="storage" aria-labelledby="storage-title">
          <h2 id="storage-title">本机存储</h2>
          <dl>
            <div><dt>数据库</dt><dd><code>{view.data.databasePath}</code></dd></div>
            <div><dt>版本</dt><dd>结构 v{view.data.schemaVersion} / SQLite {view.data.sqliteVersion}</dd></div>
            {record && <div><dt>最后保存</dt><dd>{format.format(record.updatedAt)}</dd></div>}
          </dl>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
