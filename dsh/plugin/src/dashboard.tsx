import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Call, JsonValue } from "./contracts.js";
import {
  SnapshotSchema,
  SearchSchema,
  WeightSchema,
  weightLabels,
  scopeLabels,
  statusLabels,
  rebalance,
  type Memory,
  type Task,
  type Snapshot,
  type Weights,
  type Search,
  type WeightKey,
} from "./ui-models.js";
import { styles } from "./styles.js";
import { PolicyPanel } from "./policy-panel.js";
import { contextAdvice } from "./host-context.js";
import { startVisiblePolling } from "./visible-polling.js";
import { MotionMark, useMotionPreference } from "./motion-mark.js";

type View =
  | "memories"
  | "tasks"
  | "broadcast"
  | "weights"
  | "activity"
  | "policies";
const views: [View, string, string][] = [
  ["memories", "记忆库", "整理可追溯的事实与决策"],
  ["tasks", "任务与工作区", "让目标与进度跨窗口持续"],
  ["broadcast", "广播范围", "决定谁能读取，谁接收更新"],
  ["weights", "权重实验室", "观察每次调校如何影响召回"],
  ["activity", "运行记录", "查看同步状态与待接续输入"],
  ["policies", "预算与收录", "控制每轮证据、工具记忆与向量费用"],
];
const lines = (value: string) =>
  value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const pct = (n: number) => Math.round(n * 100);

