"""In-memory stand-ins for the search service's three dependencies: the
asyncpg pool, the redis client and the httpx client. Each records what it
was asked so a test can assert on the call, and answers what it was told.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Callable


class CharEncoding:
    """One token per character, so a test can count tokens by hand; ``decode``
    is the exact inverse of ``encode``, which the overlap logic relies on."""

    def encode(self, text: str) -> list[int]:
        return [ord(c) for c in text]

    def decode(self, tokens: list[int]) -> str:
        return "".join(chr(t) for t in tokens)


class FakeConn:
    """Answers every ``fetch`` with the rows the pool was built with."""

    def __init__(self, rows_for: Callable[[str], list[dict]]) -> None:
        self._rows_for = rows_for
        self.queries: list[tuple[str, tuple]] = []

    async def fetch(self, sql: str, *args) -> list[dict]:
        self.queries.append((sql, args))
        return [dict(r) for r in self._rows_for(sql)]

    async def execute(self, sql: str, *args) -> None:
        self.queries.append((sql, args))

    async def fetchval(self, sql: str, *args) -> Any:
        self.queries.append((sql, args))
        return 1


class FakePool:
    """``async with pool.acquire() as conn`` over one FakeConn.

    ``rows_for`` maps a SQL text to the rows it should return; the default
    answers vector queries and FTS queries from two separate lists.
    """

    def __init__(
        self,
        vector_rows: list[dict] | None = None,
        fts_rows: list[dict] | None = None,
    ) -> None:
        self.vector_rows = vector_rows or []
        self.fts_rows = fts_rows or []
        self.conn = FakeConn(self._rows_for)

    def _rows_for(self, sql: str) -> list[dict]:
        return self.fts_rows if "ts_rank_cd" in sql else self.vector_rows

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


class FakeRedis:
    """A dict with the two redis calls RedisCache makes."""

    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.ttls: dict[str, int | None] = {}

    async def get(self, key: str) -> Any:
        return self.store.get(key)

    async def set(self, key: str, value: Any, ex: int | None = None) -> None:
        self.store[key] = value
        self.ttls[key] = ex

    async def ping(self) -> bool:
        return True


class FakeResponse:
    def __init__(
        self,
        payload: Any = None,
        *,
        status: int = 200,
        text: str = "",
        next_url: str | None = None,
    ) -> None:
        self._payload = payload
        self.status_code = status
        self.text = text
        self.is_redirect = next_url is not None
        self.next_request = _NextRequest(next_url) if next_url else None

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=None, response=None
            )


class _NextRequest:
    def __init__(self, url: str) -> None:
        self.url = url


class FakeHttp:
    """Answers POSTs from ``post_payloads`` in order and GETs from ``get_responses``
    keyed by URL; records every call."""

    def __init__(
        self,
        post_payloads: list[Any] | None = None,
        get_responses: dict[str, FakeResponse] | None = None,
    ) -> None:
        self.post_payloads = list(post_payloads or [])
        self.get_responses = dict(get_responses or {})
        self.posts: list[dict] = []
        self.gets: list[dict] = []

    async def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append({"url": url, "headers": headers, "json": json})
        payload = self.post_payloads.pop(0) if self.post_payloads else {}
        if isinstance(payload, FakeResponse):
            return payload
        return FakeResponse(payload)

    async def get(self, url, timeout=None, follow_redirects=True):
        self.gets.append({"url": url, "follow_redirects": follow_redirects})
        if url in self.get_responses:
            return self.get_responses[url]
        return FakeResponse(status=404)


class FakeInference:
    """Embeds every text to the same vector and reranks by document length,
    longest first, so the order is predictable without a model."""

    def __init__(self, vector: list[float] | None = None) -> None:
        self.vector = vector or [0.1, 0.2, 0.3]
        self.rerank_calls: list[tuple[str, list[str], int | None]] = []
        self.embedded: list[str] = []

    async def embed_single(self, text: str) -> list[float]:
        self.embedded.append(text)
        return self.vector

    async def rerank(self, query: str, documents: list[str], top_n=None) -> list[dict]:
        self.rerank_calls.append((query, list(documents), top_n))
        order = sorted(range(len(documents)), key=lambda i: -len(documents[i]))
        return [
            {"index": i, "relevance_score": round(1.0 - rank * 0.1, 2)}
            for rank, i in enumerate(order)
        ]

    async def cleanup_markdown(self, markdown: str, **kwargs) -> str:
        return markdown
