from concurrent.futures import ThreadPoolExecutor

import pytest
from memory_framework.engine import Engine, DomainError
from memory_framework.models import Weights


@pytest.fixture
def engine(tmp_path):
    e = Engine(tmp_path / "memory.db")
    for wid in ("a", "b"):
        e.execute(
            "workspace.upsert",
            {"id": wid, "name": wid, "path": f"/{wid}", "instance_id": "test"},
            channel="host",
        )
    for sid, wid in (("a1", "a"), ("a2", "a"), ("b1", "b")):
        e.execute("session.upsert", {"id": sid, "workspace_id": wid}, channel="host")
    yield e
    e.close()


def admin(e, op, p=None, sid="a1"):
    return e.execute(op, p, sid, "admin")


def memory(e, text="SQLite 任务状态持久化", scope="session", sid="a1", **kw):
    return admin(e, "memory.create", {"content": text, "scope": scope, **kw}, sid)


def task(e, wid="a"):
    return admin(
        e,
        "task.create",
        {
            "workspace_id": wid,
            "title": "Memory",
            "goal": "完成迁移",
            "constraints": ["不泄漏工作区记忆"],
            "acceptance": ["重启后可恢复"],
        },
    )


def bind(e, sid, tid):
    return admin(
        e, "session.bind", {"session_id": sid, "task_id": tid, "expected_task_id": None}
    )


def test_scope_and_scope_changes_are_authoritative(engine):
    m = memory(engine)
    assert engine.execute("memory.search", {"query": "SQLite"}, "a2")["results"] == []
    m = admin(
        engine,
        "memory.update",
        {"id": m["id"], "expected_revision": 1, "scope": "workspace"},
    )
    assert (
        len(engine.execute("memory.search", {"query": "SQLite"}, "a2")["results"]) == 1
    )
    assert engine.execute("memory.search", {"query": "SQLite"}, "b1")["results"] == []
    m = admin(
        engine,
        "memory.update",
        {"id": m["id"], "expected_revision": 2, "scope": "selected", "targets": ["b"]},
    )
    assert (
        len(engine.execute("memory.search", {"query": "SQLite"}, "b1")["results"]) == 1
    )
    assert engine.execute("memory.search", {"query": "SQLite"}, "a1")["results"] == []


def test_task_handoff_and_restart(engine, tmp_path):
    t = task(engine)
    bind(engine, "a1", t["id"])
    bind(engine, "a2", t["id"])
    memory(engine, scope="task")
    updated = engine.execute(
        "task.update",
        {
            "id": t["id"],
            "expected_revision": 1,
            "next_action": "运行集成测试",
            "status": "active",
        },
        "a1",
    )
    assert engine.execute("task.read", {}, "a2")["revision"] == updated["revision"]
    other = Engine(tmp_path / "memory.db")
    try:
        context = other.execute("context.prepare", {"query": "SQLite"}, "a2", "host")
        assert "运行集成测试" in context["text"]
        assert "不泄漏工作区记忆" in context["text"]
        assert context["memory_ids"]
    finally:
        other.close()


def test_compare_and_swap_prevents_lost_updates(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    bind(engine, "a2", t["id"])

    def update(sid):
        try:
            return engine.execute(
                "task.update",
                {"id": t["id"], "expected_revision": 1, "next_action": sid},
                sid,
            )
        except DomainError as exc:
            return exc.code

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(update, ["a1", "a2"]))
    assert sum(isinstance(r, dict) for r in results) == 1
    assert "revision_conflict" in results


