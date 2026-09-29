"""What a person searches for is theirs; the log gets a length and a digest.
Connection URLs are logged without their credentials. Run: pytest search-service/tests
"""

import asyncio
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("trafilatura")
from fakes import FakeHttp, FakeInference, FakePool, FakeRedis  # noqa: E402

from app.cache.redis_cache import RedisCache  # noqa: E402
from app.models import KBParams, KBScope, ResponseParams  # noqa: E402
from app.observability.logging import query_digest, redact_url, url_label  # noqa: E402
from app.services.kb_search import KBSearchService  # noqa: E402
from app.services.web_search import WebSearchService  # noqa: E402

QUERY = "loonstrook Janneke de Wit september"


def _messages(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records]


def test_digest_is_short_stable_and_not_the_query():
    digest = query_digest(QUERY)
    assert len(digest) == 12
    assert digest == query_digest(QUERY)
    assert digest != query_digest(QUERY + "!")
    for word in QUERY.split():
        assert word not in digest


def test_url_label_keeps_the_host_and_hides_the_path():
    label = url_label("https://example.com/patients/janneke?x=1")
    assert label.startswith("example.com #")
    assert "janneke" not in label and "patients" not in label


@pytest.mark.parametrize(
    "url, expected",
    [
        (
            "postgresql://search:s3cret@search-postgres:5432/search_kb",
            "postgresql://search-postgres:5432/search_kb",
        ),
        ("redis://:hunter2@search-redis:6379/0", "redis://search-redis:6379/0"),
        ("redis://localhost:6379/0", "redis://localhost:6379/0"),
    ],
)
def test_redact_url_drops_credentials(url, expected):
    assert redact_url(url) == expected
    assert "s3cret" not in redact_url(url) and "hunter2" not in redact_url(url)


def test_serper_lines_carry_no_query_text(caplog, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "serper_api_key", "k")
    http = FakeHttp(
        post_payloads=[
            {
                "answerBox": {"title": "Janneke de Wit", "snippet": "salary"},
                "knowledgeGraph": {"title": "Janneke de Wit", "description": "x"},
                "organic": [{"link": "https://example.com/a", "title": "t"}],
            }
        ]
    )
    svc = WebSearchService(http, RedisCache(FakeRedis()), FakeInference(), "k")

    with caplog.at_level(logging.INFO, logger="search"):
        results = asyncio.run(svc._query_serper_expanded(QUERY, 5))

    assert results, "the fake answer must come back as results"
    joined = "\n".join(_messages(caplog))
    assert "Janneke" not in joined and "loonstrook" not in joined
    assert f"#{query_digest(QUERY)}" in joined


def test_kb_search_lines_carry_no_query_text(caplog):
    svc = KBSearchService(FakePool(), RedisCache(FakeRedis()), FakeInference())

    with caplog.at_level(logging.INFO, logger="search"):
        results = asyncio.run(
            svc.search(QUERY, KBScope(tenant_id="t1"), KBParams(), ResponseParams())
        )

    assert results == []
    joined = "\n".join(_messages(caplog))
    assert "Janneke" not in joined and "loonstrook" not in joined
    assert f"#{query_digest(QUERY)}" in joined


def test_kb_search_router_line_carries_no_query_text(caplog, monkeypatch):
    pytest.importorskip("httpx")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import search as router_module

    http = FakeHttp(post_payloads=[{"data": [{"index": 0, "embedding": [0.1, 0.2]}]}])
    monkeypatch.setattr(router_module, "get_db", lambda: FakePool())
    monkeypatch.setattr(router_module, "get_http", lambda: http)
    monkeypatch.setattr(router_module, "get_redis", lambda: FakeRedis())
    app = FastAPI()
    app.include_router(router_module.router)

    with caplog.at_level(logging.INFO, logger="search"):
        res = TestClient(app).post(
            "/tools/kb-search",
            json={"tenant_id": "t1", "kb_ids": ["kb1"], "query": QUERY},
        )

    assert res.status_code == 200, res.text
    joined = "\n".join(_messages(caplog))
    assert "Janneke" not in joined and "loonstrook" not in joined
    assert f"query_len={len(QUERY)}" in joined
