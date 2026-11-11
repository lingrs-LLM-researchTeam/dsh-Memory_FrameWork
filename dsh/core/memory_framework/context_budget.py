"""Translate host capacity to a bounded memory allowance, never host call config.

UTF-8 bytes are a deliberately conservative sizing proxy, not tokenizer output.
DSH remains responsible for fitting the complete prompt/history/tools and output.
"""

from .models import HostContext, WorkspacePolicy


def context_budget(policy: WorkspacePolicy, host: HostContext | None, chars: int):
    window = host.context_window if host else None
    output = (
        min(window, host.max_output_tokens or min(8192, window // 4))
        if window and host
        else None
    )
    follows = policy.context_mode == "follow_dsh" and window is not None
    automatic = (
        min(128000, (window - output) * policy.context_share // 100)
        if follows
        else policy.automatic_bytes
    )
    return {
        "mode": "follow_dsh"
        if follows
        else ("unavailable" if policy.context_mode == "follow_dsh" else "manual"),
        "context_window": window,
        "reserved_output_tokens": output,
        "automatic_bytes": automatic,
        "evidence_bytes": automatic + policy.evidence_bytes - policy.automatic_bytes,
        "context_chars": automatic if follows else chars,
    }
