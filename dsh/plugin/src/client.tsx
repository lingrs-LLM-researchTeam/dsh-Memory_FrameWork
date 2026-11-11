import { useEffect, useState } from "react";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import {
  PACKAGE,
  descriptors,
  type Call,
  type Command,
  type Reply,
} from "./contracts.js";
import { Dashboard } from "./dashboard.js";

export const MAIN_PANEL_ID = "memory-framework";

const IdentityResultSchema = z.object({
  coreSessionId: z.string().nullable().optional(),
});

interface MemoryRemoteNamespace {
  command(
    request: Command,
    signal?: AbortSignal,
  ): Promise<RemoteResult<Reply>>;
}

interface LayoutLike {
  selectPanel(panelId: string | null): void;
}

interface SlotsLike {
  inject(slotName: string, register: () => () => void): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

function MemorySidebarIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="8.25"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 3.75a8.25 8.25 0 0 0 0 16.5 6.2 6.2 0 0 1 0-16.5Z"
        fill="currentColor"
        fillOpacity="0.22"
      />
      <circle cx="15.2" cy="9.2" r="1.5" fill="currentColor" />
    </svg>
  );
}

function MemoryGuideIcon() {
  return <MemorySidebarIcon size={20} />;
}

type BodyProps = Partial<PropsRuntime<"sidebar.right.pane.tab">> & {
  call: Call;
  openHandoff: (id: string) => Promise<void>;
};

function Body({ sessionId, call, openHandoff }: BodyProps) {
  const [identity, setIdentity] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void call("plugin.identity", {}, sessionId || undefined, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) {
          const parsed = IdentityResultSchema.parse(result);
          setIdentity(parsed.coreSessionId ?? "");
        }
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(String(err));
      });
    return () => abort.abort();
  }, [sessionId, call]);
  if (error) return <p role="alert">{error}</p>;
  return identity !== null ? (
    <Dashboard
      call={call}
      initialSessionId={identity}
      onHandoff={openHandoff}
    />
  ) : (
    <p>正在连接 Memory Framework…</p>
  );
}

function MainPage({
  call,
  openHandoff,
}: {
  call: Call;
  openHandoff: (id: string) => Promise<void>;
}) {
  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto" }}>
      <Body sessionId={undefined} call={call} openHandoff={openHandoff} />
    </div>
  );
}

function OpenMemoryAction({
  subject,
  packageName,
  onOpen,
}: {
  subject?: {
    kind?: string;
    pkg?: { name?: string };
    row?: { moduleName?: string };
  };
  packageName: string;
  onOpen: () => void;
}) {
  if (subject?.kind !== "bundle" && subject?.kind !== "row") return null;
  if (subject.pkg?.name !== packageName) return null;
  if (subject.kind === "row" && subject.row?.moduleName !== packageName)
    return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        padding: "5px 12px",
        borderRadius: "6px",
        border: "1px solid rgba(128, 128, 128, 0.28)",
        background: "transparent",
        color: "inherit",
        fontSize: "12px",
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      打开记忆面板
    </button>
  );
}

export const inject = [
  "remote",
  "slots",
  "sidebarRightTabs",
  "sessions",
  "uiWorkspace",
];

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount({ package: PACKAGE, descriptors });

  let injectedRemote: MemoryRemoteNamespace | undefined;
  let injectedLayout: LayoutLike | undefined;

  const ctxWithInject = ctx as unknown as {
    inject?: (
      deps: readonly string[],
      callback: (innerCtx: Context) => (() => void) | void,
    ) => unknown;
    get?: (name: string) => unknown;
  };

  if (typeof ctxWithInject.inject === "function") {
    ctxWithInject.inject(["remote.memoryFramework"], (remoteCtx) => {
      injectedRemote = remoteCtx.remote.memoryFramework;
      return () => {
        injectedRemote = undefined;
      };
    });
    ctxWithInject.inject(["layout"], (layoutCtx) => {
      injectedLayout = (layoutCtx as unknown as { layout?: LayoutLike }).layout;
      return () => {
        injectedLayout = undefined;
      };
    });
  }

  const resolveRemote = (): MemoryRemoteNamespace => {
    if (injectedRemote) return injectedRemote;
    const fromStore = ctxWithInject.get?.("remote.memoryFramework") as
      | MemoryRemoteNamespace
      | undefined;
    if (fromStore) return fromStore;
    return ctx.remote.memoryFramework;
  };

  const resolveLayout = (): LayoutLike | undefined => {
    if (injectedLayout) return injectedLayout;
    return ctxWithInject.get?.("layout") as LayoutLike | undefined;
  };

  const call: Call = async (operation, payload = {}, sessionId, signal) => {
    const remoteNamespace = resolveRemote();
    const result = await remoteNamespace.command(
      { operation, payload, ...(sessionId ? { session_id: sessionId } : {}) },
      signal,
    );
    if (!result.ok) throw result.error;
    return result.value.result;
  };

  const openHandoff = async (id: string) => {
    await ctx.sessions.refresh();
    const list: SessionListState = ctx.sessions.list.getSnapshot();
    if (list.phase !== "ready")
      throw new Error("会话列表尚未更新，请从 DSH 会话列表打开新会话");
    const target = list.ids.find((value) => value === id);
    if (!target) throw new Error("新会话尚未出现在宿主列表中");
    resolveLayout()?.selectPanel(null);
    ctx.uiWorkspace.openSession(target);
  };

  const definition = {
    id: PACKAGE,
    kind: "memory-framework",
    title: () => "记忆与任务",
    guide: [
      {
        id: "memory-framework",
        order: 35,
        title: () => "Memory Framework · 记忆与任务",
        description: () => "管理跨会话证据记忆、任务编排与上下文预算",
        icon: MemoryGuideIcon,
      },
    ],
  };

  const rawSlots = ctx.slots as unknown as SlotsLike;
  const disposers: Array<() => void> = [];

  disposers.push(ctx.sidebarRightTabs.register(definition));
  disposers.push(
    ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: definition.id,
          inject: () => ({ call, openHandoff }),
        },
        Body,
      ),
    ),
  );

  // 主工作区全屏面板与左侧边栏导航入口（id 与 main 席位 key 对齐，点击即可通过宿主 layout.selectPanel 切换）
  disposers.push(
    rawSlots.inject("main", () =>
      rawSlots.register(
        {
          name: "main",
          key: MAIN_PANEL_ID,
          inject: () => ({ call, openHandoff }),
        },
        MainPage,
      ),
    ),
  );
  disposers.push(
    rawSlots.inject("sidebar.panellist", () =>
      rawSlots.register(
        {
          name: "sidebar.panellist",
          id: MAIN_PANEL_ID,
          order: 15,
          label: "记忆与任务",
        },
        MemorySidebarIcon,
      ),
    ),
  );
  disposers.push(
    rawSlots.inject("plugins.detail.actions", () =>
      rawSlots.register(
        {
          name: "plugins.detail.actions",
          id: "memory-framework-open",
          order: 20,
          inject: () => ({
            packageName: PACKAGE,
            onOpen: () => resolveLayout()?.selectPanel(MAIN_PANEL_ID),
          }),
        },
        OpenMemoryAction,
      ),
    ),
  );

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose();
  });
}
