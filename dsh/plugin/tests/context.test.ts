import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostContext } from "../src/host-context.js";
import { startVisiblePolling } from "../src/visible-polling.js";
import { ensureCoreDaemon } from "../src/core-supervisor.js";

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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
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
