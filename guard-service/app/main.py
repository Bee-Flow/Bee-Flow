"""
Guard Service — FastAPI application entry point.
CPU-based PII detection using GLiNER multi PII v1 (Apache 2.0).
"""

from __future__ import annotations

# Pin BLAS/OpenMP thread counts to the cgroup CPU quota BEFORE numpy / torch /
# onnxruntime are imported anywhere — those libraries read these env vars once,
# at first import, and otherwise default to the node's core count (8 on PRO2-S)
# inside our 3-core pod limit, causing CFS throttling. Must stay first.
from app.cpu import apply_thread_env

_THREAD_CORES = apply_thread_env()

import logging
import threading
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.dependencies import close_http, close_redis, init_http, init_redis
from app.models import HealthResponse
from app.routers import disclosure, pii

logger = logging.getLogger("guard")

# API-contract version of this service — the single constant behind both the
# OpenAPI version and the `version` field on /health and /ready. Bump the
# MINOR on any request-contract change (a new accepted field, stricter
# validation): the server probes /health and only sends fields this build
# declares it knows. Older builds have no `version` in their health body —
# the absence itself means "pre-2.1 contract" (U9). Distinct from `engine`,
# which fingerprints the detection engine, not the API.
# 2.1.0 — /pii rejects unknown request fields (extra="forbid").
# 2.2.0 — adds POST /disclosure (AI-disclosure classifier). A build below this
#         has no such route, which a caller sees as a 404 and must read as "no
#         opinion" — the same thing an unbaked encoder on THIS build returns.
# 2.3.0 — /pii accepts custom_labels (organisation-defined labels, answered in
#         a separate custom_entities list) and adds POST /pii/probe (raw
#         candidates for tuning them). The server sends custom_labels only to
#         a build that reports at least this version.
SERVICE_VERSION = "2.3.0"


# Warm-load retry schedule (seconds). A transient failure — slow model
# warmup, a brief HuggingFace hiccup on the ONNX-absent fallback path —
# must not latch the model off permanently (BFSF-269). Bounded so a
# genuinely-broken image surfaces via /ready rather than looping forever.
_WARM_LOAD_BACKOFF = (5, 15, 30, 60, 120)
# After the bounded backoff is exhausted, keep retrying forever at this
# interval. Under GLiNER-only a pod that stops retrying can never serve
# again, and fail-closed turns that into a full outage rather than a
# degraded one — so give up is not an option we can afford.
_WARM_LOAD_RETRY_FOREVER = 300


def _warm_pii_model() -> None:
    """Load PII model in a background thread so it doesn't block startup.

    Retries with backoff on failure; ``load()`` records the last error on
    the service so /health and /ready can surface it between attempts.
    """
    if not settings.pii_enabled:
        logger.info("PII model disabled via GUARD_PII_ENABLED=false, skipping load")
        return

    import time
    from app.services.pii import get_pii_service

    svc = get_pii_service()
    for attempt, delay in enumerate((0, *_WARM_LOAD_BACKOFF)):
        if delay:
            logger.warning(
                "[PiiService] warm-load retry %d/%d in %ds (last error: %s)",
                attempt,
                len(_WARM_LOAD_BACKOFF),
                delay,
                svc.load_error,
            )
            time.sleep(delay)
        try:
            svc.load(settings.pii_model)
        except Exception as exc:  # load() catches internally; belt-and-braces
            logger.error("PII model warm-load raised: %s", exc)
        if svc.ready:
            return

    # Do NOT stop retrying. The old behaviour gave up after ~4 minutes and the
    # thread exited, leaving the pod permanently 503 on /ready with nothing to
    # restart it — survivable only because the regex tier still answered.
    #
    # Under GLiNER-only there is no second tier: a pod that has given up is a
    # pod that can never serve again, and because degraded results fail closed
    # by default that is a full chat outage rather than a degraded one. So the
    # loop continues at a long fixed interval, which turns a transient model or
    # storage hiccup into a self-healing delay instead of a manual restart.
    import time as _time

    logger.error(
        "[PiiService] model not ready after %d attempts (last error: %s) — "
        "the service can serve NOTHING until it loads; retrying every %ds",
        len(_WARM_LOAD_BACKOFF) + 1,
        svc.load_error,
        _WARM_LOAD_RETRY_FOREVER,
    )
    while not svc.ready:
        _time.sleep(_WARM_LOAD_RETRY_FOREVER)
        try:
            svc.load(settings.pii_model)
        except Exception as exc:
            logger.error("PII model warm-load raised: %s", exc)
        if svc.ready:
            logger.info("[PiiService] model recovered after extended retry")
            return


