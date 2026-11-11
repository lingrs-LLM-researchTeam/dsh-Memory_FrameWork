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
import { PACKAGE, descriptors, type Call } from "./contracts.js";
import { Dashboard } from "./dashboard.js";

type BodyProps = PropsRuntime<"sidebar.right.pane.tab"> & {
  call: Call;
  openHandoff: (id: string) => Promise<void>;
};
function Body({ sessionId, call, openHandoff }: BodyProps) {
  const [identity, setIdentity] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void call("plugin.identity", {}, sessionId, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted)
          setIdentity(
            z.object({ coreSessionId: z.string() }).parse(result).coreSessionId,
          );
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    return () => abort.abort();
  }, [sessionId, call]);
  if (error) return <p role="alert">{error}</p>;
  return identity ? (
    <Dashboard
      call={call}
      initialSessionId={identity}
      onHandoff={openHandoff}
    />
  ) : (
    <p>正在连接 Memory Framework…</p>
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
  const call: Call = async (operation, payload = {}, sessionId, signal) => {
    const result = await ctx.remote.memoryFramework.command(
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
      },
    ],
  };
  ctx.effect(() => ctx.sidebarRightTabs.register(definition));
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register(
      {
        name: "sidebar.right.pane.tab",
        key: definition.id,
        inject: () => ({ call, openHandoff }),
      },
      Body,
    ),
  );
}
