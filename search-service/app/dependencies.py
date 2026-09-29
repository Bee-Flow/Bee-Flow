"""
Shared dependencies — initialized at startup, injected via FastAPI DI.
"""

from __future__ import annotations

import asyncpg
import httpx
import redis.asyncio as aioredis

from app.config import settings
from app.observability.logging import logger, redact_url

# ── Singletons (set during lifespan) ────────────────────────────────

db_pool: asyncpg.Pool | None = None
redis_client: aioredis.Redis | None = None
http_client: httpx.AsyncClient | None = None


async def init_db() -> asyncpg.Pool:
    """Create the asyncpg connection pool."""
    global db_pool
    logger.info("Connecting to PostgreSQL: %s", redact_url(settings.database_url))
    db_pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
    )
    # Ensure pgvector extension is available
    async with db_pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    logger.info(
        "PostgreSQL pool ready (min=%d, max=%d)",
        settings.db_pool_min,
        settings.db_pool_max,
    )
    return db_pool


async def close_db() -> None:
    global db_pool
    if db_pool:
        await db_pool.close()
        db_pool = None
        logger.info("PostgreSQL pool closed")


async def init_redis() -> aioredis.Redis:
    """Create the async Redis client."""
    global redis_client
    redis_client = aioredis.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=50,
    )
    # Quick connectivity check
    await redis_client.ping()
    logger.info("Redis connected: %s", redact_url(settings.redis_url))
    return redis_client


async def close_redis() -> None:
    global redis_client
    if redis_client:
        await redis_client.aclose()
        redis_client = None
        logger.info("Redis connection closed")


async def init_http() -> httpx.AsyncClient:
    """Create a shared httpx client with connection pooling."""
    global http_client
    limits = httpx.Limits(
        max_connections=settings.httpx_max_connections,
        max_keepalive_connections=settings.httpx_max_keepalive,
    )
    timeout = httpx.Timeout(
        connect=settings.web_connect_timeout,
        read=settings.web_read_timeout,
        write=5.0,
        pool=5.0,
    )
    http_client = httpx.AsyncClient(
        limits=limits,
        timeout=timeout,
        follow_redirects=True,
        max_redirects=settings.web_max_redirects,
        headers={"User-Agent": settings.web_user_agent},
    )
    logger.info("HTTP client initialized (max_conn=%d)", settings.httpx_max_connections)
    return http_client


async def close_http() -> None:
    global http_client
    if http_client:
        await http_client.aclose()
        http_client = None
        logger.info("HTTP client closed")


def get_db() -> asyncpg.Pool:
    assert db_pool is not None, "Database pool not initialized"
    return db_pool


def get_redis() -> aioredis.Redis:
    assert redis_client is not None, "Redis not initialized"
    return redis_client


def get_http() -> httpx.AsyncClient:
    assert http_client is not None, "HTTP client not initialized"
    return http_client
