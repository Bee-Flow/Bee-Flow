"""
FastAPI application entry point.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api_key_auth import APIKeyMiddleware
from app.config import settings
from app.db.pool import bootstrap_schema
from app.dependencies import (
    close_db,
    close_http,
    close_redis,
    init_db,
    init_http,
    init_redis,
)
from app.observability.logging import latency, logger, setup_logging
from app.routers import ingest, search, inference_api

# API-contract version of this service — the single constant behind both the
# OpenAPI version and the `version` field on GET /health. Bump the MINOR on
# any request-contract change (a new accepted field, stricter validation):
# the server probes /health and only sends fields this build declares it
# knows. Older builds have no `version` in their health body at all — the
# absence itself means "pre-1.1 contract" (U9).
# 1.1.0 — request models reject unknown fields (extra="forbid");
#         /tools/kb-search accepts `inference_routing`.
SERVICE_VERSION = "1.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application startup / shutdown lifecycle."""
    setup_logging()
    logger.info("Starting %s …", settings.app_name)

    # Initialize connections
    pool = await init_db()
    await bootstrap_schema(pool)
    await init_redis()
    await init_http()

    logger.info("All services initialized — ready to serve")
    yield

    # Cleanup
    logger.info("Shutting down …")
    await close_http()
    await close_redis()
    await close_db()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Agent Search Engine",
    description=(
        "Low-latency search tool for AI agents. "
        "Returns clean, structured markdown with citations from web search "
        "and internal knowledge bases."
    ),
    version=SERVICE_VERSION,
    lifespan=lifespan,
)

# CORS — allow all for API-only service
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if settings.services_api_key:
    app.add_middleware(APIKeyMiddleware, api_key=settings.services_api_key)
    logger.info("API key authentication enabled")

# Mount routers
app.include_router(search.router)
app.include_router(ingest.router)
app.include_router(inference_api.router)


@app.get("/health")
async def health() -> dict:
    """Health check endpoint.

    `version` is the API-contract version (SERVICE_VERSION): the server reads
    it here before sending request fields an older build would reject.
    """
    return {"status": "ok", "service": settings.app_name, "version": SERVICE_VERSION}


@app.get("/health/detailed")
async def health_detailed() -> dict:
    """Detailed health with latency stats."""
    from app.dependencies import db_pool, redis_client

    db_ok = False
    redis_ok = False

    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            db_ok = True
        except Exception:
            pass

    if redis_client:
        try:
            await redis_client.ping()
            redis_ok = True
        except Exception:
            pass

    return {
        "status": "ok" if (db_ok and redis_ok) else "degraded",
        "service": settings.app_name,
        "version": SERVICE_VERSION,
        "database": "ok" if db_ok else "unavailable",
        "redis": "ok" if redis_ok else "unavailable",
        "inference_enabled": settings.inference_enabled,
        "latency_p95": latency.summary(),
    }
