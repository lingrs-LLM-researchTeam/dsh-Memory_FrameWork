import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import { Reply } from "./contracts.js";
import { MemoryRuntime } from "./runtime.js";
import { installGateway } from "./gateway.js";
import { installTools } from "./tools.js";
import { CoreError } from "./transport.js";
import { contextAdvice } from "./host-context.js";
import { ensureCoreDaemon } from "./core-supervisor.js";

export interface Config {
  coreUrl: string;
  instanceId: string;
  credentialsFile: string;
  projectGoals: boolean;
  autoStartCore?: boolean;
  pythonCommand?: string;
}
export const Config: Schema<Config> = Schema.object({
  coreUrl: Schema.string()
    .default("http://127.0.0.1:18765")
    .description("Loopback memory daemon URL"),
  instanceId: Schema.string()
    .default("local")
    .description("Stable unique identity for this DSH profile"),
  credentialsFile: Schema.string()
    .default("~/.memory-framework/credentials.json")
    .description(
      "Local file produced by memory-framework init; never sent to the browser",
    ),
  projectGoals: Schema.boolean()
    .default(false)
    .description(
      "Optional one-way projection into native session goals; newly created projections stay disarmed",
    ),
  autoStartCore: Schema.boolean()
    .default(true)
    .description(
      "Automatically initialize and start the local Python memory core daemon when DSH starts",
    ),
  pythonCommand: Schema.string()
    .default("")
    .description(
      "Optional custom Python >= 3.12 executable path used when bootstrapping the local runtime",
    ),
});
export const name = "dsh-memory-framework";
export const inject = [
  "sessions",
  "sessionPersistence",
  "workspaceRegistry",
  "sessionController",
  "systemPrompt",
  "llm",
  "tools",
  "typert",
  "typertGateway",
];

export async function apply(ctx: Context, config: Config): Promise<void> {
  const stopDaemon = await ensureCoreDaemon({
    coreUrl: config.coreUrl,
    credentialsFile: config.credentialsFile,
    autoStartCore: config.autoStartCore ?? true,
    pythonCommand: config.pythonCommand,
    logger: ctx.logger,
  });
  ctx.effect(() => stopDaemon);
  const runtime = new MemoryRuntime(
    ctx,
    config.instanceId,
    config.coreUrl,
    config.credentialsFile,
    config.projectGoals,
  );
  await runtime.syncCatalog();
  const onboarding = z
    .object({ context_advice_ack: z.boolean() })
    .parse(
      await runtime.client.call("host", {
        operation: "onboarding.read",
        payload: {},
      }),
    );
  if (!onboarding.context_advice_ack) ctx.logger.info(contextAdvice);
  runtime.install();
  if (config.projectGoals)
    ctx.inject(["goals"], (inner) => {
      inner.effect(() => runtime.attachGoals(inner.goals));
    });
  installTools(ctx, runtime);
  const allowed = new Set([
    "snapshot",
    "memory.create",
    "memory.update",
    "memory.read",
    "memory.history",
    "source.revoke",
    "task.create",
    "task.read",
    "task.update",
    "task.verify",
    "task.move",
    "task.history",
    "task.checkpoint",
    "session.bind",
    "session.subscription",
    "profile.save",
    "profile.history",
    "ranking.preview",
    "events.poll",
    "policy.save",
    "source.promote",
    "onboarding.ack",
  ]);
  await installGateway(ctx, async (request, signal) => {
    if (request.operation === "plugin.identity") {
      return {
        result: {
          instanceId: config.instanceId,
          coreSessionId: request.session_id
            ? runtime.key(request.session_id)
            : null,
        },
      };
    }
    if (request.operation === "session.handoff") {
      const old = z.string().min(1).parse(request.payload.session_id);
      runtime.raw(old);
      return Reply.parse({ result: await runtime.handoff(old, signal) });
    }
    if (!allowed.has(request.operation))
      throw new CoreError("forbidden", "面板不支持此操作", 403);
    await runtime.syncCatalog(signal);
    const result = await runtime.client.call("admin", request, signal);
    if (
      ![
        "snapshot",
        "memory.read",
        "memory.history",
        "task.read",
        "task.history",
        "profile.history",
        "ranking.preview",
        "events.poll",
      ].includes(request.operation)
    )
      runtime.invalidate();
    return Reply.parse({ result });
  });
}
