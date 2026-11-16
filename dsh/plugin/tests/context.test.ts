import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostContext } from "../src/host-context.js";
import { startVisiblePolling } from "../src/visible-polling.js";
import { ensureCoreDaemon } from "../src/core-supervisor.js";
import { MemoryRuntime } from "../src/runtime.js";
import { createHash } from "node:crypto";

describe("host context selection", () => {
  it("reads the captured route for each window and respects its output override", async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: model === "large" ? 500000 : 32000 },
      defaultMaxTokens: 8192,
    }));
    const large = await readHostContext(
      { resolveModelInfo },
      { provider: "p", model: "large" },
      16000,
    );
    const small = await readHostContext(
      { resolveModelInfo },
      { provider: "p", model: "small" },
    );
    expect(large.context_window).toBe(500000);
    expect(large.max_output_tokens).toBe(16000);
    expect(small.context_window).toBe(32000);
    expect(small.max_output_tokens).toBe(8192);
  });
  it("reports unknown capacity honestly and propagates cancellation", async () => {
    const resolveModelInfo = vi.fn(async () => ({
      provider: "p",
      id: "m",
      name: "m",
    }));
    expect(
      (
        await readHostContext(
          { resolveModelInfo },
          { provider: "p", model: "m" },
        )
      ).context_window,
    ).toBeNull();
    const abort = new AbortController();
    abort.abort();
    await expect(
      readHostContext(
        { resolveModelInfo },
        { provider: "p", model: "m" },
        undefined,
        abort.signal,
      ),
    ).rejects.toThrow();
  });
});

