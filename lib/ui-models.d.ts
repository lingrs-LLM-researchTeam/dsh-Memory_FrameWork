import { z } from "zod";
export declare const WeightSchema: z.ZodObject<{
    task: z.ZodNumber;
    relevance: z.ZodNumber;
    evidence: z.ZodNumber;
    importance: z.ZodNumber;
    dependency: z.ZodNumber;
    recency: z.ZodNumber;
    redundancy: z.ZodNumber;
    half_life_days: z.ZodNumber;
    limit: z.ZodNumber;
    context_chars: z.ZodNumber;
    min_relevance: z.ZodNumber;
}, z.core.$strip>;
export type Weights = z.infer<typeof WeightSchema>;
export declare const MemorySchema: z.ZodObject<{
    id: z.ZodNumber;
    content: z.ZodString;
    kind: z.ZodString;
    session_id: z.ZodString;
    workspace_id: z.ZodString;
    task_id: z.ZodNullable<z.ZodString>;
    importance: z.ZodNumber;
    pinned: z.ZodNumber;
    scope: z.ZodString;
    targets: z.ZodString;
    broadcast: z.ZodNumber;
    vector_enabled: z.ZodNumber;
    status: z.ZodString;
    revision: z.ZodNumber;
    source_ids: z.ZodArray<z.ZodString>;
    evidence_current: z.ZodBoolean;
    evidence_quality: z.ZodNumber;
    created_at: z.ZodNumber;
    updated_at: z.ZodNumber;
}, z.core.$strip>;
export type Memory = z.infer<typeof MemorySchema>;
export declare const TaskSchema: z.ZodObject<{
    id: z.ZodString;
    workspace_id: z.ZodString;
    revision: z.ZodNumber;
    title: z.ZodString;
    goal: z.ZodString;
    constraints: z.ZodArray<z.ZodString>;
    acceptance: z.ZodArray<z.ZodString>;
    status: z.ZodString;
    blockers: z.ZodArray<z.ZodString>;
    decisions: z.ZodArray<z.ZodString>;
    next_action: z.ZodString;
    evidence_ids: z.ZodArray<z.ZodString>;
    verification: z.ZodRecord<z.ZodString, z.ZodObject<{
        source_id: z.ZodString;
        revision: z.ZodNumber;
        method: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Task = z.infer<typeof TaskSchema>;
export declare const PolicySchema: z.ZodObject<{
    context_mode: z.ZodEnum<{
        follow_dsh: "follow_dsh";
        manual: "manual";
    }>;
    context_share: z.ZodNumber;
    evidence_bytes: z.ZodNumber;
    automatic_bytes: z.ZodNumber;
    max_tool_calls: z.ZodNumber;
    max_writes: z.ZodNumber;
    source_chars: z.ZodNumber;
    tool_memory_mode: z.ZodEnum<{
        evidence_only: "evidence_only";
        allowlist: "allowlist";
        all: "all";
    }>;
    tool_allowlist: z.ZodArray<z.ZodString>;
    tool_max_chars: z.ZodNumber;
    tool_include_errors: z.ZodBoolean;
    embedding_enabled: z.ZodBoolean;
    indexing_paused: z.ZodBoolean;
    embedding_daily_chars: z.ZodNumber;
}, z.core.$strip>;
export type Policy = z.infer<typeof PolicySchema>;
export declare const SnapshotSchema: z.ZodObject<{
    onboarding: z.ZodObject<{
        context_advice_ack: z.ZodBoolean;
    }, z.core.$strip>;
    contexts: z.ZodArray<z.ZodObject<{
        session_id: z.ZodString;
        mode: z.ZodEnum<{
            follow_dsh: "follow_dsh";
            manual: "manual";
            unavailable: "unavailable";
        }>;
        context_window: z.ZodNullable<z.ZodNumber>;
        reserved_output_tokens: z.ZodNullable<z.ZodNumber>;
        automatic_bytes: z.ZodNumber;
        evidence_bytes: z.ZodNumber;
        context_chars: z.ZodNumber;
        observed_at: z.ZodNullable<z.ZodNumber>;
        host: z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    policies: z.ZodArray<z.ZodObject<{
        workspace_id: z.ZodString;
        revision: z.ZodNumber;
        settings: z.ZodObject<{
            context_mode: z.ZodEnum<{
                follow_dsh: "follow_dsh";
                manual: "manual";
            }>;
            context_share: z.ZodNumber;
            evidence_bytes: z.ZodNumber;
            automatic_bytes: z.ZodNumber;
            max_tool_calls: z.ZodNumber;
            max_writes: z.ZodNumber;
            source_chars: z.ZodNumber;
            tool_memory_mode: z.ZodEnum<{
                evidence_only: "evidence_only";
                allowlist: "allowlist";
                all: "all";
            }>;
            tool_allowlist: z.ZodArray<z.ZodString>;
            tool_max_chars: z.ZodNumber;
            tool_include_errors: z.ZodBoolean;
            embedding_enabled: z.ZodBoolean;
            indexing_paused: z.ZodBoolean;
            embedding_daily_chars: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    usage: z.ZodArray<z.ZodObject<{
        session_id: z.ZodString;
        turn_sequence: z.ZodNumber;
        used_bytes: z.ZodNumber;
        tool_calls: z.ZodNumber;
        writes: z.ZodNumber;
    }, z.core.$strip>>;
    embedding_usage: z.ZodArray<z.ZodObject<{
        workspace_id: z.ZodString;
        day: z.ZodString;
        calls: z.ZodNumber;
        input_chars: z.ZodNumber;
    }, z.core.$strip>>;
    source_candidates: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        session_id: z.ZodString;
        workspace_id: z.ZodString;
        role: z.ZodString;
        content: z.ZodString;
        content_chars: z.ZodNumber;
        status: z.ZodString;
    }, z.core.$strip>>;
    index_pending: z.ZodNumber;
    workspaces: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        instance_id: z.ZodString;
    }, z.core.$strip>>;
    sessions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        workspace_id: z.ZodString;
        task_id: z.ZodNullable<z.ZodString>;
        subscribed: z.ZodNumber;
        cursor: z.ZodNumber;
    }, z.core.$strip>>;
    memories: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        content: z.ZodString;
        kind: z.ZodString;
        session_id: z.ZodString;
        workspace_id: z.ZodString;
        task_id: z.ZodNullable<z.ZodString>;
        importance: z.ZodNumber;
        pinned: z.ZodNumber;
        scope: z.ZodString;
        targets: z.ZodString;
        broadcast: z.ZodNumber;
        vector_enabled: z.ZodNumber;
        status: z.ZodString;
        revision: z.ZodNumber;
        source_ids: z.ZodArray<z.ZodString>;
        evidence_current: z.ZodBoolean;
        evidence_quality: z.ZodNumber;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
    }, z.core.$strip>>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        workspace_id: z.ZodString;
        revision: z.ZodNumber;
        title: z.ZodString;
        goal: z.ZodString;
        constraints: z.ZodArray<z.ZodString>;
        acceptance: z.ZodArray<z.ZodString>;
        status: z.ZodString;
        blockers: z.ZodArray<z.ZodString>;
        decisions: z.ZodArray<z.ZodString>;
        next_action: z.ZodString;
        evidence_ids: z.ZodArray<z.ZodString>;
        verification: z.ZodRecord<z.ZodString, z.ZodObject<{
            source_id: z.ZodString;
            revision: z.ZodNumber;
            method: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    profiles: z.ZodArray<z.ZodObject<{
        workspace_id: z.ZodString;
        revision: z.ZodNumber;
        weights: z.ZodObject<{
            task: z.ZodNumber;
            relevance: z.ZodNumber;
            evidence: z.ZodNumber;
            importance: z.ZodNumber;
            dependency: z.ZodNumber;
            recency: z.ZodNumber;
            redundancy: z.ZodNumber;
            half_life_days: z.ZodNumber;
            limit: z.ZodNumber;
            context_chars: z.ZodNumber;
            min_relevance: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    cursor: z.ZodNumber;
    policy_revision: z.ZodNumber;
    embedding_enabled: z.ZodBoolean;
    memory_count: z.ZodNumber;
    pending_inputs: z.ZodArray<z.ZodObject<{
        session_id: z.ZodString;
        message_id: z.ZodString;
        message: z.ZodObject<{
            content: z.ZodArray<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    fenced_sessions: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export declare const SearchSchema: z.ZodObject<{
    results: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        content: z.ZodString;
        kind: z.ZodString;
        session_id: z.ZodString;
        workspace_id: z.ZodString;
        task_id: z.ZodNullable<z.ZodString>;
        importance: z.ZodNumber;
        pinned: z.ZodNumber;
        scope: z.ZodString;
        targets: z.ZodString;
        broadcast: z.ZodNumber;
        vector_enabled: z.ZodNumber;
        status: z.ZodString;
        revision: z.ZodNumber;
        source_ids: z.ZodArray<z.ZodString>;
        evidence_current: z.ZodBoolean;
        evidence_quality: z.ZodNumber;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
        final_score: z.ZodNumber;
        contributions: z.ZodRecord<z.ZodString, z.ZodNumber>;
        redundancy_penalty: z.ZodNumber;
    }, z.core.$strip>>;
    profile_revision: z.ZodNumber;
}, z.core.$strip>;
export type Search = z.infer<typeof SearchSchema>;
export declare const weightLabels: {
    task: string;
    relevance: string;
    evidence: string;
    importance: string;
    dependency: string;
    recency: string;
};
export type WeightKey = keyof typeof weightLabels;
export declare function rebalance(weights: Weights, key: WeightKey, value: number): Weights;
export declare const statusLabels: Record<string, string>;
export declare const scopeLabels: Record<string, string>;
