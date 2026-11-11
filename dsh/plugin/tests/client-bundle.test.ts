import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Context, Service } from "@deepseek-ai/cordis";

it("registers a browser factory with only platform-provided external modules", () => {
  const require = createRequire(import.meta.url);
  const requested: string[] = [];
  const registrations: string[] = [];
  runInNewContext(
    readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load(entry: {
            id: string;
            factory: (require: (id: string) => unknown) => { apply: unknown };
          }) {
            registrations.push(entry.id);
            const exports = entry.factory((id) => {
              requested.push(id);
              return require(id);
            });
            expect(typeof exports.apply).toBe("function");
          },
        },
      },
      URL,
      TextEncoder,
      TextDecoder,
      console,
    },
  );
  expect(registrations).toEqual(["dsh-memory-framework"]);
  expect(
    requested.every((id) =>
      [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "@deepseek-ai/cordis",
      ].includes(id),
    ),
  ).toBe(true);
});

it("resolves remote.memoryFramework through Cordis without throwing missing-inject and registers left/right sidebar entries", async () => {
  const require = createRequire(import.meta.url);
  let clientModule:
    | {
        inject: string[];
        apply: (ctx: Context) => Promise<void>;
        MAIN_PANEL_ID: string;
      }
    | undefined;
  runInNewContext(
    readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load(entry: {
            id: string;
            factory: (require: (id: string) => unknown) => typeof clientModule;
          }) {
            clientModule = entry.factory((id) => require(id));
          },
        },
      },
      URL,
      TextEncoder,
      TextDecoder,
      console,
    },
  );
  expect(clientModule).toBeDefined();

  const root = new Context();
  try {
    const commandSpy = vi.fn(async (request: { operation: string }) => ({
      ok: true as const,
      value: {
        result: {
          instanceId: "local",
          coreSessionId: request.operation === "plugin.identity" ? null : "s1",
        },
      },
    }));

    class FakeNamespaceService extends Service {
      constructor(ctx: Context) {
        super(ctx, "remote.memoryFramework");
      }
      command = commandSpy;
    }

    class FakeRemoteService extends Service {
      ownerCtx: Context;
      constructor(ctx: Context) {
        super(ctx, "remote");
        this.ownerCtx = ctx;
      }
      async $mount() {
        const fiber = this.ownerCtx.plugin({
          name: "remote.memoryFramework",
          apply: (nsCtx) => {
            new FakeNamespaceService(nsCtx);
          },
        });
        await fiber;
        return async () => {
          await fiber.dispose();
        };
      }
    }

    const registeredSlots = new Map<
      string,
      { spec: Record<string, unknown>; component: unknown }
    >();
    const selectPanel = vi.fn();

    root.provide("slots", {
      inject: (_slotName: string, register: () => () => void) => register(),
      register: (spec: Record<string, unknown>, component: unknown) => {
        const slotKey = `${String(spec.name)}:${String(spec.key ?? spec.id ?? "")}`;
        registeredSlots.set(slotKey, { spec, component });
        return () => {
          registeredSlots.delete(slotKey);
        };
      },
    });
    root.provide("sidebarRightTabs", {
      register: () => () => {},
    });
    root.provide("sessions", {
      refresh: async () => {},
      list: { getSnapshot: () => ({ phase: "ready", ids: ["s1"] }) },
    });
    root.provide("uiWorkspace", {
      openSession: vi.fn(),
    });
    root.provide("layout", {
      selectPanel,
    });

    await root.plugin({
      name: "api-gateway-client",
      apply: (gwCtx) => {
        new FakeRemoteService(gwCtx);
      },
    });

    await root.plugin(clientModule!);

    // Verify all 4 slots are registered: right sidebar tab, main panel, left sidebar panellist, and plugin detail actions
    expect(
      registeredSlots.has("sidebar.right.pane.tab:dsh-memory-framework"),
    ).toBe(true);
    expect(registeredSlots.has("main:memory-framework")).toBe(true);
    expect(registeredSlots.has("sidebar.panellist:memory-framework")).toBe(
      true,
    );
    expect(
      registeredSlots.has("plugins.detail.actions:memory-framework-open"),
    ).toBe(true);

    // Invoke `call` from the right-sidebar tab slot and ensure Cordis does NOT throw `cannot get property "remote.memoryFramework" without inject`
    const rightTabEntry = registeredSlots.get(
      "sidebar.right.pane.tab:dsh-memory-framework",
    )!;
    const injectedProps = (
      rightTabEntry.spec.inject as () => {
        call: (op: string, payload?: Record<string, unknown>) => Promise<unknown>;
      }
    )();
    const identityResult = await injectedProps.call("plugin.identity", {});
    expect(identityResult).toEqual({
      instanceId: "local",
      coreSessionId: null,
    });
    expect(commandSpy).toHaveBeenCalledWith(
      { operation: "plugin.identity", payload: {} },
      undefined,
    );

    // Verify plugin detail action button opens the main panel via layout.selectPanel
    const actionEntry = registeredSlots.get(
      "plugins.detail.actions:memory-framework-open",
    )!;
    const actionInjected = (
      actionEntry.spec.inject as () => { onOpen: () => void }
    )();
    actionInjected.onOpen();
    expect(selectPanel).toHaveBeenCalledWith("memory-framework");
  } finally {
    await root.fiber.dispose();
  }
});
