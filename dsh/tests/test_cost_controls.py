import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

from memory_framework.engine import Engine, DomainError
from memory_framework.retrieval import Embeddings


def setup(path):
    e = Engine(path)
    e.execute(
        "workspace.upsert",
        {"id": "w", "name": "w", "path": "/w", "instance_id": "test"},
        channel="host",
    )
    e.execute("session.upsert", {"id": "s", "workspace_id": "w"}, channel="host")
    return e


def ingest(e, content, role="user", event="1", **metadata):
    return e.execute(
        "event.ingest",
        {
            "session_id": "s",
            "event_id": event,
            "sequence": 1,
            "role": role,
            "content": content,
            "metadata": metadata,
        },
        channel="host",
    )


def policy(e, **changes):
    old = e.execute("snapshot", channel="admin")["policies"][0]
    return e.execute(
        "policy.save",
        {
            "workspace_id": "w",
            "expected_revision": old["revision"],
            "settings": {**old["settings"], **changes},
        },
        channel="admin",
    )


def test_stable_snapshot_across_restart_and_real_changes(tmp_path):
    path = tmp_path / "db"
    e = setup(path)
    ingest(e, "SQLite task constraint")
    a = e.execute("context.prepare", {"query": "SQLite"}, "s", "host")
    b = e.execute("context.prepare", {"query": "SQLite"}, "s", "host")
    assert a["text"] == b["text"]
    e.close()
    e = Engine(path)
    assert (
        e.execute("context.prepare", {"query": "SQLite"}, "s", "host")["text"]
        == a["text"]
    )
    e.execute(
        "memory.update",
        {"id": 1, "expected_revision": 1, "importance": 0.9},
        "s",
        "admin",
    )
    assert (
        e.execute("context.prepare", {"query": "SQLite"}, "s", "host")["text"]
        != a["text"]
    )
    e.close()


def test_metadata_edits_and_restart_do_not_reembed(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "https://example.invalid/embeddings")
    monkeypatch.setenv("MEMORY_EMBEDDING_MODEL", "fake")
    monkeypatch.setenv("MEMORY_EMBEDDING_DIMENSIONS", "0")
    calls = []

    def embed(self, text):
        calls.append(text)
        self.dimensions = 3
        return [1.0, 0.0, 0.0]

    with patch.object(Embeddings, "embed", embed):
        e = setup(tmp_path / "db")
        ingest(e, "original")
        assert e.index_pending()["indexed"] == 1
        e.execute(
            "memory.update",
            {
                "id": 1,
                "expected_revision": 1,
                "importance": 0.8,
                "scope": "workspace",
                "broadcast": False,
            },
            "s",
            "admin",
        )
        assert e.index_pending()["indexed"] == 0
        e.close()
        e = Engine(tmp_path / "db")
        assert e.index_pending()["indexed"] == 0
        e.execute(
            "memory.update",
            {"id": 1, "expected_revision": 2, "content": "changed"},
            "s",
            "admin",
        )
        assert e.index_pending()["indexed"] == 1
        assert calls == ["original", "changed"]
        e.close()


def test_tool_output_is_evidence_only_until_explicit_promotion(tmp_path):
    e = setup(tmp_path / "db")
    source = ingest(e, "durable tool result", "tool")
    assert e.execute("snapshot", channel="admin")["memories"] == []
    e.execute("source.promote", {"id": source["id"]}, "s", "admin")
    assert len(e.execute("snapshot", channel="admin")["memories"]) == 1
    policy(e, tool_memory_mode="allowlist", tool_allowlist=["test_runner"])
    e.execute(
        "event.tool_call", {"call_id": "call", "name": "test_runner"}, "s", "host"
    )
    ingest(e, "passed test", "tool", "2", tool_call_id="call")
    ingest(e, "failed test", "tool", "3", tool_call_id="call", is_error=True)
    assert len(e.execute("snapshot", channel="admin")["memories"]) == 2
    with pytest.raises(DomainError):
        e.execute("policy.save", {"workspace_id": "w"}, "s")
    e.close()


def test_source_paging_total_budget_and_host_only_turn_reset(tmp_path):
    e = setup(tmp_path / "db")
    ingest(e, "中文" * 100000)
    policy(
        e,
        evidence_bytes=12000,
        automatic_bytes=4000,
        max_tool_calls=3,
        source_chars=800,
    )
    first = e.execute("memory.read", {"id": 1}, "s")
    assert len(json.dumps(first, ensure_ascii=False).encode()) < 12000
    source = first["sources"][0]
    assert (
        source["content"] == ("中文" * 100000)[source["offset"] : source["next_offset"]]
    )
    assert source["truncated"] and source["total_chars"] == 200000
    second = e.execute(
        "memory.read",
        {"id": 1, "source_id": source["id"], "offset": source["next_offset"]},
        "s",
    )
    assert second["sources"][0]["offset"] == source["next_offset"]
    with pytest.raises(DomainError):
        e.execute("turn.begin", {"sequence": 10}, "s")
    e.execute("turn.begin", {"sequence": 10}, "s", "host")
    e.execute("memory.read", {"id": 1}, "s")
    e.execute("turn.begin", {"sequence": 10}, "s", "host")
    usage = e.execute("snapshot", channel="admin")["usage"][0]
    assert usage["tool_calls"] == 1
    e.close()


