import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "../src/runtime.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["revocation-before-poll", "backend-unavailable"])(
  "fails closed at the next model step: %s",
  async (scenario) => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "review-admission-"));
    const credentials = join(dir, "credentials.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        host_token: "h".repeat(48),
        admin_token: "a".repeat(48),
      }),
    );
    let hook: any;
    const ctx: any = {
      on: (event: string, fn: any) => {
        if (event === "agent/pre-step") hook = fn;
      },
      effect: (fn: any) => {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      systemPrompt: { section: vi.fn(), context: vi.fn() },
      llm: {
        resolveModelInfo: async () => ({
          provider: "p",
          id: "m",
          name: "m",
          context: { contextWindow: 128000 },
          defaultMaxTokens: 4096,
        }),
      },
    };
    const runtime = new MemoryRuntime(
      ctx,
      "review",
      "http://127.0.0.1:18765",
      credentials,
    );
    vi.spyOn(runtime, "replay").mockResolvedValue(undefined);
    let safe = true;
    let offline = false;
    vi.spyOn(runtime.client, "call").mockImplementation(
      async (_channel, req: any) => {
        if (offline) throw new Error("core unreachable");
        if (req.operation === "context.check")
          return { safe, policy_revision: safe ? 1 : 2 };
        if (req.operation === "context.prepare")
          return {
            text: "PROTECTED_STATIC_TEXT",
            recall_text: "",
            policy_revision: 1,
            task: null,
            safe: true,
            context_chars: 16000,
          };
        if (req.operation === "events.poll") return { cursor: 0, events: [] };
        return {};
      },
    );
    runtime.install();
    const agent: any = { id: "s", session: { id: "s" }, options: {} };
    const payload = {
      agent,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    };
    await hook(payload, async () => ({
      kind: "enter",
      messages: [
        {
          source: { kind: "user" },
          content: [{ type: "text", text: "begin" }],
        },
      ],
    }));
    runtime["activeSessions"].add("s");
    if (scenario === "revocation-before-poll") safe = false;
    else {
      offline = true;
      await vi.advanceTimersByTimeAsync(2000);
    }
    await expect(
      hook(payload, async () => ({ kind: "enter", messages: [] })),
    ).rejects.toThrow();
  },
);
