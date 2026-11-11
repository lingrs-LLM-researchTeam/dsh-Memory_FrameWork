import type { Context } from "@deepseek-ai/cordis";
import {
  Remote,
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { PACKAGE, descriptors, type Command, type Reply } from "./contracts.js";
import { CoreError } from "./transport.js";

export async function installGateway(
  ctx: Context,
  handle: (request: Command, signal: AbortSignal) => Promise<Reply>,
) {
  ctx.effect(() =>
    ctx.typert.register({
      package: PACKAGE,
      face: "host",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: descriptors,
    }),
  );
  class MemoryService extends TypertRemoteService {
    constructor(context: Context) {
      super(context, "memoryFramework");
    }
    @Remote
    async command(request: Command, signal: AbortSignal): Promise<Reply> {
      if (this.ctx.invocation?.peer.principal.kind !== "owner")
        throw new RemoteError(
          "memory-framework/error",
          "只有宿主所有者可以管理记忆",
          { code: "forbidden" },
        );
      signal.throwIfAborted();
      try {
        return await handle(request, signal);
      } catch (error) {
        if (error instanceof CoreError)
          throw new RemoteError("memory-framework/error", error.message, {
            code: error.code,
          });
        throw new RemoteError(
          "memory-framework/error",
          "记忆核心暂不可用，请检查连接与 Dashboard",
          { code: "unavailable" },
        );
      }
    }
  }
  await ctx.plugin(MemoryService);
}