def test_no_model_scope_or_contract_escalation(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    m = memory(engine)
    for op, p in (
        ("memory.update", {"id": m["id"], "expected_revision": 1, "scope": "global"}),
        ("task.update", {"id": t["id"], "expected_revision": 1, "constraints": []}),
        (
            "memory.propose",
            {"content": "x", "scope": "global", "source_ids": m["source_ids"]},
        ),
    ):
        with pytest.raises(DomainError) as ex:
            engine.execute(op, p, "a1")
        assert ex.value.code == "forbidden"


def test_duplicate_ingest_does_not_resurrect_revoked_source(engine):
    event = {
        "session_id": "a1",
        "event_id": "host-event-1",
        "sequence": 1,
        "role": "user",
        "content": "唯一事实",
    }
    first = engine.execute("event.ingest", event, channel="host")
    assert engine.execute("event.ingest", event, channel="host")["duplicate"]
    admin(engine, "source.revoke", {"id": first["id"], "expected_revision": 1})
    assert engine.execute("event.ingest", event, channel="host")["status"] == "revoked"
    assert engine.execute("memory.search", {"query": "唯一事实"}, "a1")["results"] == []
    with pytest.raises(DomainError):
        engine.execute("event.ingest", {**event, "content": "伪造替换"}, channel="host")


def test_revocation_fences_old_context_but_clean_session_can_continue(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    bind(engine, "a2", t["id"])
    m = memory(engine, scope="task")
    engine.execute("context.prepare", {"query": "SQLite"}, "a2", "host")
    admin(engine, "source.revoke", {"id": m["source_ids"][0], "expected_revision": 1})
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]
    with pytest.raises(DomainError) as ex:
        engine.execute("context.prepare", {"query": "SQLite"}, "a2", "host")
    assert ex.value.code == "clean_handoff_required"
    assert engine.execute("context.prepare", {"query": "SQLite"}, "a1", "host")["safe"]


def test_manual_edit_replaces_evidence_and_preserves_history(engine):
    m = memory(engine)
    edited = admin(
        engine,
        "memory.update",
        {"id": m["id"], "expected_revision": 1, "content": "改为 PostgreSQL"},
    )
    assert edited["source_ids"] != m["source_ids"]
    detail = admin(engine, "memory.read", {"id": m["id"]})
    assert detail["sources"][0]["content"] == "改为 PostgreSQL"
    assert detail["history"][0]["content"] == m["content"]
    assert engine.execute("memory.search", {"query": "SQLite"}, "a1")["results"] == []


def test_completion_requires_current_user_acceptance(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    with pytest.raises(DomainError) as ex:
        engine.execute(
            "task.update",
            {"id": t["id"], "expected_revision": 1, "status": "completed"},
            "a1",
        )
    assert ex.value.code == "verification_required"
    t = admin(
        engine,
        "task.verify",
        {
            "id": t["id"],
            "expected_revision": 1,
            "criterion": "重启后可恢复",
            "note": "已在重启测试中确认恢复成功",
        },
    )
    t = engine.execute(
        "task.update",
        {"id": t["id"], "expected_revision": t["revision"], "status": "completed"},
        "a1",
    )
    assert t["status"] == "completed"
    admin(engine, "source.revoke", {"id": t["evidence_ids"][0], "expected_revision": 1})
    assert engine.execute("task.read", {}, "a1")["status"] == "verifying"


@pytest.mark.parametrize("replace_evidence", [False, True])
@pytest.mark.parametrize("already_completed", [False, True])
def test_acceptance_revocation_survives_evidence_edits(
    engine, replace_evidence, already_completed
):
    t = task(engine)
    bind(engine, "a1", t["id"])
    t = admin(
        engine,
        "task.verify",
        {
            "id": t["id"],
            "expected_revision": t["revision"],
            "criterion": t["acceptance"][0],
            "note": "已在重启测试中确认恢复成功",
        },
    )
    acceptance_source = t["verification"][t["acceptance"][0]]["source_id"]
    evidence_ids = memory(engine, scope="task")["source_ids"] if replace_evidence else []
    if already_completed:
        t = engine.execute(
            "task.update",
            {"id": t["id"], "expected_revision": t["revision"], "status": "completed"},
            "a1",
        )
    t = engine.execute(
        "task.update",
        {
            "id": t["id"],
            "expected_revision": t["revision"],
            "status": "completed",
            "evidence_ids": evidence_ids,
        },
        "a1",
    )
    assert t["status"] == "completed"
    assert t["evidence_ids"] == evidence_ids
    assert t["verification"][t["acceptance"][0]]["source_id"] == acceptance_source

    admin(engine, "source.revoke", {"id": acceptance_source, "expected_revision": 1})
    invalidated = engine.execute("task.read", {}, "a1")
    assert invalidated["status"] == "verifying"
    assert invalidated["verification"] == {}
    assert invalidated["revision"] == t["revision"] + 1
    with pytest.raises(DomainError) as ex:
        engine.execute(
            "task.update",
            {
                "id": t["id"],
                "expected_revision": invalidated["revision"],
                "status": "completed",
            },
            "a1",
        )
    assert ex.value.code == "verification_required"


def test_task_move_does_not_grant_old_memory_or_rewrite_session(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    m = memory(engine, scope="task")
    moved = admin(
        engine,
        "task.move",
        {"id": t["id"], "expected_revision": 1, "workspace_id": "b"},
    )
    assert moved["workspace_id"] == "b"
    bind(engine, "b1", t["id"])
    assert engine.execute("memory.search", {"query": "SQLite"}, "b1")["results"] == []
    assert (
        admin(engine, "memory.read", {"id": m["id"]})["memory"]["workspace_id"] == "a"
    )
    with pytest.raises(DomainError):
        bind(engine, "a1", t["id"])


def test_subscription_does_not_grant_access(engine):
    memory(engine, scope="workspace")
    assert engine.execute("events.poll", {"after": 0}, "b1", "host")["events"] == []
    assert engine.execute("events.poll", {"after": 0}, "a2", "host")["events"]
    admin(engine, "session.subscription", {"session_id": "a2", "enabled": False})
    assert engine.execute("events.poll", {"after": 0}, "a2", "host")["events"] == []
    assert engine.execute("memory.search", {"query": "SQLite"}, "a2")["results"]


def test_weight_versions_and_preview_do_not_mutate_profile(engine):
    memory(engine)
    weights = Weights().model_dump()
    weights.update(task=0.1, relevance=0.45)
    preview = admin(engine, "ranking.preview", {"query": "SQLite", "weights": weights})
    assert preview["weights"]["relevance"] == 0.45
    assert (
        engine.execute("memory.search", {"query": "SQLite"}, "a1")["weights"][
            "relevance"
        ]
        == 0.25
    )
    assert (
        admin(
            engine,
            "profile.save",
            {"workspace_id": "a", "expected_revision": 1, "weights": weights},
        )["revision"]
        == 2
    )
    assert len(admin(engine, "profile.history", {"workspace_id": "a"})["history"]) == 1
    with pytest.raises(DomainError):
        admin(
            engine,
            "profile.save",
            {"workspace_id": "a", "expected_revision": 1, "weights": weights},
        )


def test_no_answer_and_budget_preserve_constraints(engine):
    memory(engine)
    assert (
        engine.execute("memory.search", {"query": "unrelated-zebra"}, "a1")["results"]
        == []
    )
    t = task(engine)
    bind(engine, "a1", t["id"])
    memory(engine, "x" * 12000, scope="task", pinned=True)
    memory(engine, "y" * 12000, scope="task", pinned=True)
    with pytest.raises(DomainError) as ex:
        engine.execute("context.prepare", {"query": "x"}, "a1", "host")
    assert ex.value.code == "context_budget_exceeded"


def test_shared_claim_validator_rejects_fabricated_quote(engine):
    m = memory(engine, "原文：使用 SQLite")
    claim = {
        "assertion": "使用Redis",
        "evidence": [{"source_uid": m["source_ids"][0], "quote": "使用Redis"}],
    }
    with pytest.raises(DomainError):
        engine.execute(
            "memory.propose",
            {"content": "Redis", "source_ids": m["source_ids"], "claims": [claim]},
            "a1",
        )


def test_faiss_route_uses_only_eligible_embeddings(engine):
    from memory_framework.retrieval import retrieve
    from memory_framework.database import dump

    m = memory(engine)
    private = memory(engine, "Unrelated private", sid="b1")
    with engine.db.transaction() as db:
        for entry, vector in ((m, [1.0, 0.0]), (private, [1.0, 0.0])):
            db.execute(
                "INSERT INTO embeddings VALUES(?,?,?,?)",
                (entry["id"], 1, "fixture", dump(vector)),
            )
        rows = retrieve(
            db,
            [m],
            "semantic-only",
            Weights(),
            engine._session(db, "a1"),
            [1.0, 0.0],
            "fixture",
        )
        assert [r["id"] for r in rows] == [m["id"]]


def test_tool_reads_and_forked_receipts_preserve_revocation(engine):
    m = memory(engine, scope="workspace")
    result = engine.execute("memory.read", {"id": m["id"]}, "a1")
    engine.execute(
        "context.inherit", {"receipt_id": result["memory_receipt"]}, "a2", "host"
    )
    assert engine.execute("context.check", {}, "a2", "host")["safe"]
    admin(engine, "source.revoke", {"id": m["source_ids"][0], "expected_revision": 1})
    assert not engine.execute("context.check", {}, "a1", "host")["safe"]
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]


def test_fork_receipt_cannot_cross_scope_or_unknown_provenance(engine):
    m = memory(engine)
    receipt = engine.execute("memory.read", {"id": m["id"]}, "a1")["memory_receipt"]
    engine.execute("context.inherit", {"receipt_id": receipt}, "a2", "host")
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]
    engine.execute("context.inherit", {"receipt_id": -1}, "b1", "host")
    assert not engine.execute("context.check", {}, "b1", "host")["safe"]


@pytest.mark.parametrize(
    "tool_name", ["memory_search", "memory_framework_search", "memory_framework_read"]
)
def test_memory_tool_echoes_and_inherited_sources_not_relearned(engine, tool_name):
    engine.execute(
        "event.tool_call", {"call_id": "c1", "name": tool_name}, "a1", "host"
    )
    response = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "2",
            "sequence": 2,
            "role": "tool",
            "content": '{"results":[]}',
            "metadata": {"tool_call_id": "c1"},
        },
        channel="host",
    )
    assert response["ignored"] == "memory_tool_echo"
    response = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "3",
            "sequence": 3,
            "role": "user",
            "content": "old fork text",
            "metadata": {"inherited": True},
        },
        channel="host",
    )
    assert response["ignored"] == "inherited_source_not_republished"
    assert admin(engine, "snapshot")["memory_count"] == 0