export function Dashboard({
  call,
  initialSessionId = "",
  onHandoff,
}: {
  call: Call;
  initialSessionId?: string;
  onHandoff?: (id: string) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [view, setView] = useState<View>("memories");
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [editing, setEditing] = useState<Memory | "new">();
  const [editingTask, setEditingTask] = useState<Task | "new">();
  const [detail, setDetail] = useState<unknown>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const motion = useMotionPreference();
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("mf-theme") === "paper" ? "paper" : "ink";
    } catch {
      return "ink";
    }
  });
  const alive = useRef(true);
  const refreshSequence = useRef(0);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++refreshSequence.current;
      const data = SnapshotSchema.parse(
        await call("snapshot", {}, undefined, signal),
      );
      if (
        alive.current &&
        !signal?.aborted &&
        sequence === refreshSequence.current
      )
        setSnapshot(data);
    },
    [call],
  );
  useEffect(() => {
    setSessionId(initialSessionId);
  }, [initialSessionId]);
  useEffect(() => {
    alive.current = true;
    const stop = startVisiblePolling(refresh, (e) => setError(String(e)));
    return () => {
      alive.current = false;
      stop();
    };
  }, [refresh]);
  useEffect(() => {
    setPage(0);
  }, [query, statusFilter, workspaceId]);
  useEffect(() => {
    if (!snapshot) return;
    if (!workspaceId && !sessionId && snapshot.sessions[0])
      setSessionId(snapshot.sessions[0].id);
    if (!workspaceId && snapshot.workspaces[0])
      setWorkspaceId(
        snapshot.sessions.find((s) => s.id === (sessionId || initialSessionId))
          ?.workspace_id || snapshot.workspaces[0].id,
      );
  }, [snapshot, sessionId, workspaceId, initialSessionId]);
  const perform = async (
    operation: string,
    payload: Record<string, JsonValue>,
    sid = sessionId,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await call(operation, payload, sid || undefined);
      await refresh();
      setNotice("已保存");
      return result;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const run = (
    operation: string,
    payload: Record<string, JsonValue>,
    sid = sessionId,
  ) => {
    void perform(operation, payload, sid).catch(() => undefined);
  };
  const workspaceName = (id: string) =>
    snapshot?.workspaces.find((w) => w.id === id)?.name || id;
  const session = snapshot?.sessions.find((s) => s.id === sessionId);
  const profile = snapshot?.profiles.find(
    (p) => p.workspace_id === workspaceId,
  );
  const shownMemories =
    snapshot?.memories.filter(
      (m) =>
        (!workspaceId || m.workspace_id === workspaceId) &&
        (statusFilter === "all" || m.status === statusFilter) &&
        (!query ||
          m.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    ) || [];
  const tasks =
    snapshot?.tasks.filter(
      (t) => !workspaceId || t.workspace_id === workspaceId,
    ) || [];
  const pageCount = Math.max(1, Math.ceil(shownMemories.length / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const context = snapshot?.contexts.find((c) => c.session_id === sessionId);
  const handoff = async () => {
    try {
      const result = z
        .object({ sessionId: z.string(), coreSessionId: z.string() })
        .parse(await perform("session.handoff", { session_id: sessionId }));
      setSessionId(result.coreSessionId);
      setNotice("已建立干净接续会话并关联当前任务。");
      await onHandoff?.(result.sessionId);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div
      className="mf-app"
      data-theme={theme}
      data-motion={motion.enabled ? "on" : "off"}
    >
      <style>{styles}</style>
      <div className="mf-layout">
        <aside className="mf-sidebar">
          <div className="mf-brand">
            <span className="mf-logo" aria-hidden="true" />
            <span>
              Memory
              <br />
              Framework
            </span>
          </div>
          <div className="mf-subtitle">THE CONTINUITY JOURNAL</div>
          <nav className="mf-nav" aria-label="管理导航">
            {views.map(([id, label], i) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                aria-current={view === id ? "page" : undefined}
                onClick={() => {
                  setView(id);
                  setNotice("");
                }}
              >
                <small>0{i + 1}</small>
                {label}
              </button>
            ))}
          </nav>
          <div className="mf-actions mf-theme-toggle">
            <button
              className="mf-btn ghost"
              onClick={() => {
                const next = theme === "ink" ? "paper" : "ink";
                setTheme(next);
                try {
                  localStorage.setItem("mf-theme", next);
                } catch {
                  /* storage is optional */
                }
              }}
            >
              {theme === "ink" ? "切换纸白" : "切换夜墨"}
            </button>
            <button
              className="mf-btn ghost"
              type="button"
              aria-label="启用轻动效"
              aria-pressed={motion.enabled}
              disabled={motion.reduced}
              title={motion.reduced ? "遵循系统的减少动态效果设置" : undefined}
              onClick={() => motion.change(!motion.enabled)}
            >
              {motion.reduced
                ? "系统减少动效"
                : motion.enabled
                  ? "轻动效：开"
                  : "轻动效：关"}
            </button>
          </div>
        </aside>
        <main className="mf-main">
          <header className="mf-top">
            <div>
              <div className="mf-eyebrow">
                MEMORY FRAMEWORK /{" "}
                {String(views.findIndex((v) => v[0] === view) + 1).padStart(
                  2,
                  "0",
                )}
              </div>
              <h1>{views.find((v) => v[0] === view)?.[1]}</h1>
              <div className="mf-muted">
                {views.find((v) => v[0] === view)?.[2]}
              </div>
            </div>
            <div className="mf-header-tools">
              <MotionMark enabled={motion.enabled} />
              <div className="mf-flex">
                <span className="mf-tag dim">
                  <span className="mf-pulse" aria-hidden="true" />
                  {snapshot ? "已连接" : "正在连接"}
                </span>
                <button
                  className="mf-btn ghost"
                  disabled={busy}
                  onClick={() =>
                    void refresh().catch((e) => setError(String(e)))
                  }
                >
                  刷新
                </button>
              </div>
            </div>
          </header>
          {error && (
            <div role="alert" className="mf-notice error">
              {error}
              <button className="mf-btn ghost" onClick={() => setError("")}>
                关闭
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="mf-notice">
              {notice}
            </div>
          )}
          {!snapshot ? (
            <div className="mf-empty">正在读取记忆与任务状态…</div>
          ) : (
            <>
              {!snapshot.onboarding.context_advice_ack && (
                <section
                  className="mf-onboarding"
                  aria-label="首次运行上下文建议"
                >
                  <div className="mf-eyebrow">FIRST EDITION / 长程任务设置</div>
                  <h2>给长期任务，留出足够的上下文。</h2>
                  <div className="mf-advice-number">
                    384k–500k <span>Token</span>
                  </div>
                  <p>{contextAdvice}</p>
                  <div className="mf-actions">
                    <button
                      className="mf-btn primary"
                      onClick={() => setView("policies")}
                    >
                      查看上下文联动
                    </button>
                    <button
                      className="mf-btn ghost"
                      disabled={busy}
                      onClick={() => run("onboarding.ack", {})}
                    >
                      已了解，不再提醒
                    </button>
                  </div>
                </section>
              )}
              <div className="mf-toolbar">
                <label className="mf-flex">
                  工作区{" "}
                  <select
                    aria-label="工作区筛选"
                    value={workspaceId}
                    onChange={(e) => {
                      setWorkspaceId(e.target.value);
                      const s = snapshot.sessions.find(
                        (s) => s.workspace_id === e.target.value,
                      );
                      setSessionId(s?.id || "");
                    }}
                  >
                    {snapshot.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mf-flex">
                  当前会话{" "}
                  <select
                    aria-label="当前会话"
                    value={sessionId}
                    onChange={(e) => {
                      setSessionId(e.target.value);
                      const s = snapshot.sessions.find(
                        (s) => s.id === e.target.value,
                      );
                      if (s) setWorkspaceId(s.workspace_id);
                    }}
                  >
                    {snapshot.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {workspaceName(s.workspace_id)} · {s.id.slice(-16)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mf-context-strip" role="status">
                <span>
                  CONTEXT /{" "}
                  {context?.mode === "manual" ? "手动记忆配额" : "跟随 DSH"}
                </span>
                <strong>
                  {context?.context_window
                    ? `${context.context_window.toLocaleString()} Token`
                    : "等待 DSH 报告容量"}
                </strong>
                <span>
                  自动记忆配额{" "}
                  {context?.automatic_bytes.toLocaleString() ?? "—"} B
                </span>
              </div>
              {snapshot.fenced_sessions.includes(sessionId) && (
                <div className="mf-notice warning">
                  这个会话历史包含已撤销、修订或超出当前范围的记忆，需要干净接续。
                  {onHandoff ? (
                    <button
                      className="mf-btn"
                      disabled={busy}
                      onClick={() => void handoff()}
                    >
                      创建干净接续会话
                    </button>
                  ) : (
                    "请在 DSH 内的 Memory Dashboard 创建干净接续会话。"
                  )}
                </div>
              )}
              <div className="mf-stats">
                <div className="mf-stat">
                  <span>有效记忆</span>
                  <strong>
                    {
                      snapshot.memories.filter(
                        (m) =>
                          m.workspace_id === workspaceId &&
                          m.status === "active",
                      ).length
                    }
                  </strong>
                </div>
                <div className="mf-stat">
                  <span>进行中的任务</span>
                  <strong>
                    {
                      tasks.filter(
                        (t) => !["completed", "cancelled"].includes(t.status),
                      ).length
                    }
                  </strong>
                </div>
                <div className="mf-stat">
                  <span>关联会话</span>
                  <strong>
                    {
                      snapshot.sessions.filter(
                        (s) => s.workspace_id === workspaceId,
                      ).length
                    }
                  </strong>
                </div>
                <div className="mf-stat">
                  <span>权重配置</span>
                  <strong>v{profile?.revision || 1}</strong>
                </div>
              </div>
              {view === "memories" && (
                <>
                  <div className="mf-toolbar">
                    <input
                      className="mf-search"
                      aria-label="筛选记忆内容"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="筛选事实、约束或决策…"
                    />
                    <select
                      aria-label="记忆状态"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="active">有效记忆</option>
                      <option value="archived">已归档</option>
                      <option value="deleted">已删除</option>
                      <option value="quarantined">证据失效</option>
                      <option value="all">全部状态</option>
                    </select>
                    <button
                      className="mf-btn primary"
                      disabled={!sessionId}
                      onClick={() => setEditing("new")}
                    >
                      ＋ 新建记忆
                    </button>
                  </div>
                  <div className="mf-grid">
                    {shownMemories
                      .slice(currentPage * 24, (currentPage + 1) * 24)
                      .map((m) => (
                        <article className="mf-card" key={m.id}>
                          <div className="mf-card-head">
                            <span className="mf-tag">
                              {scopeLabels[m.scope]}
                            </span>
                            <span className="mf-muted">
                              #{m.id} · v{m.revision}
                            </span>
                          </div>
                          <div className="mf-content">{m.content}</div>
                          <div className="mf-range-line">
                            <span className="mf-muted">
                              重要性 {m.pinned ? "· 已固定" : ""}
                            </span>
                            <span>{pct(m.importance)}%</span>
                          </div>
                          <div className="mf-bar">
                            <span style={{ width: pct(m.importance) + "%" }} />
                          </div>
                          <div className="mf-meta">
                            <span>{m.source_ids.length} 条来源</span>
                            <span>
                              {m.evidence_current ? "来源有效" : "来源待核对"}
                            </span>
                            <span>
                              {m.status === "active"
                                ? "有效"
                                : statusLabels[m.status]}
                            </span>
                            <span>{m.broadcast ? "广播开启" : "广播关闭"}</span>
                          </div>
                          <div className="mf-actions">
                            <button
                              className="mf-btn"
                              onClick={() => setEditing(m)}
                            >
                              编辑与范围
                            </button>
                            <button
                              className="mf-btn ghost"
                              onClick={() =>
                                void call(
                                  "memory.read",
                                  { id: m.id },
                                  sessionId,
                                )
                                  .then(setDetail)
                                  .catch((e) => setError(String(e)))
                              }
                            >
                              查看证据
                            </button>
                            <button
                              className="mf-btn ghost"
                              disabled={busy || !m.evidence_current}
                              onClick={() =>
                                run("memory.update", {
                                  id: m.id,
                                  expected_revision: m.revision,
                                  status:
                                    m.status === "active"
                                      ? "archived"
                                      : "active",
                                })
                              }
                            >
                              {m.status === "active" ? "归档" : "恢复"}
                            </button>
                          </div>
                        </article>
                      ))}
                  </div>
                  {pageCount > 1 && (
                    <nav className="mf-pagination" aria-label="记忆分页">
                      <button
                        className="mf-btn"
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        上一页
                      </button>
                      <span>
                        {currentPage + 1} / {pageCount} 页 ·{" "}
                        {shownMemories.length} 条
                      </span>
                      <button
                        className="mf-btn"
                        disabled={currentPage + 1 === pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        下一页
                      </button>
                    </nav>
                  )}
                  {!shownMemories.length && (
                    <div className="mf-empty">
                      暂无匹配记忆。开始对话后会自动采集原文，也可以手动添加。
                    </div>
                  )}
                </>
              )}
              {view === "tasks" && (
                <>
                  <div className="mf-panel">
                    <div className="mf-toolbar" style={{ marginBottom: 0 }}>
                      <label className="mf-flex">
                        会话绑定任务{" "}
                        <select
                          aria-label="会话绑定任务"
                          value={session?.task_id || ""}
                          disabled={busy}
                          onChange={(e) =>
                            run("session.bind", {
                              session_id: sessionId,
                              task_id: e.target.value || null,
                              expected_task_id: session?.task_id || null,
                            })
                          }
                        >
                          <option value="">未绑定</option>
                          {snapshot.tasks
                            .filter(
                              (t) => t.workspace_id === session?.workspace_id,
                            )
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        className="mf-btn primary"
                        disabled={!workspaceId}
                        onClick={() => setEditingTask("new")}
                      >
                        ＋ 创建任务
                      </button>
                    </div>
                  </div>
                  {tasks.map((t) => (
                    <article className="mf-panel" key={t.id}>
                      <div className="mf-card-head">
                        <h2>{t.title}</h2>
                        <span
                          className={
                            "mf-tag " + (t.status === "completed" ? "" : "dim")
                          }
                        >
                          {statusLabels[t.status]} · v{t.revision}
                        </span>
                      </div>
                      <div className="mf-content">{t.goal}</div>
                      <div className="mf-grid">
                        <div>
                          <h3>必须保留的约束</h3>
                          {t.constraints.map((c, i) => (
                            <p className="mf-muted" key={i}>
                              • {c}
                            </p>
                          ))}
                          <h3>下一步</h3>
                          <p>{t.next_action || "尚未指定下一动作"}</p>
                          {t.blockers.length > 0 && (
                            <div className="mf-notice warning">
                              阻塞：{t.blockers.join("；")}
                            </div>
                          )}
                        </div>
                        <div>
                          <h3>验收条件</h3>
                          {t.acceptance.map((c) => (
                            <div className="mf-source" key={c}>
                              <p>
                                {t.verification[c] ? "✓ " : "○ "}
                                {c}
                              </p>
                              {!t.verification[c] && (
                                <Acceptance
                                  criterion={c}
                                  disabled={busy || session?.task_id !== t.id}
                                  accept={(note) =>
                                    perform("task.verify", {
                                      id: t.id,
                                      expected_revision: t.revision,
                                      criterion: c,
                                      note,
                                    })
                                  }
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="mf-actions">
                        <button
                          className="mf-btn"
                          onClick={() => setEditingTask(t)}
                        >
                          编辑任务
                        </button>
                        <button
                          className="mf-btn ghost"
                          onClick={() =>
                            void call("task.history", { id: t.id }, sessionId)
                              .then(setDetail)
                              .catch((e) => setError(String(e)))
                          }
                        >
                          历史与检查点
                        </button>
                        <button
                          className="mf-btn"
                          disabled={busy}
                          onClick={() =>
                            run("task.checkpoint", {
                              id: t.id,
                              expected_revision: t.revision,
                            })
                          }
                        >
                          保存检查点
                        </button>
                        <button
                          className="mf-btn primary"
                          disabled={
                            busy ||
                            !t.acceptance.length ||
                            !t.acceptance.every((c) => t.verification[c]) ||
                            t.status === "completed"
                          }
                          onClick={() =>
                            run("task.update", {
                              id: t.id,
                              expected_revision: t.revision,
                              status: "completed",
                            })
                          }
                        >
                          标记完成
                        </button>
                      </div>
                      <div
                        className="mf-toolbar"
                        style={{ marginTop: 16, marginBottom: 0 }}
                      >
                        <label>
                          迁移工作区{" "}
                          <select
                            aria-label={"迁移任务 " + t.title}
                            value={t.workspace_id}
                            disabled={busy}
                            onChange={(e) =>
                              run("task.move", {
                                id: t.id,
                                expected_revision: t.revision,
                                workspace_id: e.target.value,
                              })
                            }
                          >
                            {snapshot.workspaces.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </article>
                  ))}
                  {!tasks.length && (
                    <div className="mf-empty">
                      为长程工作建立第一个任务，记录目标、约束和验收条件。
                    </div>
                  )}
                </>
              )}
              {view === "broadcast" && (
                <>
                  <div className="mf-panel">
                    <h2>会话订阅</h2>
                    <div className="mf-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>会话</th>
                            <th>工作区</th>
                            <th>任务</th>
                            <th>接收更新</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.sessions.map((s) => (
                            <tr key={s.id}>
                              <td>
                                <code>{s.id}</code>
                              </td>
                              <td>{workspaceName(s.workspace_id)}</td>
                              <td>
                                {snapshot.tasks.find((t) => t.id === s.task_id)
                                  ?.title || "未绑定"}
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={"订阅 " + s.id}
                                  checked={!!s.subscribed}
                                  disabled={busy}
                                  onChange={(e) =>
                                    run("session.subscription", {
                                      session_id: s.id,
                                      enabled: e.target.checked,
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="mf-panel">
                    <h2>记忆读取范围与广播</h2>
                    <div className="mf-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>记忆</th>
                            <th>读取范围</th>
                            <th>可达会话</th>
                            <th>广播</th>
                            <th>管理</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.memories
                            .filter(
                              (m) =>
                                m.workspace_id === workspaceId &&
                                m.status === "active",
                            )
                            .map((m) => (
                              <tr key={m.id}>
                                <td>
                                  #{m.id} {m.content.slice(0, 70)}
                                </td>
                                <td>{scopeLabels[m.scope]}</td>
                                <td>
                                  {snapshot.sessions
                                    .filter((s) => canRead(m, s))
                                    .map((s) => (
                                      <div key={s.id}>
                                        <code>{s.id.slice(-18)}</code>
                                      </div>
                                    ))}
                                </td>
                                <td>
                                  <input
                                    type="checkbox"
                                    aria-label={"广播记忆 " + m.id}
                                    checked={!!m.broadcast}
                                    disabled={busy}
                                    onChange={(e) =>
                                      run("memory.update", {
                                        id: m.id,
                                        expected_revision: m.revision,
                                        broadcast: e.target.checked,
                                      })
                                    }
                                  />
                                </td>
                                <td>
                                  <button
                                    className="mf-btn"
                                    onClick={() => setEditing(m)}
                                  >
                                    调整范围
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
              {view === "policies" && (
                <PolicyPanel
                  snapshot={snapshot}
                  workspaceId={workspaceId}
                  sessionId={sessionId}
                  perform={perform}
                  busy={busy}
                />
              )}
              {view === "weights" && profile && (
                <WeightEditor
                  key={workspaceId}
                  profile={profile}
                  sessionId={sessionId}
                  call={call}
                  save={(weights, expectedRevision) =>
                    perform("profile.save", {
                      workspace_id: workspaceId,
                      expected_revision: expectedRevision,
                      weights,
                    })
                  }
                  onError={setError}
                />
              )}
              {view === "activity" && (
                <>
                  <div className="mf-panel">
                    <h2>同步状态</h2>
                    <p>
                      事件游标 <code>{snapshot.cursor}</code> · 读取策略 v
                      {snapshot.policy_revision} ·{" "}
                      {snapshot.embedding_enabled
                        ? "词法与向量检索已配置"
                        : "词法检索运行中，向量模型未配置"}
                    </p>
                    <div className="mf-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>会话</th>
                            <th>宿主日志游标</th>
                            <th>上下文状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.sessions.map((s) => (
                            <tr key={s.id}>
                              <td>
                                <code>{s.id}</code>
                              </td>
                              <td>{s.cursor}</td>
                              <td>
                                {snapshot.fenced_sessions.includes(s.id)
                                  ? "需要干净接续"
                                  : "可继续"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="mf-panel">
                    <h2>尚未送达模型的输入</h2>
                    {snapshot.pending_inputs.map((p) => (
                      <div
                        className="mf-source"
                        key={p.session_id + p.message_id}
                      >
                        <code>{p.session_id}</code>
                        <pre>
                          {p.message.content
                            .map((b) => {
                              const text = z
                                .object({ text: z.string() })
                                .safeParse(b);
                              return text.success
                                ? text.data.text
                                : "[附件或非文本内容]";
                            })
                            .join("\n")}
                        </pre>
                      </div>
                    ))}
                    {!snapshot.pending_inputs.length && (
                      <p className="mf-muted">没有待处理输入。</p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
      {editing && snapshot && (
        <MemoryEditor
          key={editing === "new" ? "new" : editing.id}
          memory={editing}
          snapshot={snapshot}
          currentSessionId={sessionId}
          busy={busy}
          close={() => setEditing(undefined)}
          save={async (payload) => {
            await perform(
              editing === "new" ? "memory.create" : "memory.update",
              payload,
            );
            setEditing(undefined);
          }}
          remove={async () => {
            if (editing !== "new") {
              await perform("memory.update", {
                id: editing.id,
                expected_revision: editing.revision,
                status: "deleted",
              });
              setEditing(undefined);
            }
          }}
        />
      )}
      {editingTask && (
        <TaskEditor
          task={editingTask}
          busy={busy}
          close={() => setEditingTask(undefined)}
          save={async (payload) => {
            await perform(
              editingTask === "new" ? "task.create" : "task.update",
              {
                ...(editingTask === "new" ? { workspace_id: workspaceId } : {}),
                ...payload,
              },
            );
            setEditingTask(undefined);
          }}
        />
      )}
      {detail !== undefined && (
        <Modal title="来源与历史" close={() => setDetail(undefined)}>
          <EvidenceDetail
            value={detail}
            revoke={(id, revision) =>
              perform("source.revoke", {
                id,
                expected_revision: revision,
              }).then(() => setDetail(undefined))
            }
          />
        </Modal>
      )}
    </div>
  );
}

function canRead(m: Memory, s: Snapshot["sessions"][number]) {
  if (m.scope === "session") return m.session_id === s.id;
  if (m.scope === "task")
    return (
      !!m.task_id &&
      m.task_id === s.task_id &&
      m.workspace_id === s.workspace_id
    );
  if (m.scope === "workspace") return m.workspace_id === s.workspace_id;
  if (m.scope === "selected")
    return z
      .array(z.string())
      .parse(JSON.parse(m.targets))
      .includes(s.workspace_id);
  return m.scope === "global";
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="mf-modal-shade"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "Tab") {
          const elements = panel.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),textarea,select,[tabindex="0"]',
          );
          if (!elements?.length) return;
          if (
            e.shiftKey &&
            (document.activeElement === elements[0] ||
              document.activeElement === panel.current)
          ) {
            e.preventDefault();
            elements[elements.length - 1].focus();
          } else if (
            !e.shiftKey &&
            document.activeElement === elements[elements.length - 1]
          ) {
            e.preventDefault();
            elements[0].focus();
          }
        }
      }}
    >
      <div
        className="mf-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <div className="mf-modal-top">
          <h2>{title}</h2>
          <button
            className="mf-btn ghost"
            aria-label="关闭对话框"
            onClick={close}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MemoryEditor({
  memory,
  snapshot,
  currentSessionId,
  busy,
  close,
  save,
  remove,
}: {
  memory: Memory | "new";
  snapshot: Snapshot;
  currentSessionId: string;
  busy: boolean;
  close: () => void;
  save: (p: Record<string, JsonValue>) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const existing = memory !== "new" ? memory : undefined;
  const [content, setContent] = useState(existing?.content || "");
  const [importance, setImportance] = useState(existing?.importance ?? 0.5);
  const [scope, setScope] = useState(existing?.scope || "session");
  const [targets, setTargets] = useState<string[]>(
    existing ? z.array(z.string()).parse(JSON.parse(existing.targets)) : [],
  );
  const [pinned, setPinned] = useState(!!existing?.pinned);
  const [vectorEnabled, setVectorEnabled] = useState(
    existing ? !!existing.vector_enabled : true,
  );
  const [broadcast, setBroadcast] = useState(
    existing ? !!existing.broadcast : true,
  );
  const [localError, setLocalError] = useState("");
  const session = snapshot.sessions.find(
    (s) => s.id === (existing?.session_id || currentSessionId),
  );
  return (
    <Modal
      title={existing ? "编辑记忆 #" + existing.id : "新建记忆"}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setLocalError("");
          void save({
            ...(existing
              ? { id: existing.id, expected_revision: existing.revision }
              : {}),
            content,
            importance,
            scope,
            targets,
            pinned,
            broadcast,
            vector_enabled: vectorEnabled,
          }).catch((e) => setLocalError(String(e)));
        }}
      >
        {localError && (
          <div className="mf-notice error" role="alert">
            {localError}
          </div>
        )}
        <label className="mf-label">
          <strong>记忆内容</strong>
          <textarea
            aria-label="记忆内容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            maxLength={12000}
            rows={6}
          />
        </label>
        <label className="mf-label">
          <span className="mf-range-line">
            <strong>单条记忆重要性</strong>
            <output>{pct(importance)}%</output>
          </span>
          <input
            aria-label="单条记忆重要性"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
          />
        </label>
        <label className="mf-label">
          <strong>读取范围</strong>
          <select
            aria-label="读取范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            {Object.entries(scopeLabels).map(([id, label]) => (
              <option
                key={id}
                value={id}
                disabled={
                  id === "task" && !(existing?.task_id || session?.task_id)
                }
              >
                {label}
              </option>
            ))}
          </select>
        </label>
        {scope === "selected" && (
          <div className="mf-scope-grid">
            {snapshot.workspaces.map((w) => (
              <label key={w.id}>
                <input
                  type="checkbox"
                  checked={targets.includes(w.id)}
                  onChange={(e) =>
                    setTargets(
                      e.target.checked
                        ? [...targets, w.id]
                        : targets.filter((id) => id !== w.id),
                    )
                  }
                />
                {w.name}
              </label>
            ))}
          </div>
        )}
        <div className="mf-checks">
          <label>
            <input
              aria-label="参与语义检索"
              type="checkbox"
              checked={vectorEnabled}
              onChange={(e) => setVectorEnabled(e.target.checked)}
            />
            参与语义检索与向量化
          </label>
          <label>
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />
            固定到上下文
          </label>
          <label>
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
            />
            向有权读取的订阅会话广播
          </label>
        </div>
        <div className="mf-actions">
          <button
            className="mf-btn primary"
            disabled={
              busy ||
              !content.trim() ||
              (scope === "selected" && !targets.length)
            }
            type="submit"
          >
            保存记忆
          </button>
          <button className="mf-btn ghost" type="button" onClick={close}>
            取消
          </button>
          {existing && (
            <button
              className="mf-btn danger"
              type="button"
              disabled={busy}
              onClick={() =>
                void remove().catch((e) => setLocalError(String(e)))
              }
            >
              移入已删除
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function TaskEditor({
  task,
  busy,
  close,
  save,
}: {
  task: Task | "new";
  busy: boolean;
  close: () => void;
  save: (p: Record<string, JsonValue>) => Promise<void>;
}) {
  const old = task !== "new" ? task : undefined;
  const [title, setTitle] = useState(old?.title || "");
  const [goal, setGoal] = useState(old?.goal || "");
  const [constraints, setConstraints] = useState(
    old?.constraints.join("\n") || "",
  );
  const [acceptance, setAcceptance] = useState(
    old?.acceptance.join("\n") || "",
  );
  const [next, setNext] = useState(old?.next_action || "");
  const [blockers, setBlockers] = useState(old?.blockers.join("\n") || "");
  const [status, setStatus] = useState(old?.status || "planned");
  const [error, setError] = useState("");
  return (
    <Modal title={old ? "编辑任务" : "创建长程任务"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            ...(old
              ? {
                  id: old.id,
                  expected_revision: old.revision,
                  next_action: next,
                  blockers: lines(blockers),
                  status,
                }
              : {}),
            title,
            goal,
            constraints: lines(constraints),
            acceptance: lines(acceptance),
          }).catch((e) => setError(String(e)));
        }}
      >
        {error && <div className="mf-notice error">{error}</div>}
        <label className="mf-label">
          <strong>任务名称</strong>
          <input
            aria-label="任务名称"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        <label className="mf-label">
          <strong>目标</strong>
          <textarea
            aria-label="任务目标"
            required
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
          />
        </label>
        <div className="mf-form-grid">
          <label className="mf-label">
            <strong>硬约束 · 每行一项</strong>
            <textarea
              aria-label="任务约束"
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
            />
          </label>
          <label className="mf-label">
            <strong>验收条件 · 每行一项</strong>
            <textarea
              aria-label="验收条件"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
            />
          </label>
        </div>
        {old && (
          <>
            <label className="mf-label">
              <strong>下一步</strong>
              <input
                aria-label="下一步"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <label className="mf-label">
              <strong>阻塞项 · 每行一项</strong>
              <textarea
                value={blockers}
                onChange={(e) => setBlockers(e.target.value)}
                aria-label="阻塞项"
              />
            </label>
            <label className="mf-label">
              <strong>任务状态</strong>
              <select
                aria-label="任务状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {[
                  "planned",
                  "active",
                  "waiting",
                  "blocked",
                  "verifying",
                  "completed",
                  "cancelled",
                ].map((s) => (
                  <option value={s} key={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <button className="mf-btn primary" disabled={busy} type="submit">
          保存任务
        </button>
      </form>
    </Modal>
  );
}

function Acceptance({
  criterion,
  disabled,
  accept,
}: {
  criterion: string;
  disabled: boolean;
  accept: (note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  return (
    <div>
      <input
        aria-label={"验收依据 " + criterion}
        placeholder="填写检查结果或验收依据"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="mf-btn"
        disabled={disabled || !note.trim()}
        onClick={() => void accept(note).catch((e) => setError(String(e)))}
      >
        验收此项
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function EvidenceDetail({
  value,
  revoke,
}: {
  value: unknown;
  revoke: (id: string, revision: number) => Promise<void>;
}) {
  const sources = z
    .object({
      sources: z.array(
        z.object({
          id: z.string(),
          revision: z.number(),
          role: z.string(),
          status: z.string(),
          content: z.string(),
        }),
      ),
    })
    .safeParse(value);
  const [error, setError] = useState("");
  return (
    <>
      {error && (
        <div role="alert" className="mf-notice error">
          {error}
        </div>
      )}
      {sources.success &&
        sources.data.sources.map((s) => (
          <div className="mf-source" key={s.id}>
            <code>
              {s.id} · r{s.revision}
            </code>
            <p>
              {s.role} · {s.status}
            </p>
            <pre>{s.content}</pre>
            <button
              className="mf-btn danger"
              disabled={s.status !== "active"}
              onClick={() =>
                void revoke(s.id, s.revision).catch((e) => setError(String(e)))
              }
            >
              撤销此来源及派生记忆
            </button>
          </div>
        ))}
      <details>
        <summary>完整记录与历史</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </>
  );
}

function WeightEditor({
  profile,
  sessionId,
  call,
  save,
  onError,
}: {
  profile: Snapshot["profiles"][number];
  sessionId: string;
  call: Call;
  save: (weights: Weights, expectedRevision: number) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(profile.weights);
  const [draftRevision, setDraftRevision] = useState(profile.revision);
  const [query, setQuery] = useState("");
  const [before, setBefore] = useState<Search>();
  const [after, setAfter] = useState<Search>();
  const [history, setHistory] = useState<
    { revision: number; weights: Weights }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setDraft(profile.weights);
      setDraftRevision(profile.revision);
    }
  }, [profile.revision, dirty, profile.weights]);
  const change = (weights: Weights) => {
    if (!dirty) setDraftRevision(profile.revision);
    setDraft(weights);
    setDirty(true);
  };
  const preview = async () => {
    setBusy(true);
    try {
      const [oldResult, newResult] = await Promise.all([
        call("ranking.preview", { query, weights: profile.weights }, sessionId),
        call("ranking.preview", { query, weights: draft }, sessionId),
      ]);
      setBefore(SearchSchema.parse(oldResult));
      setAfter(SearchSchema.parse(newResult));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mf-panel">
        <div className="mf-card-head">
          <h2>长程任务排序配置</h2>
          <span className="mf-tag">六项权重合计 100%</span>
        </div>
        <div className="mf-weight-grid">
          {(Object.keys(weightLabels) as WeightKey[]).map((k) => (
            <label className="mf-label" key={k}>
              <span className="mf-range-line">
                <strong>{weightLabels[k]}</strong>
                <output>{(draft[k] * 100).toFixed(1)}%</output>
              </span>
              <input
                type="range"
                aria-label={weightLabels[k]}
                min="0"
                max="1"
                step="0.01"
                value={draft[k]}
                onChange={(e) =>
                  change(rebalance(draft, k, Number(e.target.value)))
                }
              />
            </label>
          ))}
        </div>
        <div className="mf-form-grid">
          {(
            [
              ["half_life_days", "背景记忆半衰期（天）", 1, 36500],
              ["limit", "召回条数", 1, 40],
              ["context_chars", "手动／容量未知时的字符上限", 2000, 64000],
            ] as const
          ).map(([k, label, min, max]) => (
            <label className="mf-label" key={k}>
              <strong>{label}</strong>
              <input
                type="number"
                aria-label={label}
                value={draft[k]}
                min={min}
                max={max}
                onChange={(e) =>
                  change({ ...draft, [k]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <label className="mf-label">
            <strong>重复信息惩罚 {pct(draft.redundancy)}%</strong>
            <input
              aria-label="重复信息惩罚"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={draft.redundancy}
              onChange={(e) =>
                change({ ...draft, redundancy: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <div className="mf-actions">
          <button
            className="mf-btn primary"
            disabled={busy || !dirty}
            onClick={() => {
              setBusy(true);
              void save(draft, draftRevision)
                .then(() => setDirty(false))
                .catch((e) => onError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            保存权重配置
          </button>
          <button
            className="mf-btn ghost"
            onClick={() => {
              setDraft(profile.weights);
              setDirty(false);
            }}
          >
            放弃修改
          </button>
          <button
            className="mf-btn"
            onClick={() =>
              void call("profile.history", {
                workspace_id: profile.workspace_id,
              })
                .then((value) =>
                  setHistory(
                    z
                      .object({
                        history: z.array(
                          z.object({
                            revision: z.number(),
                            weights: WeightSchema,
                          }),
                        ),
                      })
                      .parse(value).history,
                  ),
                )
                .catch((e) => onError(String(e)))
            }
          >
            查看历史配置
          </button>
          {history.length > 0 && (
            <select
              aria-label="历史权重配置"
              defaultValue=""
              onChange={(e) => {
                const old = history.find(
                  (h) => h.revision === Number(e.target.value),
                );
                if (old) change(old.weights);
              }}
            >
              <option value="" disabled>
                载入历史版本作草稿
              </option>
              {history.map((h) => (
                <option key={h.revision} value={h.revision}>
                  v{h.revision}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="mf-panel">
        <h2>同一查询，比较调整前后</h2>
        <div className="mf-toolbar">
          <input
            className="mf-search"
            aria-label="回放查询"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：这项任务的数据库约束是什么？"
          />
          <button
            className="mf-btn"
            disabled={busy || !query.trim() || !sessionId}
            onClick={() => void preview()}
          >
            预览排序
          </button>
        </div>
        <div className="mf-grid">
          {(
            [
              ["当前配置", before],
              ["草稿配置", after],
            ] as const
          ).map(([label, result]) => (
            <div key={label}>
              <h3>{label}</h3>
              {result?.results.map((m, i) => (
                <div className="mf-source" key={m.id}>
                  <span className="mf-tag dim">
                    #{i + 1} · 记忆 {m.id} · {m.final_score.toFixed(3)}
                  </span>
                  <p>{m.content.slice(0, 180)}</p>
                  <div className="mf-meta">
                    {Object.entries(m.contributions).map(([k, v]) => (
                      <span key={k}>
                        {weightLabels[k as WeightKey] || k} {v.toFixed(3)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {result && !result.results.length && (
                <p className="mf-muted">授权范围内没有匹配证据。</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
