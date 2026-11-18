import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compactConfirmedJournal } from "../src/journal-compaction.js";
import { MemoryRuntime } from "../src/runtime.js";
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: vi.fn(original.writeFileSync),
    renameSync: vi.fn(original.renameSync),
    fsyncSync: vi.fn(original.fsyncSync),
  };
});
const dirs: string[] = [];
const id = (messageId: string) => ({ sessionId: "s", messageId });
const pending = (messageId: string) => ({
  ...id(messageId),
  admitted: false,
  message: {
    id: messageId,
    source: { kind: "user" },
    content: [{ type: "text", text: "synthetic " + messageId }],
  },
});
const admitted = (messageId: string) => ({ ...id(messageId), admitted: true });
const encode = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row) + "\n").join("");
function fixture(rows: unknown[]) {
  const root = fs.mkdtempSync(join(tmpdir(), "mf-compact-"));
  dirs.push(root);
  const path = join(root, "dsh-test-pending.jsonl");
  fs.writeFileSync(path, encode(rows));
  return { root, path, read: () => fs.readFileSync(path, "utf8") };
}
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset();
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.fsyncSync).mockReset();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
it("removes only confirmed history while retaining tombstones and unconfirmed input", () => {
  const f = fixture([
    pending("old"),
    admitted("old"),
    pending("a"),
    admitted("a"),
    pending("new"),
  ]);
  compactConfirmedJournal(f.path, [id("a")]);
  expect(f.read()).toBe(
    encode([pending("old"), admitted("old"), admitted("a"), pending("new")]),
  );
  compactConfirmedJournal(f.path, [id("a")]);
  expect(fs.readdirSync(f.root)).toEqual(["dsh-test-pending.jsonl"]);
});
it("rereads current disk data, preserving appends before and after compaction and a later capture", () => {
  const f = fixture([pending("a"), admitted("a")]);
  fs.appendFileSync(f.path, encode([pending("b"), pending("a")]));
  compactConfirmedJournal(f.path, [id("a")]);
  fs.appendFileSync(f.path, encode([pending("c")]));
  expect(f.read()).toBe(
    encode([admitted("a"), pending("b"), pending("a"), pending("c")]),
  );
});
it("does not use legacy admitted markers or pending-only rows as confirmation", () => {
  const rows = [pending("a"), admitted("a"), pending("b")];
  const f = fixture(rows);
  compactConfirmedJournal(f.path, [id("b")]);
  expect(f.read()).toBe(encode(rows));
  compactConfirmedJournal(f.path, []);
  expect(f.read()).toBe(encode(rows));
});
it.each(["{broken", "{broken}\n"])(
  "fails closed on damaged journal %s",
  (tail) => {
    const f = fixture([pending("a"), admitted("a")]);
    fs.appendFileSync(f.path, tail);
    const original = f.read();
    expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow();
    expect(f.read()).toBe(original);
  },
);
it.each(["write", "rename"])(
  "keeps the original when %s fails, then retries",
  (stage) => {
    const f = fixture([pending("a"), admitted("a"), pending("b")]);
    const original = f.read();
    const fn = stage === "write" ? fs.writeFileSync : fs.renameSync;
    vi.mocked(fn).mockImplementationOnce(() => {
      throw new Error("injected failure");
    });
    expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow(
      "injected failure",
    );
    expect(f.read()).toBe(original);
    compactConfirmedJournal(f.path, [id("a")]);
    expect(f.read()).toBe(encode([admitted("a"), pending("b")]));
  },
);
it.skipIf(process.platform === "win32")(
  "keeps a valid replacement when directory sync fails",
  () => {
    const f = fixture([pending("a"), admitted("a"), pending("b")]);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error("sync failed");
    });
    expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow(
      "sync failed",
    );
    expect(f.read()).toBe(encode([admitted("a"), pending("b")]));
  },
);
it("detects changes before replacement and does not touch corrupt backups", () => {
  const f = fixture([pending("a"), admitted("a")]);
  const backup = f.path + ".corrupt-existing";
  fs.writeFileSync(backup, "unfinished");
  const write = vi.mocked(fs.writeFileSync).getMockImplementation()!;
  vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
    write(...args);
    fs.appendFileSync(f.path, encode([pending("b")]));
  });
  expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow(
    "changed during compaction",
  );
  expect(f.read()).toContain('"messageId":"b"');
  expect(fs.readFileSync(backup, "utf8")).toBe("unfinished");
});
it.each(["flush", "ingest", "cursor", "success"])(
  "requires the complete durable replay path: %s",
  async (stage) => {
    const f = fixture([pending("a")]);
    const credentials = join(f.root, "credentials.json");
    fs.writeFileSync(
      credentials,
      JSON.stringify({
        host_token: "h".repeat(48),
        admin_token: "a".repeat(48),
      }),
    );
    const calls: string[] = [];
    const ctx: any = {
      logger: { warn: vi.fn() },
      sessions: {
        flush: async () => {
          calls.push("flush");
          if (stage === "flush") throw Error("stop");
          return true;
        },
      },
      sessionPersistence: {
        open: async () => ({
          read: async () => ({
            events: [
              { type: "user/message", seq: 0, data: pending("a").message },
            ],
          }),
          close: async () => {},
        }),
      },
    };
    const runtime = new MemoryRuntime(
      ctx,
      "test",
      "http://127.0.0.1:18765",
      credentials,
    );
    vi.spyOn(runtime, "ensure").mockResolvedValue({
      id: "test:s",
      workspace_id: "test:w",
      task_id: null,
      cursor: -1,
    });
    vi.spyOn(runtime.client, "call").mockImplementation(async (_, request) => {
      calls.push(request.operation);
      if (
        (stage === "ingest" && request.operation === "event.ingest") ||
        (stage === "cursor" && request.operation === "session.cursor")
      )
        throw Error("stop");
      return {};
    });
    const session: any = { id: "s", isOwnSeq: () => true };
    if (stage === "success") {
      await runtime.replay(session);
      expect(f.read()).toBe(encode([admitted("a")]));
      expect(calls).toEqual([
        "flush",
        "flush",
        "event.ingest",
        "pending.admitted",
        "session.cursor",
      ]);
    } else {
      await expect(runtime.replay(session)).rejects.toThrow("stop");
      expect(f.read()).toContain('"message":');
    }
  },
);

