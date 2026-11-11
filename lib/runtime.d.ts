import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { GoalService } from "@deepseek-ai/dsh-goal";
import { CoreClient } from "./transport.js";
export declare function plainText(content: readonly unknown[]): string;
export declare class MemoryRuntime {
    readonly ctx: Context;
    readonly instanceId: string;
    private readonly projectGoals;
    readonly client: CoreClient;
    private readonly snapshots;
    private readonly fences;
    private readonly queues;
    private readonly activeSessions;
    private readonly admitting;
    private readonly eventCursors;
    private readonly updates;
    private readonly pending;
    private readonly journal;
    private knownRevision;
    private alive;
    private lastCheck;
    private goals?;
    constructor(ctx: Context, instanceId: string, coreUrl: string, credentialsFile: string, projectGoals?: boolean);
    key(id: string): string;
    raw(id: string): string;
    syncCatalog(signal?: AbortSignal): Promise<void>;
    ensure(session: Session, signal?: AbortSignal): Promise<{
        id: string;
        workspace_id: string;
        task_id: string | null;
        cursor: number;
    }>;
    private enqueue;
    private savePending;
    private mirrorPending;
    ingest(session: Session, event: SessionEvent, signal?: AbortSignal): Promise<void>;
    replay(session: Session, signal?: AbortSignal): Promise<void>;
    check(sessionId: string, signal?: AbortSignal): Promise<{
        safe: boolean;
        policy_revision: number;
    }>;
    invalidate(): void;
    attachGoals(goals: GoalService): () => void;
    private syncGoal;
    install(): void;
    prepareTool(agent: Agent, signal: AbortSignal): Promise<void>;
    handoff(sourceSessionId: string, signal: AbortSignal): Promise<{
        sessionId: SessionId;
        coreSessionId: string;
        pendingInputRequiresReview: boolean;
    }>;
}
