"""
Shared dependencies — initialized at startup.
"""

from __future__ import annotations

import httpx
import redis.asyncio as aioredis

from app.config import settings

redis_client: aioredis.Redis | None = None
http_client: httpx.AsyncClient | None = None


async def init_redis() -> aioredis.Redis:
    global redis_client
    redis_client = aioredis.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=20,
    )
    await redis_client.ping()
    return redis_client


async def close_redis() -> None:
    global redis_client
    if redis_client:
        await redis_client.aclose()
        redis_client = None


async def init_http() -> httpx.AsyncClient:
    global http_client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0),
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
    )
    return http_client


async def close_http() -> None:
    global http_client
    if http_client:
        await http_client.aclose()
        http_client = None


def get_redis() -> aioredis.Redis:
    assert redis_client is not None, "Redis not initialized"
    return redis_client


def get_http() -> httpx.AsyncClient:
    assert http_client is not None, "HTTP client not initialized"
    return http_client
