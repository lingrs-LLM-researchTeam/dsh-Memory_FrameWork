export interface SupervisorOptions {
    coreUrl: string;
    credentialsFile: string;
    autoStartCore?: boolean;
    pythonCommand?: string;
    logger?: {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
    };
}
export declare function isCoreHealthy(origin: string, timeoutMs?: number): Promise<boolean>;
export declare function resolvePythonRuntime(dataDir: string, pluginRoot: string, pythonCommand?: string): string;
export declare function ensureCoreDaemon(options: SupervisorOptions): Promise<() => void>;