def _warm_disclosure_encoder() -> None:
    """Load the AI-disclosure encoder and embed its anchor bank, once.

    NO RETRY LOOP, unlike _warm_pii_model above, and the difference is the
    point: a PII model that will not load blocks chat on a fail-closed org, so
    that loop can never give up. This encoder is optional and, in the default
    image, absent — retrying forever for a directory that was never baked would
    fill the log with a failure nobody asked to avoid. One attempt; if it does
    not load, /disclosure says so on every call and the Art. 50 keyword rule
    carries on alone, which is what it did before this existed.
    """
    if not settings.disclosure_enabled:
        logger.info("Disclosure classifier disabled via GUARD_DISCLOSURE_ENABLED=false")
        return
    from app.services.disclosure import get_disclosure_service

    svc = get_disclosure_service()
    try:
        svc.load(
            settings.disclosure_model_dir, max_tokens=settings.disclosure_max_tokens
        )
    except Exception as exc:  # load() records internally; belt-and-braces
        logger.error("Disclosure encoder warm-load raised: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application startup / shutdown lifecycle."""
    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    import os
    from app.cpu import cgroup_quota_cores

    logger.info(
        "Starting %s … CPU budget: %d thread(s) (node=%d, cgroup-quota=%s)",
        settings.app_name,
        _THREAD_CORES,
        os.cpu_count() or 1,
        cgroup_quota_cores() or "unlimited",
    )

    # Validate the detection tier mode NOW so a typo'd GUARD_PII_REGEX_TIER
    # crashes the pod at startup (visible: CrashLoopBackOff) rather than
    # surfacing as a 500 on the first scan, or — far worse — being silently
    # coerced to a mode the operator did not intend.
    from app.services.pii import resolve_tier_mode

    _tier_mode = resolve_tier_mode()
    if _tier_mode != "on":
        logger.warning(
            "[PiiService] detection tier mode is %r (GUARD_PII_REGEX_TIER). %s",
            _tier_mode,
            "Both tiers run and the union is returned; per-tier category COUNTS "
            "are logged (not a span diff — production has no gold labels). "
            "This is the most expensive mode: it pays for both tiers at once."
            if _tier_mode == "shadow"
            else "The regex tier is DISABLED — GLiNER is the only detector.",
        )
    else:
        logger.info("[PiiService] detection tier mode: on (regex + GLiNER)")

    await init_redis()
    await init_http()

    # Warm-load PII model in background — first load can take a few seconds.
    threading.Thread(target=_warm_pii_model, daemon=True, name="pii-warm-load").start()

    # And the optional AI-disclosure encoder, on its own thread so a slow or
    # absent one never delays the model this pod actually exists to serve.
    threading.Thread(
        target=_warm_disclosure_encoder, daemon=True, name="disclosure-warm-load"
    ).start()

    logger.info("Guard service ready")
    yield

    logger.info("Shutting down …")
    await close_http()
    await close_redis()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Guard Service",
    description="CPU-based PII detection via GLiNER multi PII v1 (Apache 2.0).",
    version=SERVICE_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

import os

from app.api_key_auth import APIKeyMiddleware

_SERVICES_API_KEY = os.getenv("SERVICES_API_KEY", "")
if _SERVICES_API_KEY:
    app.add_middleware(APIKeyMiddleware, api_key=_SERVICES_API_KEY)

app.include_router(pii.router)
app.include_router(disclosure.router)


def _pii_status() -> tuple[bool, str, str | None, str | None]:
    """Return (ready, pii_model_state, backend, load_error)."""
    from app.services.pii import get_pii_service

    if not settings.pii_enabled:
        return True, "disabled", None, None
    try:
        svc = get_pii_service()
        if svc.ready:
            return True, "ok", svc.backend, None
        # Not ready: distinguish "still loading" from "load failed".
        state = "error" if svc.load_error else "loading"
        return False, state, svc.backend, svc.load_error
    except Exception as exc:  # pragma: no cover - defensive
        return False, "error", None, f"{type(exc).__name__}: {exc}"


def _engine_digest() -> str | None:
    """Engine identity for external cache keys; never fatal to a probe."""
    try:
        from app.services.pii import engine_fingerprint_digest

        return engine_fingerprint_digest()
    except Exception:  # pragma: no cover - defensive
        return None


@app.get("/health", response_model=HealthResponse)
async def health(response: Response) -> HealthResponse:
    """Health check with PII model and cache status.

    Returns HTTP 503 when PII is enabled but the model isn't ready, so an
    orchestrator's health/readiness probe never marks a pod that can only
    do regex-only detection as healthy (BFSF-269).
    """
    from app.dependencies import get_redis

    cache_ok = False
    try:
        redis = get_redis()
        await redis.ping()
        cache_ok = True
    except Exception:
        pass

    pii_ready, pii_state, backend, load_error = _pii_status()

    # The model is the load-bearing dependency; Redis is an optional cache.
    healthy = pii_ready
    if not healthy:
        response.status_code = 503

    return HealthResponse(
        status="ok" if healthy else "degraded",
        service=settings.app_name,
        cache="ok" if cache_ok else "unavailable",
        pii_model=pii_state,
        backend=backend,
        load_error=load_error,
        engine=_engine_digest(),
        version=SERVICE_VERSION,
    )


@app.get("/ready", response_model=HealthResponse)
async def ready(response: Response) -> HealthResponse:
    """Readiness probe — 200 only once the PII model is loaded.

    Wire the k8s ``readinessProbe`` here so traffic is held back from a pod
    whose GLiNER model failed to load, instead of silently serving
    regex-only detections.
    """
    pii_ready, pii_state, backend, load_error = _pii_status()
    if not pii_ready:
        response.status_code = 503
    return HealthResponse(
        status="ok" if pii_ready else "degraded",
        service=settings.app_name,
        cache="unknown",
        pii_model=pii_state,
        backend=backend,
        load_error=load_error,
        engine=_engine_digest(),
        version=SERVICE_VERSION,
    )
