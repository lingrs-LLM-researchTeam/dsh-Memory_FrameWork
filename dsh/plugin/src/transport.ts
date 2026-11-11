import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { Command } from "./contracts.js";

export const Credentials = z
  .object({ host_token: z.string().min(32), admin_token: z.string().min(32) })
  .strict();
export function expandPath(path: string) {
  return resolve(
    path.startsWith("~/") || path.startsWith("~\\")
      ? homedir() + path.slice(1)
      : path,
  );
}

export class CoreError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

export class CoreClient {
  readonly credentials: z.infer<typeof Credentials>;
  readonly base: string;
  constructor(url: string, credentialsFile: string) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error("coreUrl must be a loopback HTTP origin");
    this.base = parsed.origin;
    this.credentials = Credentials.parse(
      JSON.parse(readFileSync(expandPath(credentialsFile), "utf8")),
    );
  }
  async call(
    channel: "host" | "model" | "admin",
    command: Command,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(20000);
    const response = await fetch(this.base + "/v1/" + channel, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Bearer " +
          (channel === "admin"
            ? this.credentials.admin_token
            : this.credentials.host_token),
      },
      body: JSON.stringify(command),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(result);
      throw new CoreError(
        error.success ? error.data.error.code : "core_error",
        error.success ? error.data.error.message : "Memory core request failed",
        response.status,
      );
    }
    return result;
  }
}
