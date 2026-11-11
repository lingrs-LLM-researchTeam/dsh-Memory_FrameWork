"""Shared legacy fusion, Chinese BM25 and optional real FAISS embeddings."""

import json
import math
import os
import re
import time

import jieba
from memory_framework_shared.fusion import BM25Result, VectorResult, RRFFusion
from memory_framework_shared.tokenization import with_cjk_bigrams
from memory_framework_shared.identity import fingerprint


def tokens(text):
    return with_cjk_bigrams(
        [x.lower() for x in jieba.lcut(text) if re.search(r"\w", x)], text
    )


class Embeddings:
    """OpenAI-compatible embedding endpoint, opt-in; credentials stay in the daemon."""

    def __init__(self):
        self.url = os.environ.get("MEMORY_EMBEDDING_URL", "").rstrip("/")
        self.model = os.environ.get("MEMORY_EMBEDDING_MODEL", "")
        self.key = os.environ.get("MEMORY_EMBEDDING_KEY", "")
        self.revision = os.environ.get("MEMORY_EMBEDDING_REVISION", "1")
        self.expected_dimensions = int(
            os.environ.get("MEMORY_EMBEDDING_DIMENSIONS", "0")
        )
        self.dimensions = self.expected_dimensions

    @property
    def config_key(self):
        return fingerprint(
            [self.url, self.model, self.revision, self.expected_dimensions]
        )

    @property
    def fingerprint(self):
        return fingerprint(
            [self.url, self.model, self.revision, self.dimensions, "l2-normalized-v1"]
        )

    @property
    def enabled(self):
        return bool(self.url and self.model)

    def embed(self, text):
        import httpx

        response = httpx.post(
            self.url,
            json={"model": self.model, "input": text},
            headers={"Authorization": f"Bearer {self.key}"},
            timeout=15,
        )
        response.raise_for_status()
        vector = response.json()["data"][0]["embedding"]
        if (
            not vector
            or len(vector) > 65536
            or any(
                not isinstance(x, (float, int)) or not math.isfinite(x) for x in vector
            )
        ):
            raise ValueError("Invalid embedding vector")
        if self.expected_dimensions and self.expected_dimensions != len(vector):
            raise ValueError("Embedding dimension mismatch")
        self.dimensions = len(vector)
        length = math.sqrt(sum(x * x for x in vector))
        if length <= 0:
            raise ValueError("Zero embedding vector")
        return [x / length for x in vector]


class DenseIndex:
    """One bounded in-memory index; current eligible IDs are part of its identity."""

    def __init__(self):
        self.key = None
        self.index = None
        self.ids = []
        self.builds = 0

    def search(self, db, by_id, embedding, model_fingerprint):
        import faiss
        import numpy as np

        generation = db.execute(
            "SELECT value FROM meta WHERE key='vectors'"
        ).fetchone()[0]
        key = (generation, model_fingerprint, len(embedding), tuple(sorted(by_id)))
        if key != self.key:
            vectors, self.ids = [], []
            for row in db.execute(
                "SELECT e.* FROM embeddings e JOIN allowed_memory a ON a.id=e.memory_id WHERE fingerprint=?",
                (model_fingerprint,),
            ):
                memory = by_id.get(row["memory_id"])
                if (
                    memory
                    and memory["vector_enabled"]
                    and memory["revision"] == row["revision"]
                ):
                    v = json.loads(row["vector"])
                    if len(v) == len(embedding):
                        self.ids.append(memory["id"])
                        vectors.append(v)
            self.index = faiss.IndexFlatIP(len(embedding))
            if vectors:
                self.index.add(np.asarray(vectors, dtype="float32"))
            self.key = key
            self.builds += 1
        if not self.ids:
            return []
        scores, positions = self.index.search(
            np.asarray([embedding], dtype="float32"), min(200, len(self.ids))
        )
        return [
            VectorResult(self.ids[p], float(score), by_id[self.ids[p]]["content"], {})
            for score, p in zip(scores[0], positions[0])
            if p >= 0 and score >= 0.35
        ]


def retrieve(
    db,
    eligible,
    query,
    weights,
    session,
    embedding=None,
    model_fingerprint="",
    dense_index=None,
):
    """Rank only authorized, current evidence. Never send unauthorized text to reranking."""
    if not query.strip() or not eligible:
        return []
    by_id = {m["id"]: m for m in eligible}
    db.execute("CREATE TEMP TABLE IF NOT EXISTS allowed_memory(id INTEGER PRIMARY KEY)")
    db.execute("DELETE FROM allowed_memory")
    db.executemany("INSERT INTO allowed_memory VALUES(?)", ((i,) for i in by_id))
    query_tokens = tokens(query)[:80]
    expression = " OR ".join(
        '"' + t.replace('"', '""') + '"' for t in dict.fromkeys(query_tokens)
    )
    lexical = []
    if expression:
        # Filtering joins the candidate IDs before the limit; private hits cannot crowd out eligible hits.
        db.execute(
            "CREATE TEMP TABLE IF NOT EXISTS allowed_memory(id INTEGER PRIMARY KEY)"
        )
        db.execute("DELETE FROM allowed_memory")
        db.executemany("INSERT INTO allowed_memory VALUES(?)", ((i,) for i in by_id))
        rows = db.execute(
            "SELECT memory_id,bm25(memory_fts) score FROM memory_fts JOIN allowed_memory a ON a.id=memory_fts.memory_id WHERE memory_fts MATCH ? ORDER BY score LIMIT 200",
            (expression,),
        ).fetchall()
        lexical = [
            BM25Result(int(r[0]), -float(r[1]), by_id[int(r[0])]["content"], {})
            for r in rows
        ]
    dense = []
    if embedding:
        dense = (dense_index or DenseIndex()).search(
            db, by_id, embedding, model_fingerprint
        )
    fused = RRFFusion().fuse_scores(lexical, dense, 300, bm25_weight=0.5)
    now = time.time()
    ranked = []
    for hit in fused:
        m = dict(by_id[hit.doc_id])
        relevance = min(1.0, max(0.0, hit.rrf_score))
        if relevance < weights.min_relevance:
            continue
        features = {
            "task": float(
                bool(session.get("task_id") and m["task_id"] == session["task_id"])
            ),
            "relevance": relevance,
            "evidence": m["evidence_quality"],
            "importance": m["importance"],
            "dependency": float(
                m["kind"] in ("constraint", "decision")
                and m["task_id"] == session.get("task_id")
                and bool(m["task_id"])
            ),
            "recency": math.exp(
                -math.log(2)
                * max(0, now - m["updated_at"])
                / (86400 * weights.half_life_days)
            ),
        }
        contributions = {k: v * getattr(weights, k) for k, v in features.items()}
        m.update(
            score=sum(contributions.values()),
            features=features,
            contributions=contributions,
        )
        ranked.append(m)
    ranked.sort(key=lambda m: (-m["score"], m["id"]))
    chosen, selected_tokens = [], []
    while ranked and len(chosen) < weights.limit:
        for m in ranked:
            words = set(tokens(m["content"]))
            overlap = max(
                (
                    len(words & prev) / max(1, len(words | prev))
                    for prev in selected_tokens
                ),
                default=0,
            )
            m["redundancy_penalty"] = overlap * weights.redundancy
            m["final_score"] = m["score"] - m["redundancy_penalty"]
        ranked.sort(key=lambda m: (-m["final_score"], m["id"]))
        winner = ranked.pop(0)
        chosen.append(winner)
        selected_tokens.append(set(tokens(winner["content"])))
    return chosen
