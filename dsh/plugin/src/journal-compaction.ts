import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const JournalRow = z
  .object({
    sessionId: z.string(),
    messageId: z.string(),
    message: z.json().optional(),
    admitted: z.boolean(),
  })
  .strict();
const key = (row: { sessionId: string; messageId: string }) =>
  JSON.stringify([row.sessionId, row.messageId]);

// Only call with messages from a replay batch whose flush, ingestion and cursor
// commit have all succeeded. No awaits: append and replacement cannot interleave
// in this single Host. This is deliberately NOT a cross-process lock protocol.
export function compactConfirmedJournal(
  path: string,
  confirmed: readonly { sessionId: string; messageId: string }[],
) {
  if (!confirmed.length || !existsSync(path)) return;
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original))
    throw new Error("Journal contains invalid UTF-8; refusing compaction");
  const lines = text.split("\n");
  // Startup owns torn-tail recovery and its backup. Never silently discard it.
  if (lines.pop() !== "")
    throw new Error("Journal requires tail recovery before compaction");
  const rows = lines.map((line) =>
    line ? JournalRow.parse(JSON.parse(line)) : undefined,
  );
  const allowed = new Set(confirmed.map(key));
  const lastAdmission = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row?.admitted && allowed.has(key(row)))
      lastAdmission.set(key(row), index);
  });
  // Keep the final admission tombstone, any later capture, and all unconfirmed
  // history. An old admitted marker alone is never permission to remove text.
  const kept = lines.filter((_, index) => {
    const row = rows[index];
    if (!row) return true;
    const end = lastAdmission.get(key(row));
    return end === undefined || index >= end;
  });
  if (kept.length === lines.length) return;
  const temporary = path + ".compact-" + randomUUID();
  try {
    writeFileSync(temporary, kept.join("\n") + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    // Detect accidental external changes; this is not a multi-writer guarantee.
    if (!readFileSync(path).equals(original))
      throw new Error("Journal changed during compaction");
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
