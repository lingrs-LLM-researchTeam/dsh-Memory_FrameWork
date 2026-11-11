import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
export interface Config {
    coreUrl: string;
    instanceId: string;
    credentialsFile: string;
    projectGoals: boolean;
    autoStartCore?: boolean;
    pythonCommand?: string;
}
export declare const Config: Schema<Config>;
export declare const name = "dsh-memory-framework";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): Promise<void>;