it.each(["reject", "false"])(
  "does not compact a newly read batch when its second flush is %s",
  async (mode) => {
    const f = fixture([pending("a")]);
    const credentials = join(f.root, "credentials.json");
    fs.writeFileSync(
      credentials,
      JSON.stringify({
        host_token: "h".repeat(48),
        admin_token: "a".repeat(48),
      }),
    );
    const flush = vi.fn().mockResolvedValueOnce(true);
    if (mode === "reject")
      flush.mockRejectedValueOnce(new Error("batch flush failed"));
    else flush.mockResolvedValueOnce(false);
    const runtime = new MemoryRuntime(
      {
        logger: { warn: vi.fn() },
        sessions: { flush },
        sessionPersistence: {
          open: async () => ({
            read: async () => ({
              events: [
                { type: "user/message", seq: 0, data: pending("a").message },
              ],
            }),
            close: async () => {},
          }),
        },
      } as any,
      "test",
      "http://127.0.0.1:18765",
      credentials,
    );
    vi.spyOn(runtime, "ensure").mockResolvedValue({
      id: "test:s",
      workspace_id: "test:w",
      task_id: null,
      cursor: -1,
    });
    const call = vi.spyOn(runtime.client, "call").mockResolvedValue({});
    await expect(
      runtime.replay({ id: "s", isOwnSeq: () => true } as any),
    ).rejects.toThrow(
      mode === "reject" ? "batch flush failed" : "successful persistence flush",
    );
    expect(call).not.toHaveBeenCalled();
    expect(f.read()).toBe(encode([pending("a")]));
  },
);

it("preserves #9 recovered tail backups through compaction and restart", () => {
  const f = fixture([pending("a"), admitted("a"), pending("b")]);
  fs.appendFileSync(f.path, '{"unfinished":');
  const credentials = join(f.root, "credentials.json");
  fs.writeFileSync(
    credentials,
    JSON.stringify({ host_token: "h".repeat(48), admin_token: "a".repeat(48) }),
  );
  const start = () =>
    new MemoryRuntime(
      { logger: { warn: vi.fn() } } as any,
      "test",
      "http://127.0.0.1:18765",
      credentials,
    );
  start();
  const backup = fs
    .readdirSync(f.root)
    .find((name) => name.includes(".corrupt-"))!;
  compactConfirmedJournal(f.path, [id("a")]);
  const restarted = start();
  expect(
    [...restarted["pending"].values()].map((row) => row.messageId),
  ).toEqual(["b"]);
  expect(fs.readFileSync(join(f.root, backup), "utf8")).toBe('{"unfinished":');
});

it("keeps the original on interruption after temporary contents were written", () => {
  const f = fixture([pending("a"), admitted("a"), pending("b")]);
  const before = f.read();
  const write = vi.mocked(fs.writeFileSync).getMockImplementation()!;
  vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
    write(...args);
    throw Error("after temp write");
  });
  expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow(
    "after temp write",
  );
  expect(f.read()).toBe(before);
});

it("does not rewrite undecodable UTF-8 in unconfirmed records", () => {
  const f = fixture([pending("a"), admitted("a")]);
  fs.appendFileSync(
    f.path,
    Buffer.concat([
      Buffer.from(
        '{"sessionId":"s","messageId":"b","admitted":false,"message":"',
      ),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]),
  );
  const before = fs.readFileSync(f.path);
  expect(() => compactConfirmedJournal(f.path, [id("a")])).toThrow(
    "invalid UTF-8",
  );
  expect(fs.readFileSync(f.path)).toEqual(before);
});
