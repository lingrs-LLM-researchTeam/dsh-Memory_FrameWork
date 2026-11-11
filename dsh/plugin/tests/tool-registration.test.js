import { expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolsService, { defineTool } from "@deepseek-ai/dsh-tools";
import { installTools } from "../src/tools.js";

it("cleans up registrations when a Cordis plugin is unloaded and reloaded", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolsService);
    const plugin = {
      name: "memory-registration-fixture",
      inject: ["tools"],
      apply(child) {
        installTools(child, {});
      },
    };
    for (let i = 0; i < 3; i++) {
      const fork = ctx.plugin(plugin);
      await fork;
      expect(ctx.tools.definitions()).toHaveLength(6);
      await fork.dispose();
      expect(ctx.tools.definitions()).toHaveLength(0);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

it.each([true, false])(
  "coexists in either plugin order (other first: %s)",
  async (otherFirst) => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolsService);
      const other = defineTool({
        name: "memory_read",
        description:
          "Existing memory provider, same registration name as dsh-linghun",
        parameters: {
          full: { type: "boolean", description: "Read complete memory" },
        },
        output: {
          schema: { type: "string" },
          render: (_args, text) => [{ type: "text", text }],
        },
        execute: () => "other provider's own memory",
      });
      if (otherFirst) ctx.tools.register(other);
      // Tool registration must not contact the daemon or invoke a model.
      expect(() => installTools(ctx, {})).not.toThrow();
      if (!otherFirst) ctx.tools.register(other);
      expect(ctx.tools.get("memory_read")).toBe(other);
      expect(
        ctx.tools
          .definitions()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(
        [
          "memory_read",
          "memory_framework_search",
          "memory_framework_read",
          "memory_framework_remember",
          "memory_framework_task_state",
          "memory_framework_task_update",
          "memory_framework_checkpoint",
        ].sort(),
      );
      expect(await other.execute({ full: true }, {})).toBe(
        "other provider's own memory",
      );
    } finally {
      await ctx.fiber.dispose();
    }
  },
);

it("dispatches namespaced reads through the same trusted model channel", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolsService);
    const prepareTool = vi.fn(async () => {});
    const call = vi.fn(async () => ({ memory: { id: 7 }, sources: [] }));
    installTools(ctx, {
      prepareTool,
      client: { call },
      key: (id) => `fixture:${id}`,
    });
    const read = ctx.tools.get("memory_framework_read");
    const signal = new AbortController().signal;
    const agent = { id: "current-window" };
    expect(
      JSON.parse(
        await read.execute(
          { id: 7, source_id: "source", offset: 123 },
          { agent, signal },
        ),
      ),
    ).toEqual({ memory: { id: 7 }, sources: [] });
    expect(prepareTool).toHaveBeenCalledWith(agent, signal);
    expect(call).toHaveBeenCalledWith(
      "model",
      {
        operation: "memory.read",
        session_id: "fixture:current-window",
        payload: { id: 7, source_id: "source", offset: 123 },
      },
      signal,
    );
    await expect(read.execute({ id: 7 }, { signal })).rejects.toThrow(
      "trusted Agent identity",
    );
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    await ctx.fiber.dispose();
  }
});