def test_parallel_calls_cannot_overspend(tmp_path):
    e = setup(tmp_path / "db")
    ingest(e, "test evidence")
    policy(e, max_tool_calls=2)

    def read(_):
        try:
            return e.execute("memory.read", {"id": 1}, "s")
        except DomainError as ex:
            return ex.code

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(read, range(5)))
    assert sum(isinstance(x, dict) for x in results) == 2
    assert results.count("evidence_budget_exhausted") == 3
    e.close()


def test_query_cache_and_daily_quota_survive_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "https://audit.invalid/embeddings")
    monkeypatch.setenv("MEMORY_EMBEDDING_MODEL", "fake")
    calls = []

    def embed(self, text):
        calls.append(text)
        self.dimensions = 2
        return [1.0, 0.0]

    with patch.object(Embeddings, "embed", embed):
        e = setup(tmp_path / "db")
        ingest(e, "a" * 600)
        policy(e, embedding_daily_chars=1000)
        assert e.index_pending()["indexed"] == 1
        for _ in range(2):
            e.execute("ranking.preview", {"query": "query"}, "s", "admin")
        assert e.dense_index.builds == 1
        e.execute(
            "memory.update",
            {"id": 1, "expected_revision": 1, "importance": 0.9},
            "s",
            "admin",
        )
        e.execute("ranking.preview", {"query": "query"}, "s", "admin")
        assert e.dense_index.builds == 1
        assert len(calls) == 2
        ingest(e, "b" * 600, event="2")
        assert e.index_pending()["indexed"] == 0
        e.close()
        e = Engine(tmp_path / "db")
        assert e.index_pending()["indexed"] == 0
        e.close()


def test_paused_workspace_does_not_starve_other_workspaces(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "https://audit.invalid/embeddings")
    monkeypatch.setenv("MEMORY_EMBEDDING_MODEL", "fake")
    e = setup(tmp_path / "db")
    ingest(e, "paused")
    policy(e, indexing_paused=True)
    e.execute(
        "workspace.upsert",
        {"id": "other", "name": "other", "path": "/other", "instance_id": "test"},
        channel="host",
    )
    e.execute("session.upsert", {"id": "s2", "workspace_id": "other"}, channel="host")
    e.execute("memory.create", {"content": "ready"}, "s2", "admin")
    with patch.object(Embeddings, "embed", return_value=[1.0, 0.0]) as embed:
        assert e.index_pending(limit=1)["indexed"] == 1
        embed.assert_called_once_with("ready")
    e.close()


def test_schema_upgrade_and_policy_conflict(tmp_path):
    e = setup(tmp_path / "db")
    ingest(e, "old source")
    with e.db.transaction() as db:
        db.execute("ALTER TABLE memories DROP COLUMN vector_enabled")
        db.execute("UPDATE meta SET value=1 WHERE key='schema'")
    e.close()
    e = Engine(tmp_path / "db")
    assert e.execute("snapshot", channel="admin")["memories"][0]["vector_enabled"] == 1
    old = e.execute("snapshot", channel="admin")["policies"][0]
    policy(e, max_tool_calls=2)
    with pytest.raises(DomainError) as error:
        e.execute(
            "policy.save",
            {
                "workspace_id": "w",
                "expected_revision": old["revision"],
                "settings": old["settings"],
            },
            channel="admin",
        )
    assert error.value.code == "revision_conflict"
    e.close()


def test_large_write_returns_ack_instead_of_ambiguous_budget_error(tmp_path):
    e = setup(tmp_path / "db")
    src = ingest(e, "source")
    policy(e, evidence_bytes=4000, automatic_bytes=1000)
    result = e.execute(
        "memory.propose", {"content": "资料" * 3000, "source_ids": [src["id"]]}, "s"
    )
    assert result["action_applied"] and result["id"]
    assert len(json.dumps(result, ensure_ascii=False).encode()) < 4000
    assert len(e.execute("snapshot", channel="admin")["memories"]) == 2
    e.close()


def test_tool_dedup_preserves_user_repetitions_and_new_task_evidence(tmp_path):
    e = setup(tmp_path / "db")
    policy(e, tool_memory_mode="all")
    ingest(e, "same observation", "tool", "1")
    ingest(e, "same observation", "user", "2")
    task = e.execute(
        "task.create",
        {
            "workspace_id": "w",
            "title": "new task",
            "goal": "verify current work",
            "constraints": [],
            "acceptance": [],
        },
        channel="admin",
    )
    e.execute(
        "session.bind",
        {"session_id": "s", "task_id": task["id"], "expected_task_id": None},
        channel="admin",
    )
    ingest(e, "same observation", "tool", "3")
    ingest(e, "same observation", "tool", "4")
    memories = e.execute("snapshot", channel="admin")["memories"]
    assert len(memories) == 3
    assert any(m["task_id"] == task["id"] for m in memories)
    with e.db.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 4
    e.close()
