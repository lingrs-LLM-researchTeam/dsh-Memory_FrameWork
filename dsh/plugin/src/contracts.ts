import { z } from "zod";
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteNamespace,
} from "@deepseek-ai/dsh-typert-protocol";

export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export const PACKAGE = "dsh-memory-framework";
export const Command = z
  .object({
    operation: z.string().min(1).max(100),
    session_id: z.string().max(500).optional(),
    payload: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type Command = z.infer<typeof Command>;
export const Reply = z.object({ result: z.json() }).strict();
export type Reply = z.infer<typeof Reply>;
export type Call = (
  operation: string,
  payload?: Record<string, JsonValue>,
  sessionId?: string,
  signal?: AbortSignal,
) => Promise<unknown>;

export const descriptors: readonly InvocationDescriptor[] = [
  {
    id: PACKAGE + "#memoryFramework/command",
    service: "memoryFramework",
    namespace: "memoryFramework",
    method: "command",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: PACKAGE + "#Command",
          create: () => Command,
        },
      },
    ],
    cancellation: { parameter: "signal" },
    result: {
      mode: "strict",
      typeSymbol: PACKAGE + "#Reply",
      create: () => Reply,
    },
  },
];

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteMap {
    "memoryFramework/command": (
      request: Command,
      signal?: AbortSignal,
    ) => Promise<RemoteResult<Reply>>;
  }
  interface TypertRemoteNamespaceMap {
    memoryFramework: TypertRemoteNamespace<"memoryFramework">;
  }
  interface RemoteErrorDetailsMap {
    "memory-framework/error": { code: string };
  }
}
