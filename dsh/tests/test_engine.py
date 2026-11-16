from concurrent.futures import ThreadPoolExecutor

import pytest
from memory_framework.engine import Engine, DomainError, sha256_text
from memory_framework.models import Weights
from memory_framework_shared.identity import fingerprint


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


def enable_transcripts(e):
    old = admin(e, "snapshot")["policies"][0]
    admin(e, "policy.save", {
        "workspace_id": old["workspace_id"], "expected_revision": old["revision"],
        "settings": {**old["settings"], "task_transcript_enabled": True},
    })


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
    enable_transcripts(engine)
    t = task(engine)
    bind(engine, "a1", t["id"])
    engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "h1",
            "sequence": 1,
            "role": "user",
            "content": "先把迁移脚本跑通，然后运行集成测试",
        },
        channel="host",
    )
    engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "h2",
            "sequence": 2,
            "role": "assistant",
            "content": "迁移脚本已完成，准备运行集成测试。",
        },
        channel="host",
    )
    bind(engine, "a2", t["id"])
    memory(engine, scope="task")
    updated = engine.execute(
        "task.update",
        {
            "id": t["id"],
            "expected_revision": 1,
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
        assert "SQLite" in context["recall_text"]
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
                {"id": t["id"], "expected_revision": 1, "blockers": [sid]},
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
    search_res = engine.execute("memory.search", {"query": "SQLite"}, "a1")
    assert "weights" not in search_res
    assert "memory_receipt" not in search_res
    assert (
        admin(engine, "ranking.preview", {"query": "SQLite"})["weights"]["relevance"]
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
    assert "memory_receipt" not in result
    engine.execute(
        "context.inherit", {"content_hash": fingerprint(result)}, "a2", "host"
    )
    assert engine.execute("context.check", {}, "a2", "host")["safe"]
    admin(engine, "source.revoke", {"id": m["source_ids"][0], "expected_revision": 1})
    assert not engine.execute("context.check", {}, "a1", "host")["safe"]
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]


def test_fork_receipt_cannot_cross_scope_or_unknown_provenance(engine):
    m = memory(engine)
    result = engine.execute("memory.read", {"id": m["id"]}, "a1")
    engine.execute(
        "context.inherit", {"content_hash": fingerprint(result)}, "a2", "host"
    )
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]
    engine.execute("context.inherit", {"content_hash": "deadbeef"}, "b1", "host")
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
    assert read.get("conflicts_with", []) == []
    assert "conflicts_with" not in read


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
            "blockers": ["report"],
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


def test_dehydrated_context_and_multi_turn_static_prefix_invariance(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    bind(engine, "a2", t["id"])
    pinned = memory(engine, "全局红线：禁止修改数据库表名", scope="task", pinned=True)
    dynamic_one = memory(engine, "SQLite WAL 并发配置说明", scope="task")

    turn1 = engine.execute("context.prepare", {"query": "SQLite WAL"}, "a2", "host")
    # 1. Dehydration checks: zero noisy receipts, timestamps, revisions, or unverified boilerplate
    for noisy in (
        "[memory-receipt:",
        "updated_at",
        "created_at",
        "workspace_id",
        "evidence:quoted_source_not_verified",
        "conflicts:[]",
        " r1 ",
    ):
        assert noisy not in turn1["text"]
        assert noisy not in turn1["recall_text"]

    assert pinned["content"] in turn1["text"]
    assert dynamic_one["content"] not in turn1["text"]
    assert dynamic_one["content"] in turn1["recall_text"]

    # 2. Task status/blockers updates & new cross-session memories must NOT mutate locked static prefix
    engine.execute("turn.begin", {"sequence": 2}, "a2", "host")
    engine.execute(
        "task.update",
        {"id": t["id"], "expected_revision": 1, "status": "waiting", "blockers": ["CI"]},
        "a2",
    )
    dynamic_two = memory(engine, "SQLite 备份恢复流程", scope="task")
    turn2 = engine.execute("context.prepare", {"query": "SQLite 备份"}, "a2", "host")
    assert turn2["text"] == turn1["text"]
    # Previously exposed dynamic_one is deduplicated; only unseen dynamic_two is tail-recalled
    assert dynamic_one["content"] not in turn2["recall_text"]
    assert dynamic_two["content"] in turn2["recall_text"]

    # 3. Repeating the same query yields empty recall_text (zero duplicate injection)
    engine.execute("turn.begin", {"sequence": 3}, "a2", "host")
    turn3 = engine.execute("context.prepare", {"query": "SQLite 备份"}, "a2", "host")
    assert turn3["text"] == turn1["text"]
    assert turn3["recall_text"] == ""

    # 4. Fork inheritance via SHA-256 of tail recall_text preserves revocation safety
    engine.execute("session.upsert", {"id": "a3", "workspace_id": "a"}, channel="host")
    bind(engine, "a3", t["id"])
    engine.execute(
        "context.inherit",
        {"content_hash": sha256_text(turn1["recall_text"])},
        "a3",
        "host",
    )
    assert engine.execute("context.check", {}, "a3", "host")["safe"]
    admin(
        engine,
        "source.revoke",
        {"id": dynamic_one["source_ids"][0], "expected_revision": 1},
    )
    assert not engine.execute("context.check", {}, "a2", "host")["safe"]
    assert not engine.execute("context.check", {}, "a3", "host")["safe"]


def test_self_echo_suppression_even_when_user_memory_mode_all(engine):
    old_policy = admin(engine, "snapshot")["policies"][0]
    admin(
        engine,
        "policy.save",
        {
            "workspace_id": old_policy["workspace_id"],
            "expected_revision": old_policy["revision"],
            "settings": {**old_policy["settings"], "user_memory_mode": "all"},
        },
    )
    engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "u1",
            "sequence": 1,
            "role": "user",
            "content": "本窗口刚刚发出的独特原话鲲鹏展翅",
        },
        channel="host",
    )
    # Automatic context avoids live echoes; explicit search remains available.
    prepared = engine.execute("context.prepare", {"query": "鲲鹏展翅"}, "a1", "host")
    assert prepared["recall_text"] == ""
    assert engine.execute("memory.search", {"query": "鲲鹏展翅"}, "a1")["results"]


