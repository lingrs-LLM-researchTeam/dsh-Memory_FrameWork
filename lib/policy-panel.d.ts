import type { JsonValue } from "./contracts.js";
import type { Snapshot } from "./ui-models.js";
type Perform = (op: string, payload: Record<string, JsonValue>, sid?: string) => Promise<unknown>;
export declare function PolicyPanel({ snapshot, workspaceId, sessionId, perform, busy, }: {
    snapshot: Snapshot;
    workspaceId: string;
    sessionId: string;
    perform: Perform;
    busy: boolean;
}): import("react/jsx-runtime").JSX.Element | null;
export {};
