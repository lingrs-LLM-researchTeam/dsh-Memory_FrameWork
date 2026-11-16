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

function nativeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "native-admission-"));
  const credentials = join(dir, "credentials.json");
  writeFileSync(
    credentials,
    JSON.stringify({ host_token: "h".repeat(48), admin_token: "a".repeat(48) }),
  );
  const hooks = new Map<string, any>();
  let provider: any;
  const workspaces: any[] = [];
  const ctx: any = {
    on: (event: string, fn: any) => hooks.set(event, fn),
    effect: (fn: any) => {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    workspaceRegistry: { list: () => workspaces },
    systemPrompt: {
      section: vi.fn(),
      context: (value: any) => {
        provider = value;
      },
    },
    sessions: { flush: vi.fn() },
    sessionPersistence: {
      open: async () => ({
        read: async () => ({ events: [] }),
        close: vi.fn(),
      }),
    },
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
    "native",
    "http://127.0.0.1:18765",
    credentials,
  );
  const call = vi
    .spyOn(runtime.client, "call")
    .mockImplementation(async (_channel, req: any) => {
      if (req.operation === "session.upsert")
        return {
          id: "native:s",
          workspace_id: "native:w",
          task_id: null,
          cursor: -1,
        };
      if (req.operation === "context.check")
        return { safe: true, policy_revision: 1 };
      if (req.operation === "context.prepare")
        return {
          text: "CONTRACT",
          policy_revision: 1,
          task: null,
          safe: true,
          context_chars: 16000,
        };
      return {};
    });
  runtime.install();
  const session: any = { id: "s", isOwnSeq: () => true };
  const agent: any = { id: "s", session, options: {} };
  const step = () =>
    hooks.get("agent/pre-step")(
      {
        agent,
        modelSelection: { provider: "p", model: "m" },
        signal: new AbortController().signal,
      },
      async () => ({ kind: "enter", messages: [] }),
    );
  return {
    runtime,
    hooks,
    call,
    session,
    agent,
    step,
    context: () => provider.text({ agent }),
    attach: () =>
      workspaces.push({ id: "w", title: "W", path: dir, sessionIds: ["s"] }),
  };
}

it("admits a new native session after pre-attachment metadata events", async () => {
  const f = nativeFixture();
  for (const type of ["permission/preset", "sandbox/mode", "approval/policy"]) {
    f.hooks.get("session/event")(f.session, { type, seq: 0, data: {} });
    await f.runtime["queues"].get("s")?.catch(() => undefined);
  }
  f.attach();
  expect(() => f.context()).not.toThrow();
  expect(f.call).not.toHaveBeenCalled();
  await expect(f.step()).resolves.toMatchObject({ kind: "enter" });
  expect(f.context()).toBe("CONTRACT");
});

it("keeps synchronization errors retryable without classifying them as denied content", async () => {
  const f = nativeFixture();
  f.attach();
  f.call.mockRejectedValueOnce(new Error("core unavailable"));
  f.hooks.get("session/event")(f.session, {
    type: "turn/start",
    seq: 1,
    data: {},
  });
  await f.runtime["queues"].get("s")?.catch(() => undefined);
  expect(() => f.context()).not.toThrow();
  await expect(f.step()).rejects.toThrow("core unavailable");
  // A subsequent event may retry; replay and authoritative admission still run.
  f.hooks.get("session/event")(f.session, {
    type: "turn/start",
    seq: 2,
    data: {},
  });
  await f.runtime["queues"].get("s");
  await expect(f.step()).resolves.toMatchObject({ kind: "enter" });
  expect(
    f.call.mock.calls.some(([, req]: any) => req.operation === "context.check"),
  ).toBe(true);
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
