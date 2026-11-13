import math

import pytest
from memory_framework.database import dump
from memory_framework.engine import Engine
from memory_framework.models import Weights
from memory_framework.retrieval import retrieve
from memory_framework_shared.fusion import BM25Result, RRFFusion, VectorResult


@pytest.mark.parametrize("result_type", [BM25Result, VectorResult])
@pytest.mark.parametrize(
    "scores, expected",
    [
        ([], []),
        ([2.0], [1.0]),
        ([2.0, 2.0], [1.0, 1.0]),
        ([2.0, 1.5], [1.0, 0.75]),
        ([2e-12, 1e-12], [1.0, 0.5]),
        ([0.0, 0.0], [0.0, 0.0]),
        ([-1.0, -2.0], [0.0, 0.0]),
        ([2.0, 1.0, 0.0, -1.0], [1.0, 0.5, 0.0, 0.0]),
    ],
)
def test_score_fusion_uses_zero_as_relevance_baseline(result_type, scores, expected):
    results = [result_type(i, score, str(i), {}) for i, score in enumerate(scores)]
    lexical, dense = (results, []) if result_type is BM25Result else ([], results)
    fused = RRFFusion().fuse_scores(lexical, dense, 10)
    assert [r.doc_id for r in fused] == list(range(len(scores)))
    assert [r.rrf_score for r in fused] == pytest.approx(expected)


def test_mixed_score_fusion_preserves_weights_raw_scores_and_bonus():
    lexical = [
        BM25Result(i, score, f"lexical {i}", {"id": i})
        for i, score in [(1, 10.0), (2, 8.0), (3, 2.0)]
    ]
    dense = [
        VectorResult(i, score, f"dense {i}", {"id": i})
        for i, score in [(2, 0.9), (1, 0.45), (4, 0.36)]
    ]
    fusion = RRFFusion()
    fused = fusion.fuse_scores(lexical, dense, 10, bm25_weight=0.25)
    assert [r.doc_id for r in fused] == [2, 1, 4, 3]
    assert [r.rrf_score for r in fused] == pytest.approx([0.95, 0.625, 0.4, 0.2])
    assert (fused[0].bm25_score, fused[0].vector_score) == (8.0, 0.9)
    assert (fused[0].content, fused[0].metadata) == ("lexical 2", {"id": 2})
    assert (fused[2].bm25_score, fused[3].vector_score) == (None, None)
    with_bonus = fusion.fuse_scores(
        lexical, dense, 2, bm25_weight=0.25, agreement_bonus=0.06
    )
    assert [r.doc_id for r in with_bonus] == [2, 1]
    assert [r.rrf_score for r in with_bonus] == pytest.approx([0.99, 0.665])
    # Rank fusion is a separate API and must keep its original RRF formula.
    ranked = fusion.fuse(lexical, dense, 2)
    assert {r.doc_id for r in ranked} == {1, 2}
    assert all(r.rrf_score == pytest.approx(1 / 61 + 1 / 62) for r in ranked)


@pytest.fixture
def engine(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "")
    e = Engine(tmp_path / "memory.db")
    e.execute(
        "workspace.upsert",
        {"id": "a", "name": "a", "path": "/a", "instance_id": "test"},
        channel="host",
    )
    e.execute("session.upsert", {"id": "a1", "workspace_id": "a"}, channel="host")
    yield e
    e.close()


def memory(engine, content):
    return engine.execute("memory.create", {"content": content}, "a1", "admin")


def add_vector(db, entry, score):
    db.execute(
        "INSERT INTO embeddings VALUES(?,?,?,?)",
        (entry["id"], 1, "fixture", dump([score, math.sqrt(1 - score ** 2)])),
    )


@pytest.mark.parametrize("count", [1, 2, 4])
def test_small_lexical_candidate_sets_keep_positive_matches(engine, count):
    entries = [memory(engine, "SQLite " + "persistence " * i) for i in range(count)]
    unrelated = memory(engine, "gardening flowers")
    results = engine.execute("memory.search", {"query": "SQLite"}, "a1")["results"]
    assert {r["id"] for r in results} == {m["id"] for m in entries}
    assert unrelated["id"] not in {r["id"] for r in results}
    assert (
        engine.execute("memory.search", {"query": "unrelated-zebra"}, "a1")["results"]
        == []
    )


def test_small_vector_candidate_set_keeps_matches_above_dense_cutoff(engine):
    entries = [memory(engine, text) for text in ["first", "second", "noise"]]
    with engine.db.transaction() as db:
        for entry, score in zip(entries, [0.9, 0.8, 0.2]):
            add_vector(db, entry, score)
        results = retrieve(
            db, entries, "semantic-only", Weights(),
            engine._session(db, "a1"), [1.0, 0.0], "fixture",
        )
    assert [r["id"] for r in results] == [entries[0]["id"], entries[1]["id"]]
    assert [r["features"]["relevance"] for r in results] == pytest.approx(
        [1.0, 0.8 / 0.9]
    )


def test_mixed_retrieval_keeps_weakest_overlap_and_single_route_matches(engine):
    entries = [
        memory(engine, text)
        for text in [
            "SQLite", "SQLite persistence", "SQLite backup", "semantic storage", "noise"
        ]
    ]
    with engine.db.transaction() as db:
        for entry, score in zip(entries, [0.8, 0.7, None, 0.9, 0.2]):
            if score is not None:
                add_vector(db, entry, score)
        results = retrieve(
            db, entries, "SQLite", Weights(),
            engine._session(db, "a1"), [1.0, 0.0], "fixture",
        )
    assert {r["id"] for r in results} == {m["id"] for m in entries[:4]}
    assert all(r["features"]["relevance"] >= Weights().min_relevance for r in results)


def test_relevance_threshold_still_filters_weak_matches(engine):
    entries = [memory(engine, "SQLite"), memory(engine, "SQLite " + "filler " * 200)]
    with engine.db.transaction() as db:
        session = engine._session(db, "a1")
        all_hits = retrieve(db, entries, "SQLite", Weights(min_relevance=0), session)
        relevance = {r["id"]: r["features"]["relevance"] for r in all_hits}
        assert 0 < relevance[entries[1]["id"]] < relevance[entries[0]["id"]]
        strict = retrieve(db, entries, "SQLite", Weights(min_relevance=0.9), session)
    assert [r["id"] for r in strict] == [entries[0]["id"]]


def test_default_relevance_threshold_still_filters_very_weak_matches(engine):
    query = " ".join(f"term{i}" for i in range(80))
    entries = [memory(engine, query), memory(engine, "term0 " + "filler " * 1000)]
    with engine.db.transaction() as db:
        session = engine._session(db, "a1")
        all_hits = retrieve(db, entries, query, Weights(min_relevance=0), session)
        weak = next(r for r in all_hits if r["id"] == entries[1]["id"])
        assert 0 < weak["features"]["relevance"] < Weights().min_relevance
        results = retrieve(db, entries, query, Weights(), session)
    assert [r["id"] for r in results] == [entries[0]["id"]]
