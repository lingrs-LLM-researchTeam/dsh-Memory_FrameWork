from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from memory_framework.engine import Engine


@pytest.fixture
def engine(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "https://example.invalid/embeddings")
    monkeypatch.setenv("MEMORY_EMBEDDING_MODEL", "fake")
    monkeypatch.setenv("MEMORY_EMBEDDING_DIMENSIONS", "2")
    e = Engine(tmp_path / "memory.db")
    e.execute(
        "workspace.upsert",
        {"id": "w", "name": "w", "path": "/w", "instance_id": "test"},
        channel="host",
    )
    e.execute("session.upsert", {"id": "s", "workspace_id": "w"}, channel="host")
    yield e
    e.close()


def memory(e, content):
    return e.execute("memory.create", {"content": content}, "s", "admin")


def change(e, m, action):
    if action in ("embedding_disabled", "indexing_paused"):
        old = e.execute("snapshot", channel="admin")["policies"][0]
        settings = (
            {"embedding_enabled": False}
            if action == "embedding_disabled"
            else {"indexing_paused": True}
        )
        e.execute(
            "policy.save",
            {
                "workspace_id": "w",
                "expected_revision": old["revision"],
                "settings": {**old["settings"], **settings},
            },
            channel="admin",
        )
    elif action == "source_revoked":
        e.execute(
            "source.revoke",
            {"id": m["source_ids"][0], "expected_revision": 1},
            channel="admin",
        )
    else:
        changes = {
            "vector_disabled": {"vector_enabled": False},
            "archived": {"status": "archived"},
            "deleted": {"status": "deleted"},
            "edited": {"content": "replacement note"},
            "scope_changed": {"scope": "workspace"},
        }
        e.execute(
            "memory.update",
            {"id": m["id"], "expected_revision": m["revision"], **changes[action]},
            channel="admin",
        )


def assert_usage(e, texts):
    with e.db.transaction() as db:
        usage = db.execute("SELECT calls,input_chars FROM embedding_usage").fetchall()
        assert sum(row["calls"] for row in usage) == len(texts)
        assert sum(row["input_chars"] for row in usage) == sum(map(len, texts))
        assert db.execute("SELECT COUNT(*) FROM embedding_failures").fetchone()[0] == 0


@pytest.mark.parametrize(
    "action",
    [
        "vector_disabled",
        "archived",
        "deleted",
        "edited",
        "scope_changed",
        "source_revoked",
        "embedding_disabled",
        "indexing_paused",
    ],
)
def test_pending_batch_rechecks_each_memory(engine, monkeypatch, action):
    memory(engine, "first note")
    second = memory(engine, "queued note")
    calls = []

    def embed(text):
        calls.append(text)
        if len(calls) == 1:
            change(engine, second, action)
        return [1.0, 0.0]

    monkeypatch.setattr(engine.embeddings, "embed", embed)
    assert engine.index_pending()["indexed"] == 1
    assert calls == ["first note"]
    assert_usage(engine, calls)

    if action == "edited":
        assert engine.index_pending()["indexed"] == 1
        assert calls == ["first note", "replacement note"]
        assert_usage(engine, calls)


def test_pending_memory_requires_current_evidence(engine, monkeypatch):
    m = memory(engine, "unverified note")
    # A mismatched captured revision must be rejected even if the memory is active.
    with engine.db.transaction() as db:
        db.execute(
            "UPDATE memory_sources SET revision=revision+1 WHERE memory_id=?",
            (m["id"],),
        )
    calls = []
    monkeypatch.setattr(
        engine.embeddings, "embed", lambda text: calls.append(text) or [1.0, 0.0]
    )
    assert engine.index_pending()["indexed"] == 0
    assert calls == []
    assert_usage(engine, calls)


@pytest.mark.parametrize("action", ["vector_disabled", "edited", "source_revoked"])
def test_rechecks_after_waiting_for_embedding_lock(engine, monkeypatch, action):
    m = memory(engine, "waiting note")
    entered = Event()
    original_embed = engine._embed
    calls = []

    def waiting_embed(*args, **kwargs):
        entered.set()
        return original_embed(*args, **kwargs)

    monkeypatch.setattr(engine, "_embed", waiting_embed)
    monkeypatch.setattr(
        engine.embeddings, "embed", lambda text: calls.append(text) or [1.0, 0.0]
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with engine.embedding_lock:
            pending = pool.submit(engine.index_pending)
            assert entered.wait(timeout=5)
            change(engine, m, action)
        assert pending.result(timeout=5)["indexed"] == 0
    assert calls == []
    assert_usage(engine, calls)


def test_revision_changed_in_flight_is_not_published(engine, monkeypatch):
    m = memory(engine, "in-flight note")
    calls = []

    def embed(text):
        calls.append(text)
        change(engine, m, "vector_disabled")
        engine.execute(
            "memory.update",
            {
                "id": m["id"],
                "expected_revision": m["revision"] + 1,
                "vector_enabled": True,
            },
            channel="admin",
        )
        return [1.0, 0.0]

    monkeypatch.setattr(engine.embeddings, "embed", embed)
    assert engine.index_pending()["indexed"] == 0
    assert calls == ["in-flight note"]
    assert_usage(engine, calls)
    with engine.db.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 0