def test_handoff_tail_and_backward_transcript_tool(engine):
    enable_transcripts(engine)
    t = task(engine)
    bind(engine, "a1", t["id"])
    # Create 10 messages in a1: early history, a revoked proposal, and a large tool output
    for seq in range(1, 9):
        engine.execute(
            "event.ingest",
            {
                "session_id": "a1",
                "event_id": f"ev-{seq}",
                "sequence": seq,
                "role": "user" if seq % 2 == 1 else "assistant",
                "content": f"第{seq}条对话消息内容",
            },
            channel="host",
        )
    revoked_src = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "ev-9",
            "sequence": 9,
            "role": "assistant",
            "content": "错误提议：直接删库重建",
        },
        channel="host",
    )
    admin(engine, "source.revoke", {"id": revoked_src["id"], "expected_revision": 1})
    engine.execute(
        "event.tool_call", {"call_id": "tc-10", "name": "pytest_runner"}, "a1", "host"
    )
    long_tool = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "ev-10",
            "sequence": 10,
            "role": "tool",
            "content": "PASS " * 200,
            "metadata": {"tool_call_id": "tc-10"},
        },
        channel="host",
    )

    # Bind clean handoff session a2
    bind(engine, "a2", t["id"])
    ctx = engine.execute("context.prepare", {"query": ""}, "a2", "host")
    assert ctx["safe"]
    # Revoked content is masked, not leaked, and does NOT fence a2
    assert "直接删库重建" not in ctx["text"]
    assert "已被否决并剔除" in ctx["text"]
    # Long tool output is folded in the tail preview with its source_id
    assert long_tool["id"] in ctx["text"]
    assert "memory_framework_transcript" in ctx["text"]
    # Early message seq 1 is outside the 8-message tail window
    assert "第1条对话消息内容" not in ctx["text"]
    assert "第8条对话消息内容" in ctx["text"]

    # Model uses transcript.read to paginate backwards into earlier messages
    page1 = engine.execute("transcript.read", {"limit": 5}, "a2")
    assert page1["session_id"] == "a1"
    assert page1["has_more"] is True
    assert page1["entries"][-1]["source_id"] == long_tool["id"]
    assert page1["entries"][-1]["truncated"] is True

    page2 = engine.execute(
        "transcript.read",
        {"session_id": "a1", "before_sequence": page1["next_before_sequence"], "limit": 6},
        "a2",
    )
    assert any("第1条对话消息内容" in e["content"] for e in page2["entries"])

    # Model can expand the folded tool output via source_id
    expanded = engine.execute(
        "transcript.read", {"source_id": long_tool["id"], "offset": 0}, "a2"
    )
    assert expanded["source"]["id"] == long_tool["id"]
    assert expanded["source"]["content"].startswith("PASS PASS")

    # Unauthorized session in another workspace cannot read a1's transcript or source
    with pytest.raises(DomainError) as ex1:
        engine.execute("transcript.read", {"session_id": "a1"}, "b1")
    assert ex1.value.code == "forbidden"
    with pytest.raises(DomainError) as ex2:
        engine.execute("transcript.read", {"source_id": long_tool["id"]}, "b1")
    assert ex2.value.code == "forbidden"
    # Model channel can no longer invoke legacy task.checkpoint
    with pytest.raises(DomainError) as ex3:
        engine.execute("task.checkpoint", {"id": t["id"], "expected_revision": 1}, "a2")
    assert ex3.value.code == "forbidden"


