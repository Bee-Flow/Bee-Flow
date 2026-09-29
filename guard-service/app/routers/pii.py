"""
PII detection router — POST /pii, and POST /pii/probe for tuning custom labels.
"""

from __future__ import annotations

import logging
import time
from collections import Counter

from fastapi import APIRouter, HTTPException

from app.models import (
    CustomPiiEntity,
    PiiEntity,
    PiiRequest,
    PiiResponse,
    ProbeCandidate,
    ProbeRequest,
    ProbeResponse,
)

logger = logging.getLogger("guard.pii.router")

router = APIRouter(tags=["pii"])


def _engine_fp(enabled_regions=None, custom_labels=None) -> str | None:
    """Never let provenance break a detection response — absent means the
    caller must treat the result as un-memoisable, which is the safe default."""
    try:
        from app.services.pii import custom_label_digest, engine_fingerprint_digest

        return engine_fingerprint_digest(
            enabled_regions, custom_label_digest(custom_labels)
        )
    except Exception:  # pragma: no cover - defensive
        logger.debug("engine fingerprint unavailable", exc_info=True)
        return None


def _custom_log_fields(custom_labels, result: dict) -> tuple[int, int, str]:
    """(labels asked, entities found, found per id). Opaque ids and counts
    ONLY: a prompt is customer-authored text about what their data looks like,
    and must never reach a log line."""
    found = result.get("custom_entities") or ()
    by_id = Counter(e["category"] for e in found)
    return (
        len(custom_labels or ()),
        len(found),
        str(dict(sorted(by_id.items())) or "{}"),
    )


@router.post("/pii", response_model=PiiResponse)
async def detect_pii(req: PiiRequest) -> PiiResponse:
    """
    Detect PII in text using the CPU-based GLiNER multi PII v1 model.

    When the model isn't ready the response still returns 200 with the
    regex-only entities, but ``degraded=true`` so the caller knows the
    result may be incomplete.
    """
    from app.services.pii import get_pii_service

    service = get_pii_service()
    custom_labels = (
        [label.model_dump() for label in req.custom_labels]
        if req.custom_labels
        else None
    )
    _t0 = time.perf_counter()
    result = await service.detect_async(
        text=req.text,
        confidence_threshold=req.confidence_threshold,
        enabled_categories=req.enabled_categories,
        enabled_regions=req.enabled_regions,
        custom_labels=custom_labels,
    )
    _elapsed_ms = (time.perf_counter() - _t0) * 1000.0

    # Per-request structured line. This is the only latency signal the service
    # emits, and the substrate for shadow-mode analysis during the GLiNER-only
    # rollout (which category did which tier find?).
    #
    # PRIVACY: counts, category NAMES and durations only. Never span text, never
    # the input. A category name is not personal data; a span is.
    try:
        from app.services.pii import _effective_regions

        _by_cat = Counter(e["category"] for e in result.get("entities", ()))
        _regions = _effective_regions(req.enabled_regions)
        _stats = result.get("scan_stats") or {}
        _n_custom, _n_custom_found, _custom_by_id = _custom_log_fields(
            custom_labels, result
        )
        logger.info(
            "pii.scan tier_mode=%s regions=%s ms=%.1f chars=%d entities=%d "
            "degraded=%s reason=%s cache=%s sem_wait_ms=%s lock_wait_ms=%s "
            "chunks=%s groups=%s passes=%s workers=%s predict_ms=%s "
            "predict_ms_max=%s by_category=%s near_miss=%s "
            "custom_labels=%d custom_entities=%d custom_chunks=%s custom_by_id=%s",
            result.get("tier_mode") or "on",
            ",".join(sorted(_regions)) if _regions else "*",
            _elapsed_ms,
            len(req.text or ""),
            len(result.get("entities", ())),
            bool(result.get("degraded")),
            result.get("degraded_reason") or "-",
            # Decomposition of ms=: cache disposition, time queued on the
            # admission semaphore, time queued on the pod-wide inference lock,
            # and the work shape (chunks x groups = forward passes). "Queued"
            # and "slow" look identical in a total duration; these fields are
            # what tell them apart without log archaeology.
            _stats.get("cache", "-"),
            _stats.get("sem_wait_ms", "-"),
            _stats.get("lock_wait_ms", "-"),
            _stats.get("chunks", "-"),
            _stats.get("groups", "-"),
            # passes = forward passes actually issued; workers = how many ran
            # concurrently; predict_ms = SUM of time inside the model (so it
            # exceeds ms= under fan-out, by design — the ratio to ms= is the
            # achieved parallelism). predict_ms_max is the slowest single pass,
            # which is the number that moves when the MODEL gets slower rather
            # than when the work got bigger.
            _stats.get("passes", "-"),
            _stats.get("workers", "-"),
            _stats.get("predict_ms", "-"),
            _stats.get("predict_ms_max", "-"),
            dict(sorted(_by_cat.items())) or "{}",
            # "<Category>:<reason>" -> count. A shape that matched but died on
            # its checksum/anchor — the only trace a near-miss leaves (under
            # tier=on nothing else ever sees these candidates).
            dict(sorted((result.get("near_miss_counts") or {}).items())) or "{}",
            _n_custom,
            _n_custom_found,
            _stats.get("custom_chunks", "-"),
            _custom_by_id,
        )
    except Exception:  # logging must never break a detection response
        logger.debug("pii.scan log line failed", exc_info=True)

    custom_entities = result.get("custom_entities")

    return PiiResponse(
        hasPii=result["hasPii"],
        entities=[PiiEntity(**e) for e in result["entities"]],
        degraded=bool(result.get("degraded")),
        degraded_reason=result.get("degraded_reason"),
        degraded_categories=result.get("degraded_categories"),
        processed_chars=result.get("processed_chars"),
        total_chars=result.get("total_chars"),
        tier_mode=result.get("tier_mode"),
        engine_fingerprint=_engine_fp(req.enabled_regions, custom_labels),
        custom_entities=(
            [CustomPiiEntity(**e) for e in custom_entities]
            if custom_entities is not None
            else None
        ),
    )


