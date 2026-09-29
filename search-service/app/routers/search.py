"""
Search router — POST /tools/search
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.cache.redis_cache import RedisCache
from app.dependencies import get_db, get_http, get_redis
from app.models import (
    KBParams,
    KBScope,
    ResponseParams,
    SearchRequest,
    SearchResponse,
    SimpleChunk,
    SimpleSearchRequest,
    SimpleSearchResponse,
)
from app.observability.logging import latency, logger, query_digest
from app.services.auto_router import AutoRouter
from app.services.inference import InferenceClient

router = APIRouter(prefix="/tools", tags=["search"])


@router.post("/search", response_model=SearchResponse)
async def search(request: SearchRequest, raw_request: Request) -> SearchResponse:
    """
    Main search endpoint for AI agents.
    Supports modes: web, kb, auto.
    """
    db = get_db()
    http = get_http()
    redis = get_redis()
    cache = RedisCache(redis)
    inference = InferenceClient(http)

    # The admin dashboard may send its own Serper key; it applies to this
    # request only.
    auto_router = AutoRouter(
        db=db,
        http=http,
        cache=cache,
        inference=inference,
        serper_api_key=raw_request.headers.get("x-serper-key") or None,
    )

    logger.info(
        "Search request: query_len=%d query=#%s mode=%s",
        len(request.query),
        query_digest(request.query),
        request.mode.value,
    )

    with latency.track("total_search"):
        response = await auto_router.search(request)

    logger.info(
        "Search complete: mode_used=%s results=%d",
        response.mode_used.value,
        len(response.results),
    )
    return response


# ── Simplified KB search (used by server proxy) ─────────────────────
# Request/response models live in app.models (SimpleSearchRequest & co) so
# the wire contract stays importable without this router's dependency chain.

from app.services.kb_search import KBSearchService


@router.post("/kb-search", response_model=SimpleSearchResponse, tags=["kb_search"])
async def kb_search(request: SimpleSearchRequest) -> SimpleSearchResponse:
    """
    Simplified KB search for server proxy.
    Returns raw chunks with content, title, source_uri, score.
    When use_azure=True, uses Azure OpenAI for query embedding + reranking.
    """
    db = get_db()
    http = get_http()
    redis = get_redis()
    cache = RedisCache(redis)

    # Use Azure or local inference based on request flag
    from app.services.inference import get_inference_client

    inference = get_inference_client(
        http,
        use_azure=request.use_azure,
        azure_endpoint=request.azure_endpoint,
        azure_key=request.azure_key,
        azure_model=request.azure_model,
    )

    logger.info(
        "[KB Search] query_len=%d query=#%s kb_ids=%s top_k=%d rerank=%s pipeline=%s",
        len(request.query),
        query_digest(request.query),
        request.kb_ids,
        request.top_k,
        request.rerank,
        "AZURE" if request.use_azure else "LOCAL",
    )

    kb_service = KBSearchService(db=db, cache=cache, inference=inference)

    kb_scope = KBScope(
        tenant_id=request.tenant_id,
        knowledge_base_ids=request.kb_ids,
    )
    kb_params = KBParams(
        top_k_vector=20,
        top_k_fts=20,
        top_k_final=request.top_k,
        use_reranker=request.rerank,
    )
    response_params = ResponseParams(include_citations=True)

    with latency.track("kb_search"):
        results = await kb_service.search(
            request.query, kb_scope, kb_params, response_params
        )

    chunks = [
        SimpleChunk(
            content=r.markdown or "",
            title=r.title,
            source_uri=r.url,
            score=r.score,
        )
        for r in results
    ]

    return SimpleSearchResponse(
        query=request.query,
        chunks=chunks,
        total=len(chunks),
    )