class Surface extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
afterEach(() => vi.useRealTimers());
describe("visible dashboard polling", () => {
  it("polls every ten seconds, stops in background, resumes immediately and disposes", async () => {
    vi.useFakeTimers();
    const surface = new Surface();
    const refresh = vi.fn(async () => {});
    const stop = startVisiblePolling(refresh, vi.fn(), surface);
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(4);
    surface.set("hidden");
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(4);
    surface.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).toHaveBeenCalledTimes(5);
  });
  it("cancels an in-flight hidden request without overlapping a new request", async () => {
    vi.useFakeTimers();
    const surface = new Surface();
    const refresh = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        ),
    );
    const stop = startVisiblePolling(refresh, vi.fn(), surface);
    surface.set("hidden");
    surface.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("core supervisor auto-start", () => {
  it("reports an incompatible running core before attempting to start another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-protocol-"));
    const credentialsFile = join(dir, "credentials.json");
    writeFileSync(credentialsFile, "{}");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", version: "0.3.2" })),
      );
    try {
      await expect(
        ensureCoreDaemon({
          coreUrl: "http://127.0.0.1:18765",
          credentialsFile,
        }),
      ).rejects.toThrow("核心协议不兼容");
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("reuses an already healthy loopback core and rejects non-loopback URLs", async () => {
    await expect(
      ensureCoreDaemon({
        coreUrl: "http://example.com:18765",
        credentialsFile: "~/.memory-framework/credentials.json",
      }),
    ).rejects.toThrow("coreUrl must be a loopback HTTP origin");

    const dir = mkdtempSync(join(tmpdir(), "mf-sup-"));
    const credPath = join(dir, "credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({
        host_token: "h".repeat(48),
        admin_token: "a".repeat(48),
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", protocol_version: 2 }), {
        status: 200,
      }),
    );
    try {
      const dispose = await ensureCoreDaemon({
        coreUrl: "http://127.0.0.1:18765",
        credentialsFile: credPath,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:18765/health",
        expect.objectContaining({ method: "GET" }),
      );
      expect(typeof dispose).toBe("function");
      dispose();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("turn-level preparation, static prefix lock, and tail recall", () => {
  it("prepares once per user turn, checks continuation admission, and hashes recall on replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-rt-"));
    const credPath = join(dir, "credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({
        host_token: "h".repeat(48),
        admin_token: "a".repeat(48),
      }),
    );
    let preStepHandler: any;
    let contextProvider: any;
    const fakeCtx: any = {
      workspaceRegistry: {
        list: () => [
          { id: "w1", title: "W1", path: "/w1", sessionIds: ["s1"] },
        ],
      },
      sessions: { flush: async () => {} },
      sessionPersistence: {
        open: async () => ({
          read: async () => ({ events: [] }),
          close: async () => {},
        }),
      },
      llm: {
        resolveModelInfo: async () => ({
          provider: "deepseek",
          id: "deepseek-chat",
          name: "deepseek-chat",
          context: { contextWindow: 128000 },
          defaultMaxTokens: 8192,
        }),
      },
      systemPrompt: {
        section: () => {},
        context: (def: any) => {
          contextProvider = def;
        },
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      on: (event: string, fn: any) => {
        if (event === "agent/pre-step") preStepHandler = fn;
      },
      effect: () => {},
    };
    const runtime = new MemoryRuntime(
      fakeCtx,
      "local",
      "http://127.0.0.1:18765",
      credPath,
    );
    const callSpy = vi
      .spyOn(runtime.client, "call")
      .mockImplementation(async (_channel, req: any) => {
        if (req.operation === "workspace.upsert") return {};
        if (req.operation === "session.upsert")
          return {
            id: "local:s1",
            workspace_id: "local:w1",
            task_id: "t1",
            cursor: 0,
          };
        if (req.operation === "context.check")
          return { safe: true, policy_revision: 1 };
        if (req.operation === "context.sync") return {};
        if (req.operation === "context.prepare")
          return {
            text: "<memory-framework-context>\nLOCKED_STATIC_CONTRACT\n</memory-framework-context>",
            recall_text:
              req.payload.query === "first"
                ? "<memory-framework-recall>\n[memory:9] Incremental recall\n</memory-framework-recall>"
                : "",
            policy_revision: 1,
            task: null,
            safe: true,
            context_chars: 16000,
          };
        if (req.operation === "context.inherit") return {};
        return {};
      });

    runtime.install();
    const agent: any = {
      id: "s1",
      session: { id: "s1", isOwnSeq: () => false },
      options: { maxTokens: 4096 },
    };
    const signal = new AbortController().signal;

    // Turn 1 Step 1 (user message present): runs prepare & appends tail recall
    const turn1Messages: any[] = [
      {
        id: "m1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "first" }],
      },
    ];
    const d1 = await preStepHandler(
      {
        agent,
        modelSelection: { provider: "deepseek", model: "deepseek-chat" },
        signal,
      },
      async () => ({ kind: "enter", messages: turn1Messages }),
    );
    expect(d1.messages).toHaveLength(2);
    expect(d1.messages[1].source).toEqual({
      kind: "memory-framework",
      form: "recall",
    });
    expect(contextProvider.text({ agent })).toContain("LOCKED_STATIC_CONTRACT");

    const callsAfterStep1 = callSpy.mock.calls.filter(
      (c) => (c[1] as any).operation === "context.prepare",
    ).length;
    expect(callsAfterStep1).toBe(1);

    // Continuation checks authority without repeating retrieval or changing the prefix.
    const d2 = await preStepHandler(
      {
        agent,
        modelSelection: { provider: "deepseek", model: "deepseek-chat" },
        signal,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    expect(d2.messages).toHaveLength(0);
    expect(
      callSpy.mock.calls.filter(
        (c) => (c[1] as any).operation === "context.prepare",
      ).length,
    ).toBe(1);
    expect(contextProvider.text({ agent })).toContain("LOCKED_STATIC_CONTRACT");

    // Replay of tail recall message in forked session hashes content without [memory-receipt:N]
    await runtime.ingest(
      agent.session,
      { seq: 3, type: "compaction/end", data: {} } as any,
      signal,
    );
    expect(
      callSpy.mock.calls.filter((c) => c[1].operation === "context.refresh"),
    ).toHaveLength(1);
    await runtime.ingest(
      agent.session,
      { seq: 4, type: "compaction/end", data: { error: "cancelled" } } as any,
      signal,
    );
    expect(
      callSpy.mock.calls.filter((c) => c[1].operation === "context.refresh"),
    ).toHaveLength(1);
    await runtime.ingest(
      agent.session,
      {
        seq: 5,
        type: "user/message",
        data: d1.messages[1],
      } as any,
      signal,
    );
    const expectedHash = createHash("sha256")
      .update(
        "<memory-framework-recall>\n[memory:9] Incremental recall\n</memory-framework-recall>",
        "utf8",
      )
      .digest("hex");
    expect(callSpy).toHaveBeenCalledWith(
      "host",
      {
        operation: "context.inherit",
        session_id: "local:s1",
        payload: { content_hash: expectedHash, sequence: 5 },
      },
      signal,
    );

    // Pre-step rejection after context.prepare discards uncommitted recall exposure
    let checkCount = 0;
    callSpy.mockImplementation(async (_channel, req: any) => {
      if (req.operation === "workspace.upsert") return {};
      if (req.operation === "session.upsert")
        return {
          id: "local:s1",
          workspace_id: "local:w1",
          task_id: "t1",
          cursor: 0,
        };
      if (req.operation === "context.check") {
        checkCount += 1;
        return { safe: true, policy_revision: checkCount <= 2 ? 1 : 2 };
      }
      if (req.operation === "context.prepare")
        return {
          text: "<memory-framework-context>\nLOCKED_STATIC_CONTRACT\n</memory-framework-context>",
          recall_text:
            "<memory-framework-recall>\n[memory:10] Uncommitted recall\n</memory-framework-recall>",
          prepared_receipt_ids: [91],
          policy_revision: 1,
          task: null,
          safe: true,
          context_chars: 16000,
        };
      if (req.operation === "context.discard") return { ok: true };
      return {};
    });
    const staleHash = createHash("sha256")
      .update(
        "<memory-framework-recall>\n[memory:10] Uncommitted recall\n</memory-framework-recall>",
        "utf8",
      )
      .digest("hex");
    await expect(
      preStepHandler(
        {
          agent,
          modelSelection: { provider: "deepseek", model: "deepseek-chat" },
          signal,
        },
        async () => ({
          kind: "enter",
          messages: [
            {
              id: "m2",
              role: "user",
              source: { kind: "user" },
              content: [{ type: "text", text: "second" }],
            },
          ],
        }),
      ),
    ).rejects.toThrow("读取期间记忆范围发生变化");
    expect(callSpy).toHaveBeenCalledWith("host", {
      operation: "context.discard",
      session_id: "local:s1",
      payload: { content_hash: staleHash, receipt_ids: [91] },
    });
  });
});
