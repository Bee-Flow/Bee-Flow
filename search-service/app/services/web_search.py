"""
Web search pipeline orchestrator.
Serper.dev (Google Search) → fetch pages → extract → normalize → AI cleanup.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.cache.redis_cache import RedisCache
from app.config import settings
from app.extractors.normalizer import normalize_markdown
from app.extractors.web import extract_content
from app.models import (
    Citation,
    ResponseParams,
    ResultMetadata,
    SearchResult,
    SourceType,
    WebParams,
)
from app.observability.logging import latency, logger, query_digest, url_label
from app.services.inference import InferenceClient
from app.services.ssrf_guard import PrivateTargetError, assert_public_host


class WebSearchService:
    """Orchestrates the complete web search pipeline."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        cache: RedisCache,
        inference: InferenceClient,
        serper_api_key: str | None = None,
    ) -> None:
        self._http = http
        self._cache = cache
        self._inference = inference
        self._serper_api_key = serper_api_key or settings.serper_api_key
        self._fetch_semaphore = asyncio.Semaphore(settings.web_max_concurrent_fetches)

    async def search(
        self,
        query: str,
        web_params: WebParams,
        response_params: ResponseParams,
    ) -> list[SearchResult]:
        """Run the full web search pipeline and return structured results."""

        # 1. Query Serper.dev with expanded queries for better coverage
        search_results = await self._query_serper_expanded(
            query, max_results=web_params.max_results
        )
        if not search_results:
            logger.warning(
                "Serper returned no results (query=#%s)", query_digest(query)
            )
            return []

        # 2. Fetch + extract + cleanup top N pages concurrently
        fetch_top_n = min(web_params.fetch_top_n, len(search_results))
        tasks = [
            self._process_result(search_results[i], query, response_params)
            for i in range(fetch_top_n)
        ]
        processed = await asyncio.gather(*tasks, return_exceptions=True)

        results: list[SearchResult] = []
        for i, item in enumerate(processed):
            if isinstance(item, Exception):
                logger.warning("Failed to process result %d: %s", i, item)
                # Fall back to snippet-only result
                sr = search_results[i]
                results.append(
                    SearchResult(
                        source_type=SourceType.web,
                        title=sr.get("title", ""),
                        url=sr.get("url", ""),
                        score=sr.get("score", 0.0),
                        markdown=sr.get("content", ""),
                        citations=[Citation(url=sr.get("url"), title=sr.get("title"))],
                        metadata=ResultMetadata(
                            lang=None,
                            fetched_at=datetime.now(timezone.utc),
                            cache_hit=False,
                        ),
                    )
                )
            elif item is not None:
                results.append(item)

        # Also include remaining results as snippet-only
        for i in range(fetch_top_n, len(search_results)):
            sr = search_results[i]
            results.append(
                SearchResult(
                    source_type=SourceType.web,
                    title=sr.get("title", ""),
                    url=sr.get("url", ""),
                    score=sr.get("score", 0.0),
                    markdown=sr.get("content", ""),
                    citations=[Citation(url=sr.get("url"), title=sr.get("title"))],
                    metadata=ResultMetadata(cache_hit=False),
                )
            )

        # 3. Rerank all results using inference
        if len(results) > 1 and settings.inference_enabled:
            results = await self._rerank_results(query, results)

        return results

    # ── Internal steps ───────────────────────────────────────────────

    async def search_fast(
        self,
        query: str,
        web_params: WebParams,
        response_params: ResponseParams,
    ) -> list[SearchResult]:
        """Rapid web search — snippets + optional LLM synthesis based on detail_level."""
        search_results = await self._query_serper_expanded(
            query, max_results=max(web_params.max_results, 10)
        )
        if not search_results:
            logger.warning(
                "Serper returned no results (query=#%s)", query_digest(query)
            )
            return []

        results: list[SearchResult] = []
        for sr in search_results:
            citations = []
            if response_params.include_citations:
                citations.append(Citation(url=sr.get("url"), title=sr.get("title")))
            results.append(
                SearchResult(
                    source_type=SourceType.web,
                    title=sr.get("title", ""),
                    url=sr.get("url", ""),
                    score=sr.get("score", 0.0),
                    markdown=sr.get("content", ""),
                    citations=citations,
                    metadata=ResultMetadata(cache_hit=False),
                )
            )

        # Synthesize snippets through LLM if inference is available
        detail_level = (
            response_params.detail_level.value
            if hasattr(response_params.detail_level, "value")
            else str(response_params.detail_level)
        )
        if settings.inference_enabled and results:
            try:
                # Combine all snippets into one document for synthesis
                combined = "\n\n".join(
                    f"### {r.title}\n{r.markdown}\nSource: {r.url}"
                    for r in results
                    if r.markdown
                )
                synthesized = await self._inference.cleanup_markdown(
                    markdown=combined,
                    url="",
                    title=f"Search: {query}",
                    lang="auto",
                    max_tokens=response_params.max_tokens_markdown,
                    include_citations=response_params.include_citations,
                    detail_level=detail_level,
                )
                # Prepend synthesized result
                all_citations = [
                    Citation(url=r.url, title=r.title) for r in results if r.url
                ]
                results.insert(
                    0,
                    SearchResult(
                        source_type=SourceType.web,
                        title=f"📝 {query} — AI Summary",
                        url="",
                        score=1.0,
                        markdown=synthesized,
                        citations=all_citations
                        if response_params.include_citations
                        else [],
                        metadata=ResultMetadata(cache_hit=False),
                    ),
                )
                logger.info(
                    "Fast search synthesized (%s): %d snippet results (query=#%s)",
                    detail_level,
                    len(results),
                    query_digest(query),
                )
            except Exception as e:
                logger.warning(
                    "Snippet synthesis failed, returning raw snippets: %s", e
                )

        logger.info(
            "Fast search complete: %d results (query=#%s)",
            len(results),
            query_digest(query),
        )
        return results

    async def _rerank_results(
        self, query: str, results: list[SearchResult]
    ) -> list[SearchResult]:
        """Rerank web results using the inference reranker model."""
        # Build document list from markdown content (truncate for speed —
        # cross-encoder attention scales quadratically with input length)
        documents = [(r.markdown or r.title or "")[:256] for r in results]

        with latency.track("web_rerank"):
            reranked = await self._inference.rerank(
                query, documents, top_n=len(results)
            )

        # Re-sort results by reranker score
        reordered: list[SearchResult] = []
        for item in reranked:
            idx = item.get("index", 0)
            if idx < len(results):
                r = results[idx]
                # Update score with reranker relevance
                reordered.append(
                    SearchResult(
                        source_type=r.source_type,
                        title=r.title,
                        url=r.url,
                        score=round(item.get("relevance_score", r.score), 4),
                        markdown=r.markdown,
                        citations=r.citations,
                        metadata=r.metadata,
                    )
                )

        # Add any results that weren't in the reranked list (shouldn't happen)
        seen = {item.get("index") for item in reranked}
        for i, r in enumerate(results):
            if i not in seen:
                reordered.append(r)

        logger.info(
            "Web reranking complete: %d results, top score=%.3f",
            len(reordered),
            reordered[0].score if reordered else 0.0,
        )
        return reordered

    async def _query_serper_expanded(self, query: str, max_results: int) -> list[dict]:
        """Send query + condensed variant in parallel, deduplicate by URL."""
        queries = self._expand_query(query)

        # Run all variants in parallel
        tasks = [self._query_serper(q, max_results) for q in queries]
        all_results = await asyncio.gather(*tasks)

        # Merge and deduplicate by URL, keep first occurrence (highest ranked)
        seen_urls: set[str] = set()
        merged: list[dict] = []
        for result_list in all_results:
            for r in result_list:
                url = r.get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    merged.append(r)

        # Re-score by position in merged list
        for i, r in enumerate(merged):
            r["score"] = round(1.0 - (i * 0.03), 2)

        logger.info(
            "Expanded search: %d queries → %d unique results (query=#%s)",
            len(queries),
            len(merged),
            query_digest(query),
        )
        return merged[:max_results]

    @staticmethod
    def _expand_query(query: str) -> list[str]:
        """Generate query variants for broader coverage.

        Only expands queries with 6+ words — shorter queries rarely
        benefit from a condensed variant and the second Serper call
        adds ~700ms of latency.
        """
        queries = [query]
        words = query.split()

        if len(words) >= 6:
            # Condensed variant: drop filler words
            filler = {
                "the",
                "a",
                "an",
                "is",
                "are",
                "was",
                "were",
                "in",
                "on",
                "at",
                "to",
                "for",
                "of",
                "and",
                "or",
                "what",
                "how",
                "which",
                "when",
                "where",
                "does",
                "do",
                "can",
                "will",
                "de",
                "het",
                "een",
                "van",
                "en",
                "op",
                "met",
                "voor",
                "dat",
                "die",
                "naar",
                "zijn",
                "wordt",
                "heeft",
            }
            condensed = [w for w in words if w.lower() not in filler]
            if 2 <= len(condensed) < len(words):
                queries.append(" ".join(condensed))

        return queries[:2]  # Max 2 variants

    async def _query_serper(self, query: str, max_results: int) -> list[dict]:  # noqa: C901, PLR0912
        """Query Serper.dev Google Search API and return normalised results."""
        if not self._serper_api_key:
            logger.error("Serper API key not configured (SEARCH_SERPER_API_KEY)")
            return []

        # Check cache
        cached = await self._cache.get_searx(query, "serper", max_results)
        if cached is not None:
            logger.info("Serper cache hit (query=#%s)", query_digest(query))
            return cached

        headers = {
            "X-API-KEY": self._serper_api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "q": query,
            "num": min(max_results, 20),
        }
        if settings.serper_country:
            payload["gl"] = settings.serper_country
        if settings.serper_lang:
            payload["hl"] = settings.serper_lang

        with latency.track("serper_query"):
            try:
                resp = await self._http.post(
                    settings.serper_api_url,
                    headers=headers,
                    json=payload,
                    timeout=settings.serper_timeout,
                )
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, Exception) as e:
                logger.error("Serper API failed: %s", e)
                return []

        # Normalise organic results
        organic = data.get("organic", [])
        results = []

        # Extract answerBox — direct answers (weather, calculations, etc.)
        answer_box = data.get("answerBox", {})
        if answer_box:
            ab_title = answer_box.get("title", "Direct Answer")
            ab_snippet = answer_box.get("snippet", answer_box.get("answer", ""))
            ab_link = answer_box.get("link", "")
            if ab_snippet:
                content_parts = []
                if ab_snippet:
                    content_parts.append(ab_snippet)
                # Include any highlighted words or extra data
                if answer_box.get("snippetHighlighted"):
                    highlights = answer_box["snippetHighlighted"]
                    if isinstance(highlights, list):
                        content_parts.append("Key: " + ", ".join(highlights))
                results.append(
                    {
                        "url": ab_link,
                        "title": f"📋 {ab_title}",
                        "content": " | ".join(content_parts),
                        "score": 1.0,
                    }
                )
                logger.info("Serper answerBox extracted (%d chars)", len(ab_snippet))

        # Extract knowledgeGraph — entity info (people, places, etc.)
        kg = data.get("knowledgeGraph", {})
        if kg and kg.get("title"):
            kg_parts = [kg.get("description", "")]
            for attr_key in (
                "type",
                "born",
                "founded",
                "capital",
                "population",
                "area",
                "currency",
                "leader",
                "temperature",
            ):
                val = kg.get(attr_key)
                if val:
                    kg_parts.append(f"{attr_key.title()}: {val}")
            # Include any attributes dict
            if kg.get("attributes"):
                for k, v in list(kg["attributes"].items())[:8]:
                    kg_parts.append(f"{k}: {v}")
            results.append(
                {
                    "url": kg.get("descriptionLink", kg.get("website", "")),
                    "title": f"📚 {kg['title']}",
                    "content": " | ".join(p for p in kg_parts if p),
                    "score": 0.99,
                }
            )
            logger.info("Serper knowledgeGraph extracted (%d parts)", len(kg_parts))

        for i, r in enumerate(organic[:max_results]):
            results.append(
                {
                    "url": r.get("link", ""),
                    "title": r.get("title", ""),
                    "content": r.get("snippet", ""),
                    "score": round(1.0 - (i * 0.05), 2),
                }
            )

        # Cache results
        await self._cache.set_searx(query, "serper", max_results, results)
        logger.info(
            "Serper returned %d results (query=#%s)", len(results), query_digest(query)
        )
        return results

    async def _process_result(
        self,
        searx_result: dict,
        query: str,
        response_params: ResponseParams,
    ) -> Optional[SearchResult]:
        """Fetch, extract, normalize, and cleanup a single search result."""
        url = searx_result.get("url", "")
        title = searx_result.get("title", "")
        score = searx_result.get("score", 0.0)

        if not url:
            return None

        # Check page cache
        page_cache = await self._cache.get_page(url)
        cache_hit = page_cache is not None

        if page_cache:
            extracted_text = page_cache.get("text", "")
            title = page_cache.get("title", title)
            lang = page_cache.get("lang")
        else:
            # Fetch the page
            html = await self._fetch_page(url)
            if not html:
                return None

            # Extract content
            extraction = extract_content(html, url)
            if not extraction:
                # Return snippet only
                return SearchResult(
                    source_type=SourceType.web,
                    title=title,
                    url=url,
                    score=score,
                    markdown=searx_result.get("content", ""),
                    citations=[Citation(url=url, title=title)],
                    metadata=ResultMetadata(cache_hit=False),
                )

            extracted_text = extraction.text
            title = extraction.title or title
            lang = extraction.lang

            # Cache the extraction
            await self._cache.set_page(
                url,
                {
                    "text": extracted_text,
                    "title": title,
                    "lang": lang,
                },
            )

        # Normalize
        normalized = normalize_markdown(extracted_text)

        # Check clean cache
        clean_cache = await self._cache.get_clean(
            url, settings.cleanup_model, response_params.max_tokens_markdown
        )
        if clean_cache:
            cleaned = clean_cache
            cache_hit = True
        elif len(normalized.split()) < 500:
            # Short content — skip AI cleanup, use normalized directly
            logger.info(
                "Skipping AI cleanup for short content (%d words): %s",
                len(normalized.split()),
                url_label(url),
            )
            cleaned = normalized
        else:
            # AI cleanup
            cleaned = await self._inference.cleanup_markdown(
                markdown=normalized,
                url=url,
                title=title,
                lang=lang if not cache_hit else "unknown",
                max_tokens=response_params.max_tokens_markdown,
                include_citations=response_params.include_citations,
                detail_level=response_params.detail_level.value
                if hasattr(response_params.detail_level, "value")
                else response_params.detail_level,
            )

            # Cache cleaned result
            await self._cache.set_clean(
                url,
                settings.cleanup_model,
                response_params.max_tokens_markdown,
                cleaned,
            )

        citations = []
        if response_params.include_citations:
            citations.append(Citation(url=url, title=title))

        return SearchResult(
            source_type=SourceType.web,
            title=title,
            url=url,
            score=score,
            markdown=cleaned,
            citations=citations,
            metadata=ResultMetadata(
                lang=lang if not cache_hit else None,
                fetched_at=datetime.now(timezone.utc),
                cache_hit=cache_hit,
            ),
        )

    async def _fetch_page(self, url: str) -> Optional[str]:
        """Fetch a web page HTML with concurrency limiting and tight timeout.

        Redirects are followed by hand so every hop is checked against the
        private-address rule; the shared client follows them blindly."""
        async with self._fetch_semaphore:
            with latency.track("web_fetch"):
                try:
                    for _ in range(settings.web_max_redirects + 1):
                        await assert_public_host(httpx.URL(url).host)
                        resp = await self._http.get(
                            url,
                            timeout=httpx.Timeout(
                                connect=1.0, read=1.0, write=3.0, pool=3.0
                            ),
                            follow_redirects=False,
                        )
                        if resp.is_redirect and resp.next_request is not None:
                            url = str(resp.next_request.url)
                            continue
                        resp.raise_for_status()
                        return resp.text
                    logger.warning("Too many redirects fetching %s", url_label(url))
                    return None
                except (httpx.HTTPError, PrivateTargetError) as e:
                    logger.warning("Failed to fetch %s: %s", url_label(url), e)
                    return None
