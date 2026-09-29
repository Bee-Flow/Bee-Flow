"""
Auto-mode routing logic.
KB first → threshold check → web fallback if needed.
"""

from __future__ import annotations


import httpx

from app.cache.redis_cache import RedisCache
from app.config import settings
from app.models import (
    SearchMode,
    SearchRequest,
    SearchResponse,
    SearchResult,
)
from app.observability.logging import logger
from app.services.inference import InferenceClient
from app.services.kb_search import KBSearchService
from app.services.web_search import WebSearchService

import asyncpg


class AutoRouter:
    """
    Routes search requests based on mode:
    - web  → WebSearchService only
    - kb   → KBSearchService only
    - auto → KB first, web fallback if KB score < threshold
    """

    def __init__(
        self,
        db: asyncpg.Pool,
        http: httpx.AsyncClient,
        cache: RedisCache,
        inference: InferenceClient,
        serper_api_key: str | None = None,
    ) -> None:
        self._web = WebSearchService(
            http, cache, inference, serper_api_key=serper_api_key
        )
        self._kb = KBSearchService(db, cache, inference)

    async def search(self, request: SearchRequest) -> SearchResponse:
        """Execute the search based on mode."""
        mode = request.mode
        results: list[SearchResult] = []
        mode_used = mode

        if mode == SearchMode.web:
            results = await self._web.search(
                request.query, request.web, request.response
            )
            mode_used = SearchMode.web

        elif mode == SearchMode.web_fast:
            results = await self._web.search_fast(
                request.query, request.web, request.response
            )
            mode_used = SearchMode.web_fast

        elif mode == SearchMode.kb:
            if request.kb_scope is None:
                logger.warning("KB mode requested but no kb_scope provided")
                return SearchResponse(
                    query=request.query, mode_used=SearchMode.kb, results=[]
                )
            results = await self._kb.search(
                request.query, request.kb_scope, request.kb, request.response
            )
            mode_used = SearchMode.kb

        elif mode == SearchMode.auto:
            results, mode_used = await self._auto_search(request)

        return SearchResponse(
            query=request.query,
            mode_used=mode_used,
            results=results,
        )

    async def _auto_search(
        self, request: SearchRequest
    ) -> tuple[list[SearchResult], SearchMode]:
        """
        Auto mode:
        1. Run KB search first (if scope provided)
        2. If top score >= threshold → return KB only
        3. Else → run web and combine
        """
        kb_results: list[SearchResult] = []
        top_kb_score = 0.0

        # Step 1: KB search (if scope available)
        if request.kb_scope:
            kb_results = await self._kb.search(
                request.query, request.kb_scope, request.kb, request.response
            )
            top_kb_score = self._kb.get_top_score(kb_results)
            logger.info(
                "Auto mode: KB search done, top_score=%.3f, threshold=%.3f",
                top_kb_score,
                settings.auto_kb_score_threshold,
            )

            # Step 2: If KB score is high enough, return KB only
            if top_kb_score >= settings.auto_kb_score_threshold:
                logger.info("Auto mode: returning KB results only (high confidence)")
                return kb_results, SearchMode.kb

        # Step 3: Run web search
        web_results = await self._web.search(
            request.query, request.web, request.response
        )

        # Combine: top 3 KB + top 2 web
        combined: list[SearchResult] = []
        combined.extend(kb_results[:3])
        combined.extend(web_results[:2])

        mode_used = SearchMode.auto
        if not kb_results:
            mode_used = SearchMode.web
        elif not web_results:
            mode_used = SearchMode.kb

        return combined, mode_used
