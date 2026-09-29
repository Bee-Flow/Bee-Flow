"""The web search pipeline against a fake Serper, a fake page server and a
fake inference client: query expansion, result normalisation, caching,
reranking, and the by-hand redirect walk that checks every hop.
Run: pytest search-service/tests
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("trafilatura")
from fakes import FakeHttp, FakeInference, FakeRedis, FakeResponse  # noqa: E402

from app.cache.redis_cache import RedisCache  # noqa: E402
from app.config import settings  # noqa: E402
from app.models import ResponseParams, SearchResult, SourceType, WebParams  # noqa: E402
from app.services import web_search  # noqa: E402
from app.services.ssrf_guard import PrivateTargetError  # noqa: E402
from app.services.web_search import WebSearchService  # noqa: E402

SERPER = {
    "answerBox": {
        "title": "Direct",
        "snippet": "42",
        "link": "https://answers.example/42",
        "snippetHighlighted": ["forty", "two"],
    },
    "knowledgeGraph": {
        "title": "Entity",
        "description": "A thing",
        "type": "Concept",
        "website": "https://entity.example",
        "attributes": {"Founded": "1999", "HQ": "Delft"},
    },
    "organic": [
        {"link": "https://a.example/1", "title": "A", "snippet": "sa"},
        {"link": "https://b.example/2", "title": "B", "snippet": "sb"},
    ],
}


@pytest.fixture(autouse=True)
def serper_key(monkeypatch):
    monkeypatch.setattr(settings, "serper_api_key", "k")
    monkeypatch.setattr(settings, "serper_country", "")
    monkeypatch.setattr(settings, "serper_lang", "")


def _service(http=None, redis=None, inference=None):
    return WebSearchService(
        http or FakeHttp(),
        RedisCache(redis or FakeRedis()),
        inference or FakeInference(),
        serper_api_key="k",
    )


def run(coro):
    return asyncio.run(coro)


# ── query expansion ──────────────────────────────────────────────────


def test_short_queries_are_not_expanded():
    assert WebSearchService._expand_query("bee flow pricing") == ["bee flow pricing"]


def test_long_queries_get_a_condensed_variant_without_filler():
    q = "what is the capital of the netherlands and when was it founded"
    variants = WebSearchService._expand_query(q)
    assert variants[0] == q
    assert variants[1] == "capital netherlands it founded"
    assert len(variants) == 2


def test_no_variant_when_condensing_leaves_too_little_or_changes_nothing():
    assert WebSearchService._expand_query("the a an is are was were") == [
        "the a an is are was were"
    ]
    dense = "alpha beta gamma delta epsilon zeta"
    assert WebSearchService._expand_query(dense) == [dense]


# ── one Serper call ──────────────────────────────────────────────────


def test_a_serper_answer_is_normalised_in_order():
    http = FakeHttp(post_payloads=[SERPER])
    results = run(_service(http)._query_serper("q", 5))

    assert [r["url"] for r in results] == [
        "https://answers.example/42",
        "https://entity.example",
        "https://a.example/1",
        "https://b.example/2",
    ]
    assert results[0]["title"] == "📋 Direct"
    assert results[0]["content"] == "42 | Key: forty, two"
    assert results[0]["score"] == 1.0
    assert results[1]["title"] == "📚 Entity"
    assert (
        results[1]["content"] == "A thing | Type: Concept | Founded: 1999 | HQ: Delft"
    )
    assert results[1]["score"] == 0.99
    assert [r["score"] for r in results[2:]] == [1.0, 0.95]
    assert results[2] == {
        "url": "https://a.example/1",
        "title": "A",
        "content": "sa",
        "score": 1.0,
    }


def test_the_request_carries_the_key_the_count_and_the_locale(monkeypatch):
    monkeypatch.setattr(settings, "serper_country", "nl")
    monkeypatch.setattr(settings, "serper_lang", "nl")
    http = FakeHttp(post_payloads=[{"organic": []}])
    run(_service(http)._query_serper("q", 50))
    call = http.posts[0]
    assert call["url"] == settings.serper_api_url
    assert call["headers"]["X-API-KEY"] == "k"
    assert call["json"] == {"q": "q", "num": 20, "gl": "nl", "hl": "nl"}


def test_results_are_cached_and_a_hit_skips_the_network():
    redis = FakeRedis()
    http = FakeHttp(post_payloads=[SERPER])
    svc = _service(http, redis)
    first = run(svc._query_serper("q", 5))
    assert len(redis.store) == 1
    second = run(svc._query_serper("q", 5))
    assert second == first
    assert len(http.posts) == 1


def test_a_failing_serper_call_is_an_empty_list():
    http = FakeHttp(post_payloads=[FakeResponse(status=500)])
    assert run(_service(http)._query_serper("q", 5)) == []


# ── the expanded call ────────────────────────────────────────────────


def test_expanded_results_are_deduplicated_and_rescored():
    q = "what is the capital of the netherlands and when was it founded"
    first = {"organic": [{"link": "https://a.example", "title": "A", "snippet": ""}]}
    second = {
        "organic": [
            {"link": "https://a.example", "title": "A again", "snippet": ""},
            {"link": "https://c.example", "title": "C", "snippet": ""},
        ]
    }
    http = FakeHttp(post_payloads=[first, second])
    results = run(_service(http)._query_serper_expanded(q, 5))
    assert [r["url"] for r in results] == ["https://a.example", "https://c.example"]
    assert [r["score"] for r in results] == [1.0, 0.97]
    assert len(http.posts) == 2


def test_expanded_results_are_cut_to_max_results():
    organic = [{"link": f"https://{i}.example", "title": str(i)} for i in range(6)]
    http = FakeHttp(post_payloads=[{"organic": organic}])
    assert len(run(_service(http)._query_serper_expanded("short query", 3))) == 3


# ── fetching a page ──────────────────────────────────────────────────


@pytest.fixture
def public_hosts(monkeypatch):
    seen: list[str] = []

    async def allow(host):
        seen.append(host)
        if host.startswith("10."):
            raise PrivateTargetError(host)

    monkeypatch.setattr(web_search, "assert_public_host", allow)
    return seen


def test_redirects_are_followed_by_hand_and_every_hop_is_checked(public_hosts):
    http = FakeHttp(
        get_responses={
            "https://start.example/p": FakeResponse(next_url="https://end.example/q"),
            "https://end.example/q": FakeResponse(text="<html>final</html>"),
        }
    )
    assert run(_service(http)._fetch_page("https://start.example/p")) == (
        "<html>final</html>"
    )
    assert public_hosts == ["start.example", "end.example"]
    assert all(call["follow_redirects"] is False for call in http.gets)


def test_a_redirect_into_a_private_address_is_refused(public_hosts):
    http = FakeHttp(
        get_responses={
            "https://start.example/p": FakeResponse(next_url="http://10.0.0.5/admin"),
            "http://10.0.0.5/admin": FakeResponse(text="secret"),
        }
    )
    assert run(_service(http)._fetch_page("https://start.example/p")) is None
    assert [call["url"] for call in http.gets] == ["https://start.example/p"]


def test_a_redirect_loop_gives_up_after_the_configured_hops(public_hosts, monkeypatch):
    monkeypatch.setattr(settings, "web_max_redirects", 2)
    http = FakeHttp(
        get_responses={
            "https://loop.example/a": FakeResponse(next_url="https://loop.example/a")
        }
    )
    assert run(_service(http)._fetch_page("https://loop.example/a")) is None
    assert len(http.gets) == 3


def test_an_http_error_is_none(public_hosts):
    http = FakeHttp(get_responses={"https://x.example/": FakeResponse(status=503)})
    assert run(_service(http)._fetch_page("https://x.example/")) is None


# ── reranking and the pipeline ───────────────────────────────────────


def _result(title, markdown, score=0.5):
    return SearchResult(
        source_type=SourceType.web,
        title=title,
        url=f"https://{title}.example",
        score=score,
        markdown=markdown,
    )


def test_rerank_reorders_by_the_inference_scores():
    inference = FakeInference()
    svc = _service(inference=inference)
    results = [_result("short", "a"), _result("long", "a much longer text")]
    reranked = run(svc._rerank_results("q", results))
    assert [r.title for r in reranked] == ["long", "short"]
    assert [r.score for r in reranked] == [1.0, 0.9]
    assert inference.rerank_calls[0][1] == ["a", "a much longer text"]


def test_search_fast_returns_snippets_when_inference_is_off(monkeypatch):
    monkeypatch.setattr(settings, "inference_enabled", False)
    http = FakeHttp(post_payloads=[SERPER])
    results = run(
        _service(http).search_fast(
            "q", WebParams(max_results=5), ResponseParams(include_citations=False)
        )
    )
    assert [r.title for r in results] == ["📋 Direct", "📚 Entity", "A", "B"]
    assert all(r.citations == [] for r in results)


def test_search_fast_prepends_a_synthesis_when_inference_is_on(monkeypatch):
    monkeypatch.setattr(settings, "inference_enabled", True)
    http = FakeHttp(post_payloads=[SERPER])
    results = run(
        _service(http).search_fast("q", WebParams(max_results=5), ResponseParams())
    )
    assert results[0].title == "📝 q — AI Summary"
    assert results[0].score == 1.0
    assert len(results[0].citations) == 4


def test_search_uses_the_page_cache_and_skips_cleanup_for_short_pages(
    monkeypatch, public_hosts
):
    monkeypatch.setattr(settings, "inference_enabled", False)
    redis = FakeRedis()
    cache = RedisCache(redis)
    run(
        cache.set_page(
            "https://a.example/1", {"text": "cached body", "title": "Cached"}
        )
    )
    http = FakeHttp(post_payloads=[{"organic": SERPER["organic"]}])
    svc = WebSearchService(http, cache, FakeInference(), serper_api_key="k")

    results = run(
        svc.search("q", WebParams(max_results=5, fetch_top_n=1), ResponseParams())
    )

    assert [r.title for r in results] == ["Cached", "B"]
    assert results[0].markdown == "cached body"
    assert results[0].metadata.cache_hit is True
    assert results[1].markdown == "sb"
    assert http.gets == []