def test_cross_workspace_global_recall_hash_does_not_fence_fork(engine):
    shared_mem = memory(engine, "跨工作区全局架构约定", scope="global", sid="a1")
    # Workspace A session a2 recalls the global memory
    prep_a = engine.execute("context.prepare", {"query": "全局架构约定"}, "a2", "host")
    assert shared_mem["content"] in prep_a["recall_text"]

    # Workspace B binds a task tb and b1 recalls the exact same global memory text
    tb = task(engine, wid="b")
    bind(engine, "b1", tb["id"])
    prep_b = engine.execute("context.prepare", {"query": "全局架构约定"}, "b1", "host")
    assert prep_b["recall_text"] == prep_a["recall_text"]

    # Forking a2 -> a_fork in Workspace A must not collide with b1's task_id or get fenced
    engine.execute("session.upsert", {"id": "a_fork", "workspace_id": "a"}, channel="host")
    engine.execute(
        "context.inherit",
        {"content_hash": sha256_text(prep_a["recall_text"]), "sequence": 4},
        "a_fork",
        "host",
    )
    assert engine.execute("context.check", {}, "a_fork", "host")["safe"]


def test_discard_and_revise_release_exposed_recall_memories(engine):
    m = memory(engine, "可回滚的增量召回条目", scope="workspace", sid="a1")
    first = engine.execute("context.prepare", {"query": "增量召回条目"}, "a2", "host")
    assert m["content"] in first["recall_text"]
    recall_hash = sha256_text(first["recall_text"])

    # 1. Pre-step rejection discards uncommitted recall so retry re-recalls it
    engine.execute("context.discard", {"content_hash": recall_hash}, "a2", "host")
    engine.execute("turn.begin", {"sequence": 2}, "a2", "host")
    retried = engine.execute("context.prepare", {"query": "增量召回条目"}, "a2", "host")
    assert m["content"] in retried["recall_text"]

    # 2. Once committed at seq=12 and later replaced via event.revise, memory becomes recallable again
    engine.execute(
        "context.inherit",
        {"content_hash": sha256_text(retried["recall_text"]), "sequence": 12},
        "a2",
        "host",
    )
    engine.execute("turn.begin", {"sequence": 3}, "a2", "host")
    assert (
        engine.execute("context.prepare", {"query": "增量召回条目"}, "a2", "host")[
            "recall_text"
        ]
        == ""
    )
    engine.execute(
        "event.revise", {"event_id": "edit-1", "start": 10, "end": 15}, "a2", "host"
    )
    engine.execute("turn.begin", {"sequence": 4}, "a2", "host")
    after_revise = engine.execute(
        "context.prepare", {"query": "增量召回条目"}, "a2", "host"
    )
    assert m["content"] in after_revise["recall_text"]


