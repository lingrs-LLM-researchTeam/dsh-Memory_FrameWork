"""Strict wire contracts. Identity always comes from the host adapter."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Workspace(Contract):
    id: str = Field(min_length=1, max_length=500)
    name: str = Field(min_length=1, max_length=200)
    path: str = Field(max_length=2000)
    instance_id: str = Field(min_length=1, max_length=200)


class Session(Contract):
    id: str = Field(min_length=1, max_length=500)
    workspace_id: str = Field(min_length=1, max_length=500)


class Ingest(Contract):
    session_id: str
    event_id: str = Field(min_length=1, max_length=500)
    sequence: int = Field(ge=0)
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1, max_length=200000)
    metadata: dict = Field(default_factory=dict)


class MemoryCreate(Contract):
    content: str = Field(min_length=1, max_length=12000)
    kind: Literal["fact", "decision", "constraint", "preference", "note", "summary"] = (
        "note"
    )
    importance: float = Field(default=0.5, ge=0, le=1)
    source_ids: list[str] = Field(default_factory=list, max_length=50)
    scope: Literal["session", "task", "workspace", "selected", "global"] = "session"
    targets: list[str] = Field(default_factory=list, max_length=100)
    pinned: bool = False
    broadcast: bool = True
    vector_enabled: bool = True
    claims: list[dict] = Field(default_factory=list, max_length=30)


class MemoryUpdate(Contract):
    id: int
    expected_revision: int = Field(ge=1)
    content: str | None = Field(default=None, min_length=1, max_length=12000)
    importance: float | None = Field(default=None, ge=0, le=1)
    pinned: bool | None = None
    scope: Literal["session", "task", "workspace", "selected", "global"] | None = None
    targets: list[str] | None = Field(default=None, max_length=100)
    broadcast: bool | None = None
    vector_enabled: bool | None = None
    status: Literal["active", "archived", "deleted"] | None = None


class TaskCreate(Contract):
    workspace_id: str
    title: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=8000)
    constraints: list[str] = Field(default_factory=list, max_length=50)
    acceptance: list[str] = Field(default_factory=list, max_length=50)


class TaskUpdate(Contract):
    id: str
    expected_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    goal: str | None = Field(default=None, min_length=1, max_length=8000)
    constraints: list[str] | None = Field(default=None, max_length=50)
    acceptance: list[str] | None = Field(default=None, max_length=50)
    blockers: list[str] | None = Field(default=None, max_length=50)
    decisions: list[str] | None = Field(default=None, max_length=100)
    next_action: str | None = Field(default=None, max_length=4000)
    status: (
        Literal[
            "planned",
            "active",
            "waiting",
            "blocked",
            "verifying",
            "completed",
            "cancelled",
        ]
        | None
    ) = None
    evidence_ids: list[str] | None = Field(default=None, max_length=100)


class Weights(Contract):
    task: float = Field(default=0.30, ge=0, le=1)
    relevance: float = Field(default=0.25, ge=0, le=1)
    evidence: float = Field(default=0.20, ge=0, le=1)
    importance: float = Field(default=0.10, ge=0, le=1)
    dependency: float = Field(default=0.10, ge=0, le=1)
    recency: float = Field(default=0.05, ge=0, le=1)
    redundancy: float = Field(default=0.15, ge=0, le=1)
    half_life_days: float = Field(default=60, ge=1, le=36500)
    limit: int = Field(default=8, ge=1, le=40)
    context_chars: int = Field(default=16000, ge=2000, le=64000)
    min_relevance: float = Field(default=0.05, ge=0, le=1)

    @model_validator(mode="after")
    def normalized(self):
        total = sum(
            getattr(self, k)
            for k in (
                "task",
                "relevance",
                "evidence",
                "importance",
                "dependency",
                "recency",
            )
        )
        if abs(total - 1) > 0.001:
            raise ValueError("六项正向权重之和必须为 1")
        return self


class ProfileUpdate(Contract):
    workspace_id: str
    expected_revision: int = Field(ge=1)
    weights: Weights


class Dispatch(Contract):
    operation: str = Field(min_length=1, max_length=100)
    session_id: str | None = Field(default=None, max_length=500)
    payload: dict = Field(default_factory=dict)


class WorkspacePolicy(Contract):
    context_mode: Literal["follow_dsh", "manual"] = "follow_dsh"
    context_share: int = Field(default=10, ge=1, le=20)
    evidence_bytes: int = Field(default=32000, ge=4000, le=256000)
    automatic_bytes: int = Field(default=12000, ge=1000, le=128000)
    max_tool_calls: int = Field(default=12, ge=1, le=50)
    max_writes: int = Field(default=3, ge=0, le=20)
    source_chars: int = Field(default=2000, ge=100, le=12000)
    tool_memory_mode: Literal["evidence_only", "allowlist", "all"] = "evidence_only"
    tool_allowlist: list[str] = Field(default_factory=list, max_length=100)
    tool_max_chars: int = Field(default=4000, ge=100, le=12000)
    tool_include_errors: bool = False
    embedding_enabled: bool = True
    indexing_paused: bool = False
    embedding_daily_chars: int = Field(default=200000, ge=1000, le=10000000)

    @model_validator(mode="after")
    def reserve_tool_capacity(self):
        if self.automatic_bytes > self.evidence_bytes - 2000:
            raise ValueError("自动注入预算须至少为工具留出 2000 字节")
        if any(not x.strip() or len(x) > 200 for x in self.tool_allowlist):
            raise ValueError("工具名称不能为空或超过 200 字符")
        return self


class PolicyUpdate(Contract):
    workspace_id: str
    expected_revision: int = Field(ge=1)
    settings: WorkspacePolicy


class HostContext(Contract):
    provider: str = Field(min_length=1, max_length=300)
    model: str = Field(min_length=1, max_length=300)
    context_window: int | None = Field(default=None, strict=True, gt=0, le=100000000)
    max_output_tokens: int | None = Field(default=None, strict=True, gt=0, le=100000000)
