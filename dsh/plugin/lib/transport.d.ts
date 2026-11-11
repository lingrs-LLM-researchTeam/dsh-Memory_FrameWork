import { z } from "zod";
import type { Command } from "./contracts.js";
export declare const Credentials: z.ZodObject<{
    host_token: z.ZodString;
    admin_token: z.ZodString;
}, z.core.$strict>;
export declare function expandPath(path: string): string;
export declare class CoreError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status?: number);
}
export declare class CoreClient {
    readonly credentials: z.infer<typeof Credentials>;
    readonly base: string;
    constructor(url: string, credentialsFile: string);
    call(channel: "host" | "model" | "admin", command: Command, signal?: AbortSignal): Promise<unknown>;
}