def test_peer_task_evidence_revocation_does_not_fence_unexposed_session(engine):
    t = task(engine)
    bind(engine, "a1", t["id"])
    bind(engine, "a2", t["id"])
    src = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "peer-ev-1",
            "sequence": 1,
            "role": "tool",
            "content": "仅在窗口a1产生的验证证据",
        },
        channel="host",
    )
    # Lock a2's static context first so handoff is already established before peer evidence update
    engine.execute("context.prepare", {"query": ""}, "a2", "host")
    # Create clean a3 after a1's source, Wait: test unexposed task.evidence_ids specifically on a0!
    engine.execute("session.upsert", {"id": "a0", "workspace_id": "a"}, channel="host")
    bind(engine, "a0", t["id"])
    # Pre-lock empty handoff before any sources or test with a2 whose handoff didn't include peer-ev-2:
    src2 = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "peer-ev-2",
            "sequence": 2,
            "role": "tool",
            "content": "窗口a2从未见过的后续证据",
        },
        channel="host",
    )
    engine.execute(
        "task.update",
        {"id": t["id"], "expected_revision": 1, "status": "active", "evidence_ids": [src2["id"]]},
        "a1",
    )
    engine.execute("turn.begin", {"sequence": 2}, "a2", "host")
    engine.execute("context.prepare", {"query": ""}, "a2", "host")
    admin(engine, "source.revoke", {"id": src2["id"], "expected_revision": 1})
    assert engine.execute("context.check", {}, "a2", "host")["safe"]
    assert src["id"]


def test_truncated_search_only_records_returned_exposures_and_flags_unverified_summary(
    engine,
):
    raw_src = engine.execute(
        "event.ingest",
        {
            "session_id": "a1",
            "event_id": "sum-src",
            "sequence": 1,
            "role": "user",
            "content": "原文是一段完全不同的表述但包含关键词赤壁赋",
        },
        channel="host",
    )
    paraphrased = engine.execute(
        "memory.propose",
        {"content": "归纳摘要：苏轼夜游赤壁赋感悟", "source_ids": [raw_src["id"]]},
        "a1",
    )
    admin(
        engine,
        "memory.update",
        {"id": paraphrased["id"], "expected_revision": 1, "scope": "workspace"},
    )
    read_view = engine.execute("memory.read", {"id": paraphrased["id"]}, "a2")["memory"]
    assert read_view.get("epistemic_status") == "unverified_summary"

    # Tight manual budget so search truncates lower-ranked hits; revoking an unseen hit must NOT fence a2
    m_high = memory(
        engine, "高频匹配关键词麒麟瑞兽 " + ("甲" * 120), scope="workspace", importance=0.95
    )
    m_low = memory(
        engine, "高频匹配关键词麒麟瑞兽 " + ("乙" * 600), scope="workspace", importance=0.1
    )
    old_pol = admin(engine, "snapshot")["policies"][0]
    admin(
        engine,
        "policy.save",
        {
            "workspace_id": "a",
            "expected_revision": old_pol["revision"],
            "settings": {
                **old_pol["settings"],
                "context_mode": "manual",
                "evidence_bytes": 4000,
                "automatic_bytes": 1000,
                "source_chars": 700,
            },
        },
    )
    engine.execute("turn.begin", {"sequence": 10}, "a2", "host")
    # Consume most of the 4000B turn budget first so only m_high fits in memory.search
    with engine.db.transaction() as db:
        db.execute("UPDATE evidence_usage SET used_bytes=3350 WHERE session_id='a2'")
    res = engine.execute("memory.search", {"query": "麒麟瑞兽"}, "a2")
    returned_ids = [r["id"] for r in res["results"]]
    assert m_high["id"] in returned_ids
    assert m_low["id"] not in returned_ids
    assert res.get("truncated") is True

    admin(engine, "source.revoke", {"id": m_low["source_ids"][0], "expected_revision": 1})
    assert engine.execute("context.check", {}, "a2", "host")["safe"]
