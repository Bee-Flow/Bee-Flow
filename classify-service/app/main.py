"""Classify service: FastAPI entry point.

Zero-shot text classification with knowledgator/gliclass-multilang-mini
(Apache-2.0) on CPU. The Node server sends an item's text and the labels of a
Condition node's "is about" rules, and gets a score per label back.
"""

from __future__ import annotations

# Size the BLAS/OpenMP pools from the cgroup CPU quota BEFORE numpy or torch is
# imported anywhere: they read these env vars once, at first import. Must stay
# first.
from app.cpu import apply_thread_env

_THREAD_CORES = apply_thread_env()

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable

from fastapi import FastAPI, Response

from app.api_key_auth import APIKeyMiddleware
from app.config import effective_api_key, settings
from app.limits import BodySizeLimitMiddleware
from app.models import HealthResponse
from app.routers import classify
from app.services.classifier import BACKEND, engine_fingerprint, get_classifier

logger = logging.getLogger("classify")

# API-contract version, behind the OpenAPI version and `version` on /health.
# Bump the MINOR on any request-contract change (a new accepted field, a
# stricter bound): the server reads it before sending a field an older build
# would answer with 422.
SERVICE_VERSION = "1.0.0"

# The model is baked, so a failed load is rarely transient; but an OOM kill of
# a sibling or a slow volume can be, and a pod that stopped trying can never
# serve. Back off, then keep trying at a long interval (as guard-service does).
_RETRY_DELAYS = (5, 15, 30, 60, 120)
_RETRY_FOREVER = 300


def warm_load(sleep: Callable[[float], None] = time.sleep) -> None:
    """Load the model on its own thread, retrying until it is ready."""
    service = get_classifier()
    attempt = 0
    while not service.load(settings):
        delay = (
            _RETRY_DELAYS[attempt] if attempt < len(_RETRY_DELAYS) else _RETRY_FOREVER
        )
        logger.warning(
            "[classify] model load attempt %d failed; retrying in %ds",
            attempt + 1,
            delay,
        )
        sleep(delay)
        attempt += 1


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    logger.info(
        "Starting %s %s: %d thread(s), label_mode=%s, max_chars=%d, max_tokens=%d, "
        "concurrency=%d, queue=%d",
        settings.app_name,
        SERVICE_VERSION,
        _THREAD_CORES,
        settings.label_mode,
        settings.max_chars,
        settings.max_tokens,
        settings.max_concurrency,
        settings.max_queue,
    )
    # First load takes seconds; /health answers 503 "loading" meanwhile.
    threading.Thread(target=warm_load, daemon=True, name="classify-warm-load").start()
    yield


def _status(response: Response) -> HealthResponse:
    service = get_classifier()
    if service.ready:
        status = "ok"
    else:
        status = "error" if service.load_error else "loading"
        response.status_code = 503
    return HealthResponse(
        status=status,
        service=settings.app_name,
        version=SERVICE_VERSION,
        backend=BACKEND,
        model=service.model_id,
        revision=service.revision,
        engine=engine_fingerprint(service, settings),
        default_threshold=settings.default_threshold,
        max_chars=settings.max_chars,
        label_mode=settings.label_mode,
        load_error=service.load_error,
    )


async def health(response: Response) -> HealthResponse:
    """Service identity and limits. 503 until the model is loaded."""
    return _status(response)


async def ready(response: Response) -> HealthResponse:
    """Readiness probe: 200 once the model is loaded, 503 before."""
    return _status(response)


def create_app(api_key: str | None = None) -> FastAPI:
    """Build the app. ``api_key=None`` reads CLASSIFY_API_KEY / SERVICES_API_KEY."""
    app = FastAPI(
        title="Classify Service",
        description="Zero-shot text classification (GLiClass, Apache-2.0) on CPU.",
        version=SERVICE_VERSION,
        lifespan=lifespan,
    )
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_body_bytes)
    key = effective_api_key(settings) if api_key is None else api_key
    if key:
        # Added last, so it runs first: an unauthenticated body is never read.
        app.add_middleware(APIKeyMiddleware, api_key=key)
    app.include_router(classify.router)
    app.add_api_route("/health", health, methods=["GET"], response_model=HealthResponse)
    app.add_api_route("/ready", ready, methods=["GET"], response_model=HealthResponse)
    return app


app = create_app()
