import { z } from "zod";
import type { InvocationDescriptor, RemoteResult, TypertRemoteNamespace } from "@deepseek-ai/dsh-typert-protocol";
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export declare const PACKAGE = "dsh-memory-framework";
export declare const Command: z.ZodObject<{
    operation: z.ZodString;
    session_id: z.ZodOptional<z.ZodString>;
    payload: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
}, z.core.$strict>;
export type Command = z.infer<typeof Command>;
export declare const Reply: z.ZodObject<{
    result: z.ZodJSONSchema;
}, z.core.$strict>;
export type Reply = z.infer<typeof Reply>;
export type Call = (operation: string, payload?: Record<string, JsonValue>, sessionId?: string, signal?: AbortSignal) => Promise<unknown>;
export declare const descriptors: readonly InvocationDescriptor[];
declare module "@deepseek-ai/dsh-typert-protocol" {
    interface TypertRemoteMap {
        "memoryFramework/command": (request: Command, signal?: AbortSignal) => Promise<RemoteResult<Reply>>;
    }
    interface TypertRemoteNamespaceMap {
        memoryFramework: TypertRemoteNamespace<"memoryFramework">;
    }
    interface RemoteErrorDetailsMap {
        "memory-framework/error": {
            code: string;
        };
    }
}