@router.post("/pii/probe", response_model=ProbeResponse)
async def probe_pii(req: ProbeRequest) -> ProbeResponse:
    """Raw GLiNER candidates for up to six custom labels on up to eight texts.

    For the admin's test bench: every candidate at the query floor (0.10)
    after word-edge repair, with its score, so the caller can fit a floor.
    No floors, no overlap resolution, no cache, no global state. 503 when the
    model cannot run: a tuning answer without the model is no answer.
    """
    from app.services.pii import ProbeUnavailable, get_pii_service

    service = get_pii_service()
    if not service.ready:
        raise HTTPException(status_code=503, detail="model_not_ready")
    _t0 = time.perf_counter()
    try:
        candidates = await service.probe_async(req.texts, dict(req.label_set))
    except ProbeUnavailable as exc:
        logger.warning("pii.probe unavailable reason=%s", exc.reason)
        raise HTTPException(status_code=503, detail=exc.reason) from None

    # PRIVACY: counts, lengths and opaque ids only — never a text, a span or a
    # prompt (the same rule as the pii.scan line).
    try:
        logger.info(
            "pii.probe ms=%.1f texts=%d chars=%d labels=%d candidates=%d by_label=%s",
            (time.perf_counter() - _t0) * 1000.0,
            len(req.texts),
            sum(len(t) for t in req.texts),
            len(req.label_set),
            len(candidates),
            dict(sorted(Counter(c["label"] for c in candidates).items())) or "{}",
        )
    except Exception:  # logging must never break a probe response
        logger.debug("pii.probe log line failed", exc_info=True)

    return ProbeResponse(
        candidates=[ProbeCandidate(**c) for c in candidates], model_ready=True
    )
