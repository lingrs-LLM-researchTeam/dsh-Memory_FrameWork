import json

import pytest

from memory_framework.engine import DomainError, Engine
from test_cost_controls import setup, policy


def sync(e, window=384000, sid="s", output=8192):
    return e.execute(
        "context.sync",
        {
            "provider": "local-test",
            "model": str(window),
            "context_window": window,
            "max_output_tokens": output,
        },
        sid,
        "host",
    )


def test_follow_host_keeps_long_contract_and_stable_receipt(tmp_path):
    e = setup(tmp_path / "db")
    task = e.execute(
        "task.create",
        {"workspace_id": "w", "title": "长程任务", "goal": "完整约束" * 1800},
        channel="admin",
    )
    e.execute(
        "session.bind",
        {"session_id": "s", "task_id": task["id"], "expected_task_id": None},
        channel="admin",
    )
    with pytest.raises(DomainError, match="超出记忆配额"):
        e.execute("context.prepare", {}, "s", "host")
    budget = sync(e)
    assert budget["automatic_bytes"] == 37580
    assert budget["evidence_bytes"] == 57580
    prepared = e.execute("context.prepare", {}, "s", "host")
    assert task["goal"] in prepared["text"]
    assert len(prepared["text"].encode()) > 12000
    assert prepared["context_chars"] == budget["automatic_bytes"]
    e.close()
    e = Engine(tmp_path / "db")
    assert e.execute("context.prepare", {}, "s", "host")["text"] == prepared["text"]
    sync(e, 12000)
    with pytest.raises(DomainError, match="超出记忆配额"):
        e.execute("context.prepare", {}, "s", "host")
    e.close()


def test_windows_output_caps_unknown_models_and_manual_mode(tmp_path):
    e = setup(tmp_path / "db")
    e.execute("session.upsert", {"id": "s2", "workspace_id": "w"}, channel="host")
    assert sync(e, 500000, output=100000)["automatic_bytes"] == 40000
    assert sync(e, 32000, "s2", 8000)["automatic_bytes"] == 2400
    snapshot = e.execute("snapshot", channel="admin")
    assert [c["context_window"] for c in snapshot["contexts"]] == [500000, 32000]
    assert sync(e, None)["mode"] == "unavailable"
    assert sync(e, None)["automatic_bytes"] == 12000
    policy(e, context_mode="manual", automatic_bytes=15000)
    assert sync(e, 500000)["automatic_bytes"] == 15000
    policy(e, context_mode="follow_dsh", context_share=20)
    assert sync(e, 10000000)["automatic_bytes"] == 128000
    assert sync(e, 1000, output=2000)["automatic_bytes"] == 0
    e.close()


def test_host_facts_and_first_run_advice_are_not_model_writable(tmp_path):
    path = tmp_path / "db"
    e = setup(path)
    assert not e.execute("onboarding.read", channel="host")["context_advice_ack"]
    for operation, payload, channel in [
        ("context.sync", {}, "model"),
        ("onboarding.ack", {}, "model"),
        ("onboarding.ack", {}, "host"),
    ]:
        with pytest.raises(DomainError) as ex:
            e.execute(operation, payload, "s", channel)
        assert ex.value.code == "forbidden"
    e.execute("onboarding.ack", channel="admin")
    e.close()
    e = Engine(path)
    assert e.execute("snapshot", channel="admin")["onboarding"]["context_advice_ack"]
    e.close()


def test_old_policy_json_defaults_to_follow_without_erasing_limits(tmp_path):
    path = tmp_path / "db"
    e = setup(path)
    with e.db.transaction() as db:
        old = json.loads(
            db.execute("SELECT settings FROM workspace_policies").fetchone()[0]
        )
        old.pop("context_mode")
        old.pop("context_share")
        old["max_tool_calls"] = 7
        db.execute("UPDATE workspace_policies SET settings=?", (json.dumps(old),))
        db.execute("UPDATE meta SET value=2 WHERE key='schema'")
    e.close()
    e = Engine(path)
    saved = e.execute("snapshot", channel="admin")["policies"][0]["settings"]
    assert saved["context_mode"] == "follow_dsh"
    assert saved["max_tool_calls"] == 7
    assert sync(e)["automatic_bytes"] > 12000
    with e.db.transaction() as db:
        assert (
            db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()[0] == 3
        )
    e.close()


def test_adaptive_injection_and_tools_share_one_enforced_ledger(tmp_path):
    e = setup(tmp_path / "db")
    sync(e)
    e.execute("memory.create", {"content": "数据" * 5000, "pinned": True}, "s", "admin")
    result = e.execute("context.prepare", {}, "s", "host")
    used = len(result["text"].encode())
    read = e.execute("memory.read", {"id": 1}, "s")
    assert e.execute("snapshot", channel="admin")["usage"][0]["used_bytes"] > used
    assert read["memory"]["id"] == 1
    sync(e, 32000)
    with pytest.raises(DomainError) as ex:
        e.execute("memory.read", {"id": 1}, "s")
    assert ex.value.code == "evidence_budget_exhausted"
    e.close()
