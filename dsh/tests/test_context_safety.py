import pytest
from memory_framework.engine import Engine, DomainError


@pytest.fixture
def e(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "")
    engine = Engine(tmp_path / "review.db")
    engine.execute(
        "workspace.upsert",
        {"id": "w", "name": "w", "path": "/w", "instance_id": "review"},
        channel="host",
    )
    for sid in ("a", "b"):
        engine.execute(
            "session.upsert", {"id": sid, "workspace_id": "w"}, channel="host"
        )
    task = engine.execute(
        "task.create",
        {
            "workspace_id": "w",
            "title": "Review",
            "goal": "Resume safely",
            "constraints": [],
            "acceptance": ["validated"],
        },
        channel="admin",
    )
    for sid in ("a", "b"):
        engine.execute(
            "session.bind",
            {"session_id": sid, "task_id": task["id"], "expected_task_id": None},
            channel="admin",
        )
    policy = engine.execute("snapshot", channel="admin")["policies"][0]
    engine.execute(
        "policy.save",
        {
            "workspace_id": "w",
            "expected_revision": policy["revision"],
            "settings": {**policy["settings"], "task_transcript_enabled": True},
        },
        channel="admin",
    )
    yield engine
    engine.close()


def ingest(e, sid, seq, role, content):
    return e.execute(
        "event.ingest",
        {
            "session_id": sid,
            "event_id": str(seq),
            "sequence": seq,
            "role": role,
            "content": content,
        },
        channel="host",
    )


def test_private_source_does_not_bypass_session_scope(e):
    secret = "PRIVATE_SESSION_ALPHA"
    src = ingest(e, "a", 1, "tool", secret)
    m = e.execute("source.promote", {"id": src["id"]}, "a", "admin")
    assert m["scope"] == "session"
    assert e.execute("memory.search", {"query": secret}, "b")["results"] == []
    try:
        result = e.execute("transcript.read", {"session_id": "a"}, "b")
    except DomainError as exc:
        assert exc.code == "forbidden"
        return
    assert secret not in str(result), (
        "same-task transcript exposes a source explicitly kept session-scoped"
    )


def test_clean_handoff_excludes_derived_text_from_fenced_session(e):
    poison = "OBSOLETE_DELETE_DATABASE_PLAN"
    m = e.execute(
        "memory.create",
        {"content": poison, "scope": "task", "pinned": True},
        "a",
        "admin",
    )
    e.execute("context.prepare", {"query": poison}, "a", "host")
    ingest(e, "a", 10, "assistant", "I will proceed using " + poison)
    e.execute(
        "source.revoke",
        {"id": m["source_ids"][0], "expected_revision": 1},
        channel="admin",
    )
    assert e.execute("context.check", {}, "a", "host")["safe"] is False
    assert e.execute("context.check", {}, "b", "host")["safe"] is True
    result = e.execute("context.prepare", {"query": ""}, "b", "host")
    assert poison not in result["text"], (
        "clean session re-imports derived assistant text from unsafe predecessor"
    )


def test_revised_static_context_reestablishes_exposure(e):
    m = e.execute(
        "memory.create",
        {"content": "PINNED_RULE", "scope": "task", "pinned": True},
        "a",
        "admin",
    )
    first = e.execute("context.prepare", {"query": ""}, "b", "host")
    # Real host flow: the static snapshot is committed at a sequence, then revised out.
    from hashlib import sha256

    e.execute(
        "context.inherit",
        {"content_hash": sha256(first["text"].encode()).hexdigest(), "sequence": 5},
        "b",
        "host",
    )
    e.execute(
        "event.revise", {"event_id": "correction", "start": 5, "end": 5}, "b", "host"
    )
    again = e.execute("context.prepare", {"query": ""}, "b", "host")
    assert "PINNED_RULE" in again["text"]
    e.execute(
        "context.inherit",
        {"content_hash": sha256(again["text"].encode()).hexdigest(), "sequence": 6},
        "b",
        "host",
    )
    assert e.execute("context.check", {}, "b", "host")["safe"] is True, (
        "unchanged valid static context is rejected as unknown after revision"
    )


