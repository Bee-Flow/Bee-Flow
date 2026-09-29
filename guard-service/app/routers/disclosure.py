"""AI-disclosure classification router — POST /disclosure

Returns 200 with ``disclosed=null`` and ``degraded=true`` when there is
nothing to classify with — which, in the default image, is always, because no
encoder is baked into it (see app/services/disclosure/encoder.py). A 503 would
read to the caller as an outage to retry and alert on; this is not an outage,
it is a feature the operator did not ask for, and the Node side is built to
carry on without it. Same choice ``/pii`` makes when the GLiNER tier cannot
run: 200 with ``degraded``, and let the caller apply its own policy.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter

from app.config import settings
from app.models import DisclosureRequest, DisclosureResponse

logger = logging.getLogger("guard.disclosure.router")

router = APIRouter(tags=["disclosure"])


@router.post("/disclosure", response_model=DisclosureResponse)
async def classify_disclosure(req: DisclosureRequest) -> DisclosureResponse:
    """Does this text tell its reader that AI was involved in producing it?"""
    from app.services.disclosure import get_disclosure_service

    service = get_disclosure_service()
    if not settings.disclosure_enabled:
        result = {
            "disclosed": None,
            "similarity": None,
            "margin": None,
            "matched_anchor": None,
            "segments": 0,
            "degraded": True,
            "degraded_reason": "disclosure_disabled",
            "engine_fingerprint": None,
        }
        _elapsed_ms = 0.0
    else:
        _t0 = time.perf_counter()
        # Encoding is CPU-bound torch, so it must not run on the event loop —
        # one long classification there stalls every /health probe and every
        # in-flight /pii response on this pod.
        result = await asyncio.to_thread(
            service.classify,
            req.text,
            floor=settings.disclosure_floor,
            margin=settings.disclosure_margin,
            max_chars=settings.disclosure_max_chars,
        )
        _elapsed_ms = (time.perf_counter() - _t0) * 1000.0

    # PRIVACY: lengths, counts, similarities and OUR anchor ids only. Never the
    # submitted text and never a fragment of it — the same rule routers/pii.py
    # states for spans. Text arrives, is compared, and is dropped.
    try:
        logger.info(
            "disclosure.classify ms=%.1f chars=%d segments=%d disclosed=%s "
            "similarity=%s margin=%s anchor=%s degraded=%s reason=%s",
            _elapsed_ms,
            len(req.text or ""),
            result.get("segments", 0),
            result.get("disclosed"),
            result.get("similarity"),
            result.get("margin"),
            result.get("matched_anchor") or "-",
            bool(result.get("degraded")),
            result.get("degraded_reason") or "-",
        )
    except Exception:  # logging must never break a classification response
        logger.debug("disclosure.classify log line failed", exc_info=True)

    return DisclosureResponse(**result)
