"""A Serper key sent by the caller applies to that request only; it must never
overwrite the process-wide setting other tenants' requests read.
Run: pytest search-service/tests
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("trafilatura")
from app.config import settings  # noqa: E402
from app.services.web_search import WebSearchService  # noqa: E402


class FakeResponse:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {
            "organic": [{"link": "https://example.com", "title": "t", "snippet": "s"}]
        }


class FakeHttp:
    def __init__(self) -> None:
        self.calls = []

    async def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append({"url": url, "headers": headers, "json": json})
        return FakeResponse()


class FakeCache:
    async def get_searx(self, *args, **kwargs):
        return None

    async def set_searx(self, *args, **kwargs):
        pass


def _service(key):
    http = FakeHttp()
    return http, WebSearchService(http, FakeCache(), inference=None, serper_api_key=key)


def test_request_key_is_used_and_the_setting_is_left_alone(monkeypatch):
    monkeypatch.setattr(settings, "serper_api_key", "process-wide")
    http, svc = _service("per-request")

    results = asyncio.run(svc._query_serper("bee flow", 5))

    assert http.calls[0]["headers"]["X-API-KEY"] == "per-request"
    assert settings.serper_api_key == "process-wide"
    assert results, "the fake answer must come back as results"


def test_without_a_request_key_the_setting_applies(monkeypatch):
    monkeypatch.setattr(settings, "serper_api_key", "process-wide")
    http, svc = _service(None)

    asyncio.run(svc._query_serper("bee flow", 5))

    assert http.calls[0]["headers"]["X-API-KEY"] == "process-wide"


def test_no_key_anywhere_means_no_call(monkeypatch):
    monkeypatch.setattr(settings, "serper_api_key", "")
    http, svc = _service(None)

    assert asyncio.run(svc._query_serper("bee flow", 5)) == []
    assert http.calls == []