def test_pending_input_is_durable_and_admission_is_idempotent(engine, tmp_path):
    message = {
        "id": "p1",
        "source": {"kind": "user"},
        "content": [{"type": "text", "text": "请继续"}],
    }
    engine.execute(
        "pending.capture", {"message_id": "p1", "message": message}, "a1", "host"
    )
    engine.execute(
        "pending.capture", {"message_id": "p1", "message": message}, "a1", "host"
    )
    other = Engine(tmp_path / "memory.db")
    try:
        assert len(admin(other, "snapshot")["pending_inputs"]) == 1
    finally:
        other.close()
    engine.execute("pending.admitted", {"message_id": "p1"}, "a1", "host")
    engine.execute(
        "pending.capture", {"message_id": "p1", "message": message}, "a1", "host"
    )
    assert not admin(engine, "snapshot")["pending_inputs"]


def test_host_correction_revokes_sources_exactly_once(engine):
    event = {
        "session_id": "a1",
        "event_id": "one",
        "sequence": 7,
        "role": "user",
        "content": "old constraint",
    }
    src = engine.execute("event.ingest", event, channel="host")
    correction = {"event_id": "replacement", "start": 7, "end": 7}
    engine.execute("event.revise", correction, "a1", "host")
    engine.execute("event.revise", correction, "a1", "host")
    assert (
        engine.execute("memory.search", {"query": "constraint"}, "a1")["results"] == []
    )
    with engine.db.transaction() as db:
        assert engine._row(db, "sources", src["id"])["revision"] == 2


