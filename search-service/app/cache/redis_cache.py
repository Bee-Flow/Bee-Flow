"""
Redis caching layer — implements all 5 cache patterns from the spec.

Key patterns:
    web:searx:{hash}       TTL 5min   — Serper.dev result lists
    web:page:{sha256}      TTL 6h     — extracted page content
    web:clean:{sha256}     TTL 24h    — AI-cleaned markdown
    kb:query:{hash}        TTL 2min   — KB search results
    emb:{sha256}           TTL 24h    — embedding vectors
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

import redis.asyncio as aioredis

from app.config import settings


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def _hash_key(*parts: str) -> str:
    combined = "|".join(parts)
    return hashlib.md5(combined.encode("utf-8")).hexdigest()[:24]


class RedisCache:
    """Thin async wrapper around Redis with typed key helpers."""

    def __init__(self, client: aioredis.Redis) -> None:
        self._r = client

    # ── Raw get/set ──────────────────────────────────────────────────

    async def get_json(self, key: str) -> Optional[Any]:
        raw = await self._r.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None

    async def set_json(self, key: str, value: Any, ttl: int) -> None:
        await self._r.set(key, json.dumps(value, default=str), ex=ttl)

    # ── Web: Serper.dev results ──────────────────────────────────────

    def _searx_key(self, query: str, engines: str, max_results: int) -> str:
        return f"web:searx:{_hash_key(query, engines, str(max_results))}"

    async def get_searx(
        self, query: str, engines: str, max_results: int
    ) -> Optional[list[dict]]:
        key = self._searx_key(query, engines, max_results)
        return await self.get_json(key)

    async def set_searx(
        self, query: str, engines: str, max_results: int, results: list[dict]
    ) -> None:
        key = self._searx_key(query, engines, max_results)
        await self.set_json(key, results, settings.cache_ttl_searx)

    # ── Web: extracted page ─────────────────────────────────────────

    def _page_key(self, url: str) -> str:
        return f"web:page:{_sha256(url)}"

    async def get_page(self, url: str) -> Optional[dict]:
        return await self.get_json(self._page_key(url))

    async def set_page(self, url: str, data: dict) -> None:
        await self.set_json(self._page_key(url), data, settings.cache_ttl_page)

    # ── Web: cleaned markdown ───────────────────────────────────────

    def _clean_key(self, url: str, model_version: str, max_tokens: int) -> str:
        return f"web:clean:{_sha256(url + model_version + str(max_tokens))}"

    async def get_clean(
        self, url: str, model_version: str, max_tokens: int
    ) -> Optional[str]:
        key = self._clean_key(url, model_version, max_tokens)
        return await self._r.get(key)

    async def set_clean(
        self, url: str, model_version: str, max_tokens: int, markdown: str
    ) -> None:
        key = self._clean_key(url, model_version, max_tokens)
        await self._r.set(key, markdown, ex=settings.cache_ttl_clean)

    # ── KB: query results ───────────────────────────────────────────

    def _kb_query_key(
        self, tenant_id: str, kb_ids: str, query: str, params: str
    ) -> str:
        return f"kb:query:{_hash_key(tenant_id, kb_ids, query, params)}"

    async def get_kb_query(
        self, tenant_id: str, kb_ids: list[str], query: str, params: str
    ) -> Optional[list[dict]]:
        key = self._kb_query_key(tenant_id, ",".join(sorted(kb_ids)), query, params)
        return await self.get_json(key)

    async def set_kb_query(
        self,
        tenant_id: str,
        kb_ids: list[str],
        query: str,
        params: str,
        results: list[dict],
    ) -> None:
        key = self._kb_query_key(tenant_id, ",".join(sorted(kb_ids)), query, params)
        await self.set_json(key, results, settings.cache_ttl_kb_query)

    # ── Embedding cache ─────────────────────────────────────────────

    def _emb_key(self, text: str) -> str:
        return f"emb:{_sha256(text)}"

    async def get_embedding(self, text: str) -> Optional[list[float]]:
        return await self.get_json(self._emb_key(text))

    async def set_embedding(self, text: str, vector: list[float]) -> None:
        await self.set_json(self._emb_key(text), vector, settings.cache_ttl_embedding)
