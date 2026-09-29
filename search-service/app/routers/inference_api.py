"""
Public embed / rerank API router — exposes inference endpoints
for external callers (e.g., the Bee Flow server).
"""

from __future__ import annotations

from fastapi import APIRouter

from app.cache.redis_cache import RedisCache
from app.dependencies import get_http, get_redis
from app.models import (
    EmbedRequest,
    EmbedResponse,
    RerankRequest,
    RerankResponse,
    RerankResult,
)
from app.observability.logging import latency, logger
from app.services.inference import InferenceClient

router = APIRouter(tags=["inference"])


# ── Endpoints ────────────────────────────────────────────────────────


@router.post("/embed", response_model=EmbedResponse)
async def embed_texts(req: EmbedRequest) -> EmbedResponse:
    """
    Compute embeddings for a batch of texts using bge-m3.
    Results are cached in Redis for 24h.
    """
    from app.config import settings
    import hashlib
    import json

    http = get_http()
    redis = get_redis()
    cache = RedisCache(redis)
    inference = InferenceClient(http)

    embeddings: list[list[float]] = [None] * len(req.input)  # type: ignore
    uncached_indices: list[int] = []
    uncached_texts: list[str] = []
    cached_count = 0

    # Check cache for each text
    for i, text in enumerate(req.input):
        cache_key = f"emb:{hashlib.sha256(text.encode()).hexdigest()[:32]}"
        cached = await cache._redis.get(cache_key)
        if cached:
            embeddings[i] = json.loads(cached)
            cached_count += 1
        else:
            uncached_indices.append(i)
            uncached_texts.append(text)

    # Compute missing embeddings
    if uncached_texts:
        with latency.track("embed_api"):
            new_embeddings = await inference.embed(uncached_texts)

        # Store results and cache
        for idx, (orig_idx, embedding) in enumerate(
            zip(uncached_indices, new_embeddings)
        ):
            embeddings[orig_idx] = embedding
            cache_key = (
                f"emb:{hashlib.sha256(req.input[orig_idx].encode()).hexdigest()[:32]}"
            )
            await cache._redis.set(
                cache_key,
                json.dumps(embedding),
                ex=settings.cache_ttl_embedding,
            )

    logger.info(
        "Embed API: %d texts (%d cached, %d computed)",
        len(req.input),
        cached_count,
        len(uncached_texts),
    )

    return EmbedResponse(
        embeddings=embeddings,  # type: ignore
        model=settings.embed_model,
        dimensions=settings.embed_dimensions,
        cached=cached_count,
    )


@router.post("/rerank", response_model=RerankResponse)
async def rerank_documents(req: RerankRequest) -> RerankResponse:
    """
    Rerank documents against a query using bge-reranker-large.
    Returns results sorted by relevance score (descending).
    """
    from app.config import settings

    http = get_http()
    inference = InferenceClient(http)

    with latency.track("rerank_api"):
        results = await inference.rerank(
            query=req.query,
            documents=req.documents,
            top_n=req.top_n,
        )

    return RerankResponse(
        results=[
            RerankResult(
                index=r.get("index", 0),
                relevance_score=r.get("relevance_score", 0.0),
            )
            for r in results
        ],
        model=settings.rerank_model,
    )
