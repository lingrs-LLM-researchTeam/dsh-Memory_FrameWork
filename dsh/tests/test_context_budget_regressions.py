import pytest
from memory_framework.engine import Engine, DomainError


@pytest.fixture
def e(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "")
    engine = Engine(tmp_path / "audit.db")
    engine.execute(
        "workspace.upsert",
        dict(id="w", name="w", path="/w", instance_id="audit"),
        channel="host",
    )
    for sid in ("a", "b"):
        engine.execute("session.upsert", dict(id=sid, workspace_id="w"), channel="host")
    t = engine.execute(
        "task.create",
        dict(
            workspace_id="w",
            title="长程重构任务",
            goal="完成系统架构升级并确保所有边界条件和回归测试全部通过" * 4,
            constraints=["严禁破坏已有安全不变量与兼容性" * 3],
            acceptance=["所有测试套件均通过且经过人工验收" * 3],
        ),
        channel="admin",
    )
    for sid in ("a", "b"):
        engine.execute(
            "session.bind",
            dict(session_id=sid, task_id=t["id"], expected_task_id=None),
            channel="admin",
        )
    p = engine.execute("snapshot", channel="admin")["policies"][0]
    engine.execute(
        "policy.save",
        dict(
            workspace_id="w",
            expected_revision=p["revision"],
            settings={**p["settings"], "task_transcript_enabled": True},
        ),
        channel="admin",
    )
    yield engine
    engine.close()


def note(e, content, **extra):
    return e.execute(
        "memory.create", dict(content=content, scope="task", **extra), "a", "admin"
    )


@pytest.mark.parametrize("method", ["memory.propose", "source.promote"])
def test_explicitly_saved_memory_remains_searchable(e, method):
    src = e.execute(
        "event.ingest",
        dict(
            session_id="a",
            event_id="one",
            sequence=1,
            role="tool",
            content="Database port is 5432",
        ),
        channel="host",
    )
    if method == "memory.propose":
        e.execute(
            method, dict(content="Database port is 5432", source_ids=[src["id"]]), "a"
        )
    else:
        e.execute(method, dict(id=src["id"]), "a", "admin")
    result = e.execute("memory.search", dict(query="Database port 5432"), "a")
    assert result["results"], "explicitly saved memory is removed by echo filter"


@pytest.mark.parametrize("window", [None, 128000])
@pytest.mark.parametrize("character", ["甲", "A"])
def test_optional_handoff_fits_remaining_byte_budget(e, window, character):
    note(e, "规" * 180, pinned=True)
    if window:
        e.execute(
            "context.sync",
            dict(
                provider="test",
                model="128k",
                context_window=window,
                max_output_tokens=8192,
            ),
            "b",
            "host",
        )
    for seq in range(1, 9):
        e.execute(
            "event.ingest",
            dict(
                session_id="a",
                event_id=str(seq),
                sequence=seq,
                role="assistant",
                content=character * 480,
            ),
            channel="host",
        )
    result = e.execute("context.prepare", dict(query=""), "b", "host")
    assert len(result["text"].encode("utf8")) <= result["budget"]["automatic_bytes"]


def test_unpinned_memory_can_return_to_automatic_recall(e):
    m = note(e, "Unique unpinned rule xyz123", pinned=True)
    first = e.execute("context.prepare", dict(query="xyz123"), "b", "host")
    assert "xyz123" in first["text"]
    e.execute(
        "memory.update",
        dict(id=m["id"], expected_revision=m["revision"], pinned=False),
        "a",
        "admin",
    )
    e.execute("turn.begin", dict(sequence=10), "b", "host")
    result = e.execute("context.prepare", dict(query="xyz123"), "b", "host")
    # Separate assertion: the data is not deleted, and explicit search still finds it.
    assert e.execute("memory.search", dict(query="xyz123"), "b")["results"]
    assert "xyz123" in result["text"] + result.get("recall_text", ""), (
        "only automatic injection is suppressed"
    )


def test_undelivered_preparation_does_not_fence_retry(e):
    m = note(e, "Rule before edit", pinned=True)
    prepared = e.execute("context.prepare", dict(query=""), "b", "host")
    # No host commit, no inherit, and no model call happened.
    e.execute(
        "memory.update",
        dict(id=m["id"], expected_revision=m["revision"], content="Rule after edit"),
        "a",
        "admin",
    )
    assert not e.execute("context.check", {}, "b", "host")["safe"]
    e.execute(
        "context.discard",
        dict(receipt_ids=prepared["prepared_receipt_ids"]),
        "b",
        "host",
    )
    assert e.execute("context.check", {}, "b", "host")["safe"], (
        "preparation alone recorded an exposure"
    )


def test_transcript_small_budget_returns_explicit_exhaustion(e):
    e.execute(
        "event.ingest",
        dict(
            session_id="a", event_id="20", sequence=20, role="user", content="X" * 700
        ),
        channel="host",
    )
    p = e.execute("snapshot", channel="admin")["policies"][0]
    e.execute(
        "policy.save",
        dict(
            workspace_id="w",
            expected_revision=p["revision"],
            settings={
                **p["settings"],
                "context_mode": "manual",
                "evidence_bytes": 4000,
                "automatic_bytes": 1000,
            },
        ),
        channel="admin",
    )
    with e.db.transaction() as db:
        db.execute("UPDATE evidence_usage SET used_bytes=3200 WHERE session_id='b'")
    result = e.execute("transcript.read", dict(session_id="a", limit=1), "b")
    assert result["status"] == "evidence_budget_exhausted"
    assert "next_before_sequence" not in result
