/** UI polling only. Host revocation/admission checks retain their own cadence. */
export declare function startVisiblePolling(refresh: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void, surface?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, delay?: number): () => void;
