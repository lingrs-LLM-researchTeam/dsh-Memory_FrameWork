import type { Context } from "@deepseek-ai/cordis";
import { type Command, type Reply } from "./contracts.js";
export declare function installGateway(ctx: Context, handle: (request: Command, signal: AbortSignal) => Promise<Reply>): Promise<void>;