def test_conflicting_claims_keep_both_sources_without_private_id_leak(engine):
    one = memory(engine, "I choose SQLite")
    two = memory(engine, "I choose Postgres")

    def claim(m, value):
        return {
            "subject_id": "a1",
            "predicate": "database",
            "value": value,
            "qualifier": "self_report",
            "evidence": [{"source_uid": m["source_ids"][0], "quote": m["content"]}],
        }

    c1 = engine.execute(
        "memory.propose",
        {
            "content": "unsupported paraphrase",
            "source_ids": one["source_ids"],
            "claims": [claim(one, "SQLite")],
        },
        "a1",
    )
    c2 = engine.execute(
        "memory.propose",
        {
            "content": "unsupported paraphrase",
            "source_ids": two["source_ids"],
            "claims": [claim(two, "Postgres")],
        },
        "a1",
    )
    assert c2["conflicts_with"] == [c1["id"]]
    assert "unsupported paraphrase" not in c2["content"]
    c1 = admin(
        engine,
        "memory.update",
        {"id": c1["id"], "expected_revision": 1, "scope": "workspace"},
    )
    read = engine.execute("memory.read", {"id": c1["id"]}, "a2")["memory"]
    assert read["conflicts_with"] == []


def test_progress_edit_does_not_invalidate_unchanged_acceptance(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    t = admin(
        engine,
        "task.verify",
        {
            "id": t["id"],
            "expected_revision": 1,
            "criterion": t["acceptance"][0],
            "note": "checked",
        },
    )
    t = admin(
        engine,
        "task.update",
        {
            "id": t["id"],
            "expected_revision": t["revision"],
            "goal": t["goal"],
            "acceptance": t["acceptance"],
            "constraints": t["constraints"],
            "next_action": "report",
        },
    )
    assert t["verification"]


def test_expired_structured_claim_is_not_returned_as_current_fact(engine):
    m = memory(engine, "Temporary rule")
    claim = {
        "subject_id": "a1",
        "predicate": "rule",
        "value": "temporary",
        "qualifier": "self_report",
        "valid_from": 1,
        "valid_to": 2,
        "evidence": [{"source_uid": m["source_ids"][0], "quote": m["content"]}],
    }
    c = engine.execute(
        "memory.propose",
        {"content": "temporary", "source_ids": m["source_ids"], "claims": [claim]},
        "a1",
    )
    assert not c["evidence_current"]
    assert c["id"] not in [
        r["id"]
        for r in engine.execute("memory.search", {"query": "temporary"}, "a1")[
            "results"
        ]
    ]
    with pytest.raises(DomainError):
        engine.execute("memory.read", {"id": c["id"]}, "a1")
