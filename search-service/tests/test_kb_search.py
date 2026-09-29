"""KB hybrid search against a fake pool, cache and inference client: the
merge of vector and full-text rows, reranking, the score threshold, the
result formatting and the query cache. Run: pytest search-service/tests
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
from fakes import FakeInference, FakePool, FakeRedis  # noqa: E402

from app.cache.redis_cache import RedisCache  # noqa: E402
from app.config import settings  # noqa: E402
from app.models import KBParams, KBScope, ResponseParams, SearchResult  # noqa: E402
from app.services.kb_search import KBSearchService  # noqa: E402


def row(i, score_key, score, content=None):
    return {
        "id": i,
        "title": f"Doc {i}",
        "content": content or f"content of chunk {i}",
        "source_uri": f"kb://doc/{i}",
        score_key: score,
    }


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def threshold(monkeypatch):
    monkeypatch.setattr(settings, "kb_min_score_threshold", 0.40)


def _service(pool=None, redis=None, inference=None):
    return KBSearchService(
        pool or FakePool(),
        RedisCache(redis or FakeRedis()),
        inference or FakeInference(),
    )


# ── merging ──────────────────────────────────────────────────────────


def test_vector_and_fts_rows_merge_and_shared_ids_get_a_boost():
    svc = _service()
    merged = svc._merge_dedupe(
        [row(1, "vec_score", 0.8), row(2, "vec_score", 0.5)],
        [row(2, "fts_score", 0.6), row(3, "fts_score", 0.9)],
    )
    scores = {r["id"]: round(r["combined_score"], 2) for r in merged}
    assert scores == {1: 0.8, 2: round(0.5 + 0.6 * 0.3, 2), 3: 0.45}
    assert [r["id"] for r in merged] == [1, 2, 3]


def test_top_score_is_zero_for_no_results():
    svc = _service()
    assert svc.get_top_score([]) == 0.0
    results = [
        SearchResult(source_type="kb", score=0.2),
        SearchResult(source_type="kb", score=0.7),
    ]
    assert svc.get_top_score(results) == 0.7


# ── reranking ────────────────────────────────────────────────────────


def test_rerank_sends_at_most_ten_documents_cut_to_256_characters():
    inference = FakeInference()
    svc = _service(inference=inference)
    candidates = [row(i, "combined_score", 0.5, content="x" * 300) for i in range(12)]
    run(svc._rerank("q", candidates, top_k=3))
    sent = inference.rerank_calls[0][1]
    assert len(sent) == 10 and all(len(d) == 256 for d in sent)


def test_rerank_maps_the_scores_back_onto_the_candidates_best_first():
    inference = FakeInference()
    svc = _service(inference=inference)
    candidates = [
        row(i, "combined_score", 0.5, content="x" * (10 + i)) for i in range(5)
    ]
    reranked = run(svc._rerank("q", candidates, top_k=3))
    assert [r["id"] for r in reranked] == [4, 3, 2]
    assert [r["combined_score"] for r in reranked] == [1.0, 0.9, 0.8]


# ── formatting ───────────────────────────────────────────────────────


def test_results_are_formatted_as_kb_markdown_with_citations():
    svc = _service()
    candidates = [
        row(1, "combined_score", 0.9),
        {**row(2, "combined_score", 0.8), "source_uri": None},
    ]
    results = svc._format_results(candidates, ResponseParams(include_citations=True))
    assert results[0].markdown.startswith("## Doc 1 — chunk 0")
    assert results[0].citations[0].url == "kb://doc/1"
    assert results[0].score == 0.9
    assert results[1].citations == []
    no_cites = svc._format_results(candidates, ResponseParams(include_citations=False))
    assert all(r.citations == [] for r in no_cites)


# ── the whole search ─────────────────────────────────────────────────


def test_search_runs_both_queries_filters_by_threshold_and_caches():
    pool = FakePool(
        vector_rows=[row(1, "vec_score", 0.9), row(2, "vec_score", 0.3)],
        fts_rows=[row(3, "fts_score", 0.9)],
    )
    redis = FakeRedis()
    inference = FakeInference()
    svc = _service(pool, redis, inference)
    scope = KBScope(tenant_id="t1", knowledge_base_ids=["kb1", "kb2"])

    results = run(
        svc.search(
            "q", scope, KBParams(top_k_final=5, use_reranker=False), ResponseParams()
        )
    )

    assert inference.embedded == ["q"]
    assert [r.title for r in results] == ["Doc 1", "Doc 3"]
    assert [r.score for r in results] == [0.9, 0.45]
    sql_texts = [sql for sql, _ in pool.conn.queries]
    assert any("<=>" in sql for sql in sql_texts) and any(
        "ts_rank_cd" in sql for sql in sql_texts
    )
    assert all(args[1:3] == ("t1", ["kb1", "kb2"]) for _, args in pool.conn.queries)
    assert len(redis.store) == 1

    pool.vector_rows = []
    pool.fts_rows = []
    again = run(
        svc.search(
            "q", scope, KBParams(top_k_final=5, use_reranker=False), ResponseParams()
        )
    )
    assert [r.title for r in again] == ["Doc 1", "Doc 3"]
    assert inference.embedded == ["q"], "a cache hit computes no embedding"


def test_search_reranks_when_there_are_more_than_three_candidates():
    pool = FakePool(
        vector_rows=[row(i, "vec_score", 0.9, content="c" * (10 + i)) for i in range(5)]
    )
    inference = FakeInference()
    svc = _service(pool, inference=inference)

    results = run(
        svc.search(
            "q",
            KBScope(tenant_id="t"),
            KBParams(top_k_final=2, use_reranker=True),
            ResponseParams(),
        )
    )

    assert inference.rerank_calls[0][2] == 2
    assert [r.title for r in results] == ["Doc 4", "Doc 3"]


def test_search_answers_nothing_below_the_threshold():
    pool = FakePool(vector_rows=[row(1, "vec_score", 0.1)])
    results = run(
        _service(pool).search(
            "q", KBScope(tenant_id="t"), KBParams(use_reranker=False), ResponseParams()
        )
    )
    assert results == []
