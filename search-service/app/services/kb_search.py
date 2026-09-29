"""
KB hybrid search — vector + full-text search + reranking.
"""

from __future__ import annotations

import asyncio
import json

import asyncpg

from app.cache.redis_cache import RedisCache
from app.config import settings
from app.db.queries import FTS_SEARCH_SQL, VECTOR_SEARCH_SQL
from app.extractors.normalizer import format_kb_result_markdown
from app.models import (
    Citation,
    KBParams,
    KBScope,
    ResponseParams,
    ResultMetadata,
    SearchResult,
    SourceType,
)
from app.observability.logging import latency, logger, query_digest
from app.services.inference import InferenceClient


class KBSearchService:
    """Orchestrates hybrid search over the internal knowledge base."""

    def __init__(
        self,
        db: asyncpg.Pool,
        cache: RedisCache,
        inference: InferenceClient,
    ) -> None:
        self._db = db
        self._cache = cache
        self._inference = inference

    async def search(
        self,
        query: str,
        kb_scope: KBScope,
        kb_params: KBParams,
        response_params: ResponseParams,
    ) -> list[SearchResult]:
        """
        Run hybrid search: vector + FTS → merge → dedupe → rerank → format.
        Returns the top results as SearchResult objects.
        """
        tenant_id = str(kb_scope.tenant_id)
        kb_ids = [str(kid) for kid in kb_scope.knowledge_base_ids]

        # Check cache
        cache_key_params = json.dumps(
            {
                "top_k_vector": kb_params.top_k_vector,
                "top_k_fts": kb_params.top_k_fts,
                "top_k_final": kb_params.top_k_final,
                "use_reranker": kb_params.use_reranker,
            },
            sort_keys=True,
        )

        cached = await self._cache.get_kb_query(
            tenant_id, kb_ids, query, cache_key_params
        )
        if cached:
            logger.info("KB query cache hit (query=#%s)", query_digest(query))
            return [SearchResult(**r) for r in cached]

        # 1. Compute query embedding
        query_embedding = await self._inference.embed_single(query)

        # 2. Run vector + FTS in parallel
        vector_task = self._vector_search(
            query_embedding, tenant_id, kb_ids, kb_params.top_k_vector
        )
        fts_task = self._fts_search(query, tenant_id, kb_ids, kb_params.top_k_fts)
        vector_results, fts_results = await asyncio.gather(vector_task, fts_task)

        # 3. Merge + dedupe
        candidates = self._merge_dedupe(vector_results, fts_results)

        if not candidates:
            logger.info("No KB results (query=#%s)", query_digest(query))
            return []

        # 4. Rerank (if enabled and enough candidates to benefit)
        if kb_params.use_reranker and len(candidates) > 3:
            candidates = await self._rerank(query, candidates, kb_params.top_k_final)
        else:
            candidates = candidates[: kb_params.top_k_final]

        # 5. Filter by minimum score threshold
        min_threshold = settings.kb_min_score_threshold
        before_count = len(candidates)
        candidates = [
            c for c in candidates if c.get("combined_score", 0.0) >= min_threshold
        ]
        if before_count != len(candidates):
            logger.info(
                "Score threshold %.2f filtered %d → %d candidates",
                min_threshold,
                before_count,
                len(candidates),
            )

        if not candidates:
            logger.info(
                "All KB results below threshold (query=#%s)", query_digest(query)
            )
            return []

        # Log top scores for debugging
        top_scores = [round(c.get("combined_score", 0.0), 3) for c in candidates[:5]]
        logger.info("KB search scores (top %d): %s", len(top_scores), top_scores)

        # 6. Format results
        results = self._format_results(candidates, response_params)

        # Cache results
        await self._cache.set_kb_query(
            tenant_id,
            kb_ids,
            query,
            cache_key_params,
            [r.model_dump(mode="json") for r in results],
        )

        return results

    def get_top_score(self, results: list[SearchResult]) -> float:
        """Return the highest score from results, or 0.0 if empty."""
        if not results:
            return 0.0
        return max(r.score for r in results)

    # ── Internal steps ───────────────────────────────────────────────

    async def _vector_search(
        self,
        embedding: list[float],
        tenant_id: str,
        kb_ids: list[str],
        top_k: int,
    ) -> list[dict]:
        """Run vector similarity search."""
        with latency.track("kb_vector_query"):
            async with self._db.acquire() as conn:
                rows = await conn.fetch(
                    VECTOR_SEARCH_SQL,
                    str(embedding),
                    tenant_id,
                    kb_ids,
                    top_k,
                )
        return [dict(r) for r in rows]

    async def _fts_search(
        self,
        query: str,
        tenant_id: str,
        kb_ids: list[str],
        top_k: int,
    ) -> list[dict]:
        """Run full-text search."""
        with latency.track("kb_fts_query"):
            async with self._db.acquire() as conn:
                rows = await conn.fetch(
                    FTS_SEARCH_SQL,
                    query,
                    tenant_id,
                    kb_ids,
                    top_k,
                )
        return [dict(r) for r in rows]

    def _merge_dedupe(
        self, vector_results: list[dict], fts_results: list[dict]
    ) -> list[dict]:
        """Merge vector and FTS results, deduplicating by chunk id."""
        seen_ids: set[int] = set()
        merged: list[dict] = []

        # Vector results first (they have vec_score)
        for r in vector_results:
            chunk_id = r["id"]
            if chunk_id not in seen_ids:
                seen_ids.add(chunk_id)
                r["combined_score"] = r.get("vec_score", 0.0)
                merged.append(r)

        # Add FTS results
        for r in fts_results:
            chunk_id = r["id"]
            if chunk_id not in seen_ids:
                seen_ids.add(chunk_id)
                r["combined_score"] = (
                    r.get("fts_score", 0.0) * 0.5
                )  # normalize FTS scores
                merged.append(r)
            else:
                # Boost score if found in both
                for m in merged:
                    if m["id"] == chunk_id:
                        m["combined_score"] += r.get("fts_score", 0.0) * 0.3
                        break

        # Sort by combined score
        merged.sort(key=lambda x: x.get("combined_score", 0.0), reverse=True)
        return merged

    async def _rerank(
        self, query: str, candidates: list[dict], top_k: int
    ) -> list[dict]:
        """Rerank candidates using the reranker model."""
        # Limit candidates and truncate content for performance.
        # Cross-encoder attention scales quadratically with input length;
        # first 256 chars capture enough topical signal for reranking.
        rerank_limit = min(10, len(candidates))
        documents = [c.get("content", "")[:256] for c in candidates[:rerank_limit]]

        with latency.track("rerank_inference"):
            reranked = await self._inference.rerank(query, documents, top_n=top_k)

        # Map back to candidates
        result = []
        for item in reranked[:top_k]:
            idx = item.get("index", 0)
            if idx < len(candidates):
                candidate = candidates[idx]
                candidate["combined_score"] = item.get("relevance_score", 0.0)
                result.append(candidate)

        return result

    def _format_results(
        self, candidates: list[dict], response_params: ResponseParams
    ) -> list[SearchResult]:
        """Convert raw DB rows into SearchResult objects with markdown."""
        results = []
        for c in candidates:
            markdown = format_kb_result_markdown(
                title=c.get("title"),
                chunk_id=c.get("chunk_id", 0),
                content=c.get("content", ""),
                source_uri=c.get("source_uri"),
            )

            citations = []
            if response_params.include_citations and c.get("source_uri"):
                citations.append(
                    Citation(
                        url=c.get("source_uri"),
                        title=c.get("title"),
                    )
                )

            results.append(
                SearchResult(
                    source_type=SourceType.kb,
                    title=c.get("title"),
                    url=c.get("source_uri"),
                    score=c.get("combined_score", 0.0),
                    markdown=markdown,
                    citations=citations,
                    metadata=ResultMetadata(cache_hit=False),
                )
            )

        return results
