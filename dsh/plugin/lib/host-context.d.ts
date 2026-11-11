import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
export declare const contextAdvice = "\u5EFA\u8BAE\u5728 DSH \u6A21\u578B\u8BBE\u7F6E\u4E2D\u5C06\u4E0A\u4E0B\u6587\u7A97\u53E3\u8BBE\u4E3A 384k\u2013500k Token\uFF0C\u63D2\u4EF6\u5C06\u81EA\u52A8\u8DDF\u968F\u5F53\u524D\u7A97\u53E3\u6A21\u578B\u5BB9\u91CF\u5206\u914D\u8BB0\u5FC6\u9884\u7B97\u3002";
/** Uses the step's captured route, never another window's default or a catalog guess. */
export declare function readHostContext(llm: Pick<LlmRuntime, "resolveModelInfo">, selection: {
    provider: string;
    model: string;
}, maxTokens?: number, signal?: AbortSignal): Promise<{
    provider: string;
    model: string;
    context_window: number | null;
    max_output_tokens: number | null;
}>;
