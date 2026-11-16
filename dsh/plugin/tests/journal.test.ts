import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRuntime } from "../src/runtime.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: vi.fn(original.writeFileSync),
    ftruncateSync: vi.fn(original.ftruncateSync),
    fsyncSync: vi.fn(original.fsyncSync),
  };
});

const temporaryDirs: string[] = [];
const pendingRow = (messageId: string, text = "synthetic input") => ({
  sessionId: "s",
  messageId,
  message: {
    id: messageId,
    source: { kind: "user" },
    content: [{ type: "text", text }],
  },
  admitted: false,
});
const admittedRow = (messageId: string) => ({
  sessionId: "s",
  messageId,
  admitted: true,
});
const line = (row: unknown) => JSON.stringify(row) + "\n";

function fixture(contents?: string | Buffer) {
  const root = fs.mkdtempSync(join(tmpdir(), "mf-journal-"));
  temporaryDirs.push(root);
  const credentials = join(root, "credentials.json");
  const journal = join(root, "dsh-test-pending.jsonl");
  fs.writeFileSync(
    credentials,
    JSON.stringify({ host_token: "h".repeat(48), admin_token: "a".repeat(48) }),
  );
  if (contents !== undefined) fs.writeFileSync(journal, contents);
  const warn = vi.fn();
  const start = () =>
    new MemoryRuntime(
      { logger: { warn } } as unknown as Context,
      "test",
      "http://127.0.0.1:18765",
      credentials,
    );
  const backups = () =>
    fs
      .readdirSync(root)
      .filter((name) => name.startsWith("dsh-test-pending.jsonl.corrupt-"))
      .map((name) => join(root, name));
  return { root, journal, warn, start, backups };
}

// Inspect the recovery state and append path without installing host hooks or making requests.
function pendingIds(runtime: MemoryRuntime) {
  return [...runtime["pending"].values()].map((row) => row.messageId);
}
function append(runtime: MemoryRuntime, messageId: string, admitted = false) {
  runtime["savePending"](
    "s",
    pendingRow(messageId).message as UserMessage,
    admitted,
  );
}

afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset();
  vi.mocked(fs.ftruncateSync).mockReset();
  vi.mocked(fs.fsyncSync).mockReset();
  for (const dir of temporaryDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("pending input journal recovery", () => {
  it.each([undefined, ""])(
    "accepts a missing or empty journal (%s)",
    (contents) => {
      const f = fixture(contents);
      expect(pendingIds(f.start())).toEqual([]);
      expect(f.backups()).toEqual([]);
      expect(f.warn).not.toHaveBeenCalled();
    },
  );

  it("restores complete pending records and applies admitted records unchanged", () => {
    const contents =
      line(pendingRow("a")) + line(pendingRow("b")) + line(admittedRow("a"));
    const f = fixture(contents);
    expect(pendingIds(f.start())).toEqual(["b"]);
    expect(fs.readFileSync(f.journal, "utf8")).toBe(contents);
    expect(f.backups()).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("preserves the exact damaged tail and recovers all preceding pending inputs", () => {
    const prefix =
      line(pendingRow("a")) + line(pendingRow("b")) + line(admittedRow("a"));
    const tail = '{"sessionId":"s","messageId":"c","message":';
    const f = fixture(prefix + tail);
    const runtime = f.start();
    expect(pendingIds(runtime)).toEqual(["b"]);
    expect(fs.readFileSync(f.journal, "utf8")).toBe(prefix);
    expect(f.backups()).toHaveLength(1);
    expect(fs.readFileSync(f.backups()[0], "utf8")).toBe(tail);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      f.backups()[0],
      Buffer.from(tail),
      {
        flag: "wx",
        mode: 0o600,
        flush: true,
      },
    );
    expect(
      vi.mocked(fs.writeFileSync).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(vi.mocked(fs.ftruncateSync).mock.invocationCallOrder[0]);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain(tail);
    if (process.platform !== "win32")
      expect(fs.statSync(f.backups()[0]).mode & 0o777).toBe(0o600);

    append(runtime, "b", true);
    append(runtime, "d");
    expect(pendingIds(f.start())).toEqual(["d"]);
    expect(f.backups()).toHaveLength(1);
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it("does not treat a truncated admitted record as successful admission", () => {
    const prefix = line(pendingRow("a"));
    const tail = JSON.stringify(admittedRow("a")).slice(0, -3);
    const f = fixture(prefix + tail);
    expect(pendingIds(f.start())).toEqual(["a"]);
    expect(fs.readFileSync(f.journal, "utf8")).toBe(prefix);
  });

  it("preserves truncated UTF-8 bytes without changing the valid prefix", () => {
    const prefix = Buffer.from(line(pendingRow("a", "保留有效中文输入")));
    const tail = Buffer.concat([
      Buffer.from('{"message":"'),
      Buffer.from("中").subarray(0, 2),
    ]);
    const f = fixture(Buffer.concat([prefix, tail]));
    expect(pendingIds(f.start())).toEqual(["a"]);
    expect(fs.readFileSync(f.journal)).toEqual(prefix);
    expect(fs.readFileSync(f.backups()[0])).toEqual(tail);
  });

  it("recovers a journal containing only a truncated first record", () => {
    const tail = '{"sessionId":"s"';
    const f = fixture(tail);
    const runtime = f.start();
    expect(pendingIds(runtime)).toEqual([]);
    expect(fs.readFileSync(f.backups()[0], "utf8")).toBe(tail);
    append(runtime, "new");
    expect(pendingIds(f.start())).toEqual(["new"]);
  });

  it("adds a missing newline to a complete final record before the next append", () => {
    const contents = line(pendingRow("a")) + JSON.stringify(pendingRow("b"));
    const f = fixture(contents);
    const runtime = f.start();
    expect(pendingIds(runtime)).toEqual(["a", "b"]);
    expect(fs.readFileSync(f.journal, "utf8")).toBe(contents + "\n");
    append(runtime, "c");
    expect(pendingIds(f.start())).toEqual(["a", "b", "c"]);
    expect(f.backups()).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("honors a complete admitted final record without a newline", () => {
    const f = fixture(line(pendingRow("a")) + JSON.stringify(admittedRow("a")));
    expect(pendingIds(f.start())).toEqual([]);
    expect(pendingIds(f.start())).toEqual([]);
    expect(f.backups()).toEqual([]);
  });

  it.each([
    '{"broken":\n' + line(pendingRow("after")),
    line(pendingRow("a")) + '{"broken":\n',
    line(pendingRow("a")) + line({ sessionId: "s", messageId: "bad" }),
    line(pendingRow("a")) +
      JSON.stringify({ sessionId: "s", messageId: "bad" }),
  ])(
    "rejects middle corruption, terminated corruption, and invalid row schemas",
    (contents) => {
      const f = fixture(contents);
      expect(f.start).toThrow();
      expect(fs.readFileSync(f.journal, "utf8")).toBe(contents);
      expect(f.backups()).toEqual([]);
      expect(f.warn).not.toHaveBeenCalled();
    },
  );

  it("does not truncate when the tail backup cannot be saved", () => {
    const contents = line(pendingRow("a")) + '{"broken":';
    const f = fixture(contents);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error("backup unavailable");
    });
    expect(f.start).toThrow("backup unavailable");
    expect(fs.readFileSync(f.journal, "utf8")).toBe(contents);
    expect(f.backups()).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("refuses to truncate a journal that changed after its recovery snapshot", () => {
    const contents = line(pendingRow("a")) + '{"broken":';
    const appended = "\n" + line(pendingRow("new"));
    const f = fixture(contents);
    const write = vi.mocked(fs.writeFileSync).getMockImplementation()!;
    vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
      write(...args);
      fs.appendFileSync(f.journal, appended);
    });
    expect(f.start).toThrow("Memory journal changed during recovery");
    expect(fs.readFileSync(f.journal, "utf8")).toBe(contents + appended);
    expect(vi.mocked(fs.ftruncateSync)).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
  });

  it("keeps the original and backup when truncation fails, then retries safely", () => {
    const prefix = line(pendingRow("a"));
    const tail = '{"broken":';
    const f = fixture(prefix + tail);
    vi.mocked(fs.ftruncateSync).mockImplementationOnce(() => {
      throw new Error("truncate unavailable");
    });
    expect(f.start).toThrow("truncate unavailable");
    expect(fs.readFileSync(f.journal, "utf8")).toBe(prefix + tail);
    expect(fs.readFileSync(f.backups()[0], "utf8")).toBe(tail);
    expect(pendingIds(f.start())).toEqual(["a"]);
    expect(f.backups()).toHaveLength(2);
    for (const backup of f.backups())
      expect(fs.readFileSync(backup, "utf8")).toBe(tail);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the original when the backup directory cannot be synced",
    () => {
      const contents = line(pendingRow("a")) + '{"broken":';
      const f = fixture(contents);
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
        throw new Error("directory sync unavailable");
      });
      expect(f.start).toThrow("directory sync unavailable");
      expect(fs.readFileSync(f.journal, "utf8")).toBe(contents);
      expect(vi.mocked(fs.ftruncateSync)).not.toHaveBeenCalled();
      expect(f.backups()).toHaveLength(1);
      expect(f.warn).not.toHaveBeenCalled();
    },
  );

  it("fails closed after a sync failure and can recover from the preserved valid prefix", () => {
    const prefix = line(pendingRow("a"));
    const tail = '{"broken":';
    const f = fixture(prefix + tail);
    if (process.platform !== "win32")
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {});
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error("sync unavailable");
    });
    expect(f.start).toThrow("sync unavailable");
    expect(fs.readFileSync(f.journal, "utf8")).toBe(prefix);
    expect(fs.readFileSync(f.backups()[0], "utf8")).toBe(tail);
    expect(pendingIds(f.start())).toEqual(["a"]);
    expect(f.warn).not.toHaveBeenCalled();
  });
});
