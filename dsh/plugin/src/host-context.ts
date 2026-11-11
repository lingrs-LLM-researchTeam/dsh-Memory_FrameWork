import type { LlmRuntime } from "@deepseek-ai/dsh-llm";

export const contextAdvice =
  "建议在 DSH 模型设置中将上下文窗口设为 384k–500k Token，插件将自动跟随当前窗口模型容量分配记忆预算。";

/** Uses the step's captured route, never another window's default or a catalog guess. */
export async function readHostContext(
  llm: Pick<LlmRuntime, "resolveModelInfo">,
  selection: { provider: string; model: string },
  maxTokens?: number,
  signal?: AbortSignal,
) {
  const info = await llm.resolveModelInfo(
    selection.provider,
    selection.model,
    signal,
  );
  signal?.throwIfAborted();
  return {
    provider: selection.provider,
    model: selection.model,
    context_window: info.context?.contextWindow ?? null,
    max_output_tokens: maxTokens ?? info.defaultMaxTokens ?? null,
  };
}
