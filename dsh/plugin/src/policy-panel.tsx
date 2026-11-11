import { useEffect, useState } from "react";
import type { JsonValue } from "./contracts.js";
import type { Policy, Snapshot } from "./ui-models.js";
import { AnimatedSwitch } from "./animated-switch.js";

type Perform = (
  op: string,
  payload: Record<string, JsonValue>,
  sid?: string,
) => Promise<unknown>;
export function PolicyPanel({
  snapshot,
  workspaceId,
  sessionId,
  perform,
  busy,
}: {
  snapshot: Snapshot;
  workspaceId: string;
  sessionId: string;
  perform: Perform;
  busy: boolean;
}) {
  const current = snapshot.policies.find((p) => p.workspace_id === workspaceId);
  if (!current) return null;
  return (
    <Editor
      key={workspaceId}
      current={current}
      snapshot={snapshot}
      sessionId={sessionId}
      perform={perform}
      busy={busy}
    />
  );
}
function Editor({
  current,
  snapshot,
  sessionId,
  perform,
  busy,
}: {
  current: Snapshot["policies"][number];
  snapshot: Snapshot;
  sessionId: string;
  perform: Perform;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(current.settings);
  const [revision, setRevision] = useState(current.revision);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [candidateLimit, setCandidateLimit] = useState(20);
  useEffect(() => {
    if (!dirty) {
      setDraft(current.settings);
      setRevision(current.revision);
    }
  }, [current, dirty]);
  const change = <K extends keyof Policy>(key: K, value: Policy[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setDirty(true);
  };
  const usage = snapshot.usage.find((s) => s.session_id === sessionId);
  const context = snapshot.contexts.find((s) => s.session_id === sessionId);
  const today = new Date().toISOString().slice(0, 10);
  const embeddings = snapshot.embedding_usage.find(
    (s) => s.workspace_id === current.workspace_id && s.day === today,
  );
  const numbers: [keyof Policy, string, number, number][] = [
    ["evidence_bytes", "手动／未知容量时每轮证据预算（字节）", 4000, 256000],
    ["automatic_bytes", "手动／未知容量时自动记忆配额（字节）", 1000, 128000],
    ["max_tool_calls", "每轮记忆工具调用上限", 1, 50],
    ["max_writes", "每轮记忆与任务写入上限", 0, 20],
    ["source_chars", "每次原文读取字符数", 100, 12000],
    ["tool_max_chars", "自动收录工具结果长度上限", 100, 12000],
    ["embedding_daily_chars", "每日向量化输入字符预算（UTC）", 1000, 10000000],
  ];
  return (
    <>
      <section className="mf-panel">
        <h2>上下文与记忆配额</h2>
        <div className="mf-context-facts">
          <div>
            <span>DSH 最近一次准入报告</span>
            <strong>
              {context?.context_window?.toLocaleString() ?? "尚未报告"}{" "}
              {context?.context_window ? "Token" : ""}
            </strong>
            <small>
              {context?.host
                ? `${context.host.provider} / ${context.host.model}`
                : "首次对话后自动同步"}
            </small>
          </div>
          <div>
            <span>当前有效自动记忆配额</span>
            <strong>
              {context?.automatic_bytes.toLocaleString() ?? "—"} B
            </strong>
            <small>
              每轮总证据上限 {context?.evidence_bytes.toLocaleString() ?? "—"} B
            </small>
          </div>
        </div>
        {context?.mode === "unavailable" && (
          <p className="mf-notice warning">
            当前容量未知，暂用下方手动字节与字符上限。DSH
            报告模型容量后自动切换为联动。
          </p>
        )}
        <p className="mf-muted">
          当前轮已用 {usage?.used_bytes ?? 0} B · 工具调用{" "}
          {usage?.tool_calls ?? 0} 次 · 今日向量化 {embeddings?.calls ?? 0} 次（
          {embeddings?.input_chars ?? 0} 字符） · 待索引 {snapshot.index_pending}{" "}
          条
        </p>
        {!snapshot.embedding_enabled && (
          <p className="mf-notice">尚未配置向量模型；当前使用全文检索。</p>
        )}
        {revision !== current.revision && (
          <p className="mf-notice warning">
            其他窗口已修改策略。请重新加载后再保存。
          </p>
        )}
        {error && (
          <p role="alert" className="mf-notice error">
            {error}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            void perform("policy.save", {
              workspace_id: current.workspace_id,
              expected_revision: revision,
              settings: draft,
            })
              .then(() => setDirty(false))
              .catch((e) => setError(String(e)));
          }}
        >
          <div className="mf-form-grid">
            <label className="mf-label">
              上下文预算模式
              <select
                aria-label="上下文预算模式"
                value={draft.context_mode}
                onChange={(e) =>
                  change(
                    "context_mode",
                    e.target.value as Policy["context_mode"],
                  )
                }
              >
                <option value="follow_dsh">跟随 DSH 对话窗口（推荐）</option>
                <option value="manual">手动限制记忆注入</option>
              </select>
            </label>
            <label className="mf-label">
              记忆预算占比（%）
              <input
                aria-label="记忆预算占比（%）"
                type="number"
                min={1}
                max={20}
                required
                disabled={draft.context_mode !== "follow_dsh"}
                value={draft.context_share}
                onChange={(e) =>
                  change("context_share", Number(e.target.value))
                }
              />
            </label>
          </div>
          <div className="mf-scope-grid">
            {numbers.map(([key, label, min, max]) => (
              <label className="mf-label" key={key}>
                {label}
                <input
                  aria-label={label}
                  type="number"
                  min={min}
                  max={max}
                  required
                  value={Number(draft[key])}
                  onChange={(e) => change(key, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
          <label className="mf-label">
            工具输出自动收录
            <select
              aria-label="工具输出自动收录"
              value={draft.tool_memory_mode}
              onChange={(e) =>
                change(
                  "tool_memory_mode",
                  e.target.value as Policy["tool_memory_mode"],
                )
              }
            >
              <option value="evidence_only">仅保留原始证据，手动收录</option>
              <option value="allowlist">只自动收录指定工具</option>
              <option value="all">自动收录符合长度限制的工具</option>
            </select>
          </label>
          <label className="mf-label">
            允许自动收录的工具名称（每行一个）
            <textarea
              aria-label="工具名称白名单"
              rows={3}
              value={draft.tool_allowlist.join("\n")}
              onChange={(e) =>
                change(
                  "tool_allowlist",
                  e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <fieldset className="mf-switch-group">
            <legend>工作区开关</legend>
            <AnimatedSwitch
              label="收录工具错误输出"
              checked={draft.tool_include_errors}
              disabled={busy}
              onChange={(value) => change("tool_include_errors", value)}
            />
            <AnimatedSwitch
              label="启用本工作区语义检索与向量化"
              checked={draft.embedding_enabled}
              disabled={busy}
              onChange={(value) => change("embedding_enabled", value)}
            />
            <AnimatedSwitch
              label="暂停后台向量构建"
              checked={draft.indexing_paused}
              disabled={busy}
              onText="已暂停"
              offText="未暂停"
              onChange={(value) => change("indexing_paused", value)}
            />
          </fieldset>
          <div className="mf-actions">
            <button
              type="button"
              className="mf-btn"
              onClick={() => {
                setDraft(current.settings);
                setRevision(current.revision);
                setDirty(false);
                setError("");
              }}
            >
              重新加载策略
            </button>
            <button
              className="mf-btn primary"
              disabled={busy || !dirty || revision !== current.revision}
            >
              保存策略
            </button>
          </div>
        </form>
      </section>
      <section className="mf-panel">
        <h2>待收录工具证据</h2>
        {snapshot.source_candidates
          .filter((s) => s.workspace_id === current.workspace_id)
          .slice(0, candidateLimit)
          .map((s) => (
            <article className="mf-panel" key={s.id}>
              <code>
                {s.id.slice(0, 16)} · {s.content_chars} 字符
              </code>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {s.content}
              </p>
              <button
                className="mf-btn"
                disabled={busy}
                onClick={() =>
                  void perform(
                    "source.promote",
                    { id: s.id, vector_enabled: false },
                    s.session_id,
                  ).catch((e) => setError(String(e)))
                }
              >
                收录为记忆
              </button>
            </article>
          ))}
        {snapshot.source_candidates.filter(
          (s) => s.workspace_id === current.workspace_id,
        ).length > candidateLimit && (
          <button
            className="mf-btn"
            onClick={() => setCandidateLimit((n) => n + 20)}
          >
            再显示 20 条证据
          </button>
        )}
      </section>
    </>
  );
}