def test_shared_transcript_revocation_and_policy_change_fence_exposed_reader(e):
    source = ingest(e, "a", 1, "tool", "shared output")
    e.execute("transcript.read", {"source_id": source["id"]}, "b")
    policy = e.execute("snapshot", channel="admin")["policies"][0]
    e.execute(
        "policy.save",
        {
            "workspace_id": "w",
            "expected_revision": policy["revision"],
            "settings": {**policy["settings"], "task_transcript_enabled": False},
        },
        channel="admin",
    )
    assert not e.execute("context.check", {}, "b", "host")["safe"]


def test_legacy_next_action_survives_read_update_and_new_window(e):
    task = e.execute("task.read", {}, "a")
    with e.db.transaction() as db:
        import json

        state = json.loads(
            db.execute("SELECT state FROM tasks WHERE id=?", (task["id"],)).fetchone()[
                0
            ]
        )
        state["next_action"] = "Resume the pending migration"
        db.execute(
            "UPDATE tasks SET state=? WHERE id=?", (json.dumps(state), task["id"])
        )
    updated = e.execute(
        "task.update",
        {"id": task["id"], "expected_revision": task["revision"], "status": "active"},
        "a",
    )
    assert updated["next_action"] == "Resume the pending migration"
    assert (
        "Resume the pending migration"
        in e.execute("context.prepare", {}, "b", "host")["text"]
    )


def test_compaction_refresh_reopens_recall_without_erasing_revocation_history(e):
    m = e.execute(
        "memory.create",
        {"content": "sqlite compact recall", "scope": "task"},
        "a",
        "admin",
    )
    first = e.execute("context.prepare", {"query": "sqlite"}, "b", "host")
    assert m["id"] in first["recall_ids"]
    assert not e.execute("context.prepare", {"query": "sqlite"}, "b", "host")[
        "recall_ids"
    ]
    e.execute("context.refresh", {}, "b", "host")
    assert (
        m["id"]
        in e.execute("context.prepare", {"query": "sqlite"}, "b", "host")["recall_ids"]
    )
    e.execute(
        "source.revoke",
        {"id": m["source_ids"][0], "expected_revision": 1},
        channel="admin",
    )
    assert not e.execute("context.check", {}, "b", "host")["safe"]


def test_transcript_sharing_is_explicit(e):
    ingest(e, "a", 1, "user", "private default conversation")
    policy = e.execute("snapshot", channel="admin")["policies"][0]
    e.execute(
        "policy.save",
        {
            "workspace_id": "w",
            "expected_revision": policy["revision"],
            "settings": {**policy["settings"], "task_transcript_enabled": False},
        },
        channel="admin",
    )
    with pytest.raises(DomainError) as err:
        e.execute("transcript.read", {"session_id": "a"}, "b")
    assert err.value.code == "forbidden"
    assert (
        "private default conversation"
        not in e.execute("context.prepare", {}, "b", "host")["text"]
    )


def test_discard_preserves_committed_exposure(e):
    from hashlib import sha256

    m = e.execute(
        "memory.create",
        {"content": "committed rule", "scope": "task", "pinned": True},
        "a",
        "admin",
    )
    prepared = e.execute("context.prepare", {}, "b", "host")
    e.execute(
        "context.inherit",
        {"content_hash": sha256(prepared["text"].encode()).hexdigest(), "sequence": 5},
        "b",
        "host",
    )
    e.execute(
        "context.discard",
        {"receipt_ids": prepared["prepared_receipt_ids"]},
        "b",
        "host",
    )
    e.execute(
        "source.revoke",
        {"id": m["source_ids"][0], "expected_revision": 1},
        channel="admin",
    )
    assert not e.execute("context.check", {}, "b", "host")["safe"]
