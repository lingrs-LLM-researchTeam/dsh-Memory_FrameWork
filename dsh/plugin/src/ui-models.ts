import { z } from "zod";

export const WeightSchema = z.object({
  task: z.number(),
  relevance: z.number(),
  evidence: z.number(),
  importance: z.number(),
  dependency: z.number(),
  recency: z.number(),
  redundancy: z.number(),
  half_life_days: z.number(),
  limit: z.number(),
  context_chars: z.number(),
  min_relevance: z.number(),
});
export type Weights = z.infer<typeof WeightSchema>;
export const MemorySchema = z.object({
  id: z.number(),
  content: z.string(),
  kind: z.string(),
  session_id: z.string(),
  workspace_id: z.string(),
  task_id: z.string().nullable(),
  importance: z.number(),
  pinned: z.number(),
  scope: z.string(),
  targets: z.string(),
  broadcast: z.number(),
  vector_enabled: z.number(),
  status: z.string(),
  revision: z.number(),
  source_ids: z.array(z.string()),
  evidence_current: z.boolean(),
  evidence_quality: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Memory = z.infer<typeof MemorySchema>;
export const TaskSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  revision: z.number(),
  title: z.string(),
  goal: z.string(),
  constraints: z.array(z.string()),
  acceptance: z.array(z.string()),
  status: z.string(),
  blockers: z.array(z.string()),
  decisions: z.array(z.string()),
  next_action: z.string(),
  evidence_ids: z.array(z.string()),
  verification: z.record(
    z.string(),
    z.object({
      source_id: z.string(),
      revision: z.number(),
      method: z.string(),
    }),
  ),
});
export type Task = z.infer<typeof TaskSchema>;
export const PolicySchema = z.object({
  context_mode: z.enum(["follow_dsh", "manual"]),
  context_share: z.number(),
  evidence_bytes: z.number(),
  automatic_bytes: z.number(),
  max_tool_calls: z.number(),
  max_writes: z.number(),
  source_chars: z.number(),
  tool_memory_mode: z.enum(["evidence_only", "allowlist", "all"]),
  tool_allowlist: z.array(z.string()),
  tool_max_chars: z.number(),
  tool_include_errors: z.boolean(),
  embedding_enabled: z.boolean(),
  indexing_paused: z.boolean(),
  embedding_daily_chars: z.number(),
});
export type Policy = z.infer<typeof PolicySchema>;
export const SnapshotSchema = z.object({
  onboarding: z.object({ context_advice_ack: z.boolean() }),
  contexts: z.array(
    z.object({
      session_id: z.string(),
      mode: z.enum(["follow_dsh", "manual", "unavailable"]),
      context_window: z.number().nullable(),
      reserved_output_tokens: z.number().nullable(),
      automatic_bytes: z.number(),
      evidence_bytes: z.number(),
      context_chars: z.number(),
      observed_at: z.number().nullable(),
      host: z.object({ provider: z.string(), model: z.string() }).nullable(),
    }),
  ),
  policies: z.array(
    z.object({
      workspace_id: z.string(),
      revision: z.number(),
      settings: PolicySchema,
    }),
  ),
  usage: z.array(
    z.object({
      session_id: z.string(),
      turn_sequence: z.number(),
      used_bytes: z.number(),
      tool_calls: z.number(),
      writes: z.number(),
    }),
  ),
  embedding_usage: z.array(
    z.object({
      workspace_id: z.string(),
      day: z.string(),
      calls: z.number(),
      input_chars: z.number(),
    }),
  ),
  source_candidates: z.array(
    z.object({
      id: z.string(),
      session_id: z.string(),
      workspace_id: z.string(),
      role: z.string(),
      content: z.string(),
      content_chars: z.number(),
      status: z.string(),
    }),
  ),
  index_pending: z.number(),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      instance_id: z.string(),
    }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      workspace_id: z.string(),
      task_id: z.string().nullable(),
      subscribed: z.number(),
      cursor: z.number(),
    }),
  ),
  memories: z.array(MemorySchema),
  tasks: z.array(TaskSchema),
  profiles: z.array(
    z.object({
      workspace_id: z.string(),
      revision: z.number(),
      weights: WeightSchema,
    }),
  ),
  cursor: z.number(),
  policy_revision: z.number(),
  embedding_enabled: z.boolean(),
  memory_count: z.number(),
  pending_inputs: z.array(
    z.object({
      session_id: z.string(),
      message_id: z.string(),
      message: z.object({ content: z.array(z.unknown()) }),
    }),
  ),
  fenced_sessions: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SearchSchema = z.object({
  results: z.array(
    MemorySchema.extend({
      final_score: z.number(),
      contributions: z.record(z.string(), z.number()),
      redundancy_penalty: z.number(),
    }),
  ),
  profile_revision: z.number(),
});
export type Search = z.infer<typeof SearchSchema>;
export const weightLabels = {
  task: "当前任务关联",
  relevance: "查询相关性",
  evidence: "证据质量",
  importance: "用户重要性",
  dependency: "未完成依赖",
  recency: "时间新鲜度",
};
export type WeightKey = keyof typeof weightLabels;
export function rebalance(
  weights: Weights,
  key: WeightKey,
  value: number,
): Weights {
  const keys = Object.keys(weightLabels) as WeightKey[];
  const other = keys.filter((k) => k !== key);
  const total = other.reduce((sum, k) => sum + weights[k], 0);
  const result = { ...weights, [key]: value };
  for (const k of other)
    result[k] =
      total > 0
        ? (weights[k] / total) * (1 - value)
        : (1 - value) / other.length;
  return result;
}
export const statusLabels: Record<string, string> = {
  active: "进行中",
  planned: "待开始",
  waiting: "等待中",
  blocked: "受阻",
  verifying: "待验收",
  completed: "已完成",
  cancelled: "已取消",
  archived: "已归档",
  deleted: "已删除",
  quarantined: "证据失效",
};
export const scopeLabels: Record<string, string> = {
  session: "当前会话",
  task: "同一任务",
  workspace: "同一工作区",
  selected: "指定工作区",
  global: "个人全局",
};
