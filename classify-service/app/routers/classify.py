"""POST /classify: score texts against plain-language labels.

PRIVACY: the texts and labels are the customer's data. They are scored and
dropped. Log lines here carry counts, lengths, timings and exception CLASS
names only; never a text, a label, a score, or an exception message (a
tokenizer or model error can quote its input).
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.limits import AdmissionGate, Busy
from app.models import ClassifyRequest, ClassifyResponse, ClassifyResult
from app.services.classifier import Scored, engine_fingerprint, get_classifier

logger = logging.getLogger("classify.router")

router = APIRouter(tags=["classify"])

_gate: AdmissionGate | None = None


def get_gate() -> AdmissionGate:
    global _gate
    if _gate is None:
        _gate = AdmissionGate(settings.max_concurrency, settings.max_queue)
    return _gate


def reset_gate() -> None:
    """Rebuild the gate from the current settings on next use. Tests only."""
    global _gate
    _gate = None


def not_ready_detail(service) -> str:
    return "model_error" if service.load_error else "model_loading"


# A long text keeps its start and its last _TAIL_CHARS characters, the same
# cut the server makes (server/shared/expr/topics.mjs normalizeTopicText), so
# the token cut after it (ClassifierService.cap) still sees the real ending.
_TAIL_CHARS = 1000
_GAP = "\n…\n"


def _cut_one(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    tail = min(_TAIL_CHARS, max_chars // 4)
    return text[: max_chars - tail - len(_GAP)] + _GAP + text[-tail:]


def _cut(texts: list[str], max_chars: int) -> tuple[list[str], list[bool]]:
    return [_cut_one(t, max_chars) for t in texts], [len(t) > max_chars for t in texts]


def _result(scored: Scored, char_cut: bool, threshold: float | None) -> ClassifyResult:
    scores = {label: round(score, 4) for label, score in scored.scores.items()}
    matched = None
    if threshold is not None:
        # On the ROUNDED score, the one the caller sees: a caller that
        # recomputes `matched` from `scores` must get the same list.
        matched = [label for label, score in scores.items() if score >= threshold]
    return ClassifyResult(
        scores=scores, truncated=char_cut or scored.truncated, matched=matched
    )


async def _score(service, req: ClassifyRequest) -> tuple[list[ClassifyResult], float]:
    texts, char_cut = _cut(req.texts, settings.max_chars)
    started = time.perf_counter()
    try:
        # CPU-bound torch: on the event loop it would stall /health and every
        # queued request for the length of the pass.
        scored = await asyncio.to_thread(
            service.classify, texts, req.labels, settings.label_mode
        )
    except Exception as exc:
        logger.error(
            "classify.failed error=%s texts=%d labels=%d",
            type(exc).__name__,
            len(req.texts),
            len(req.labels),
        )
        raise HTTPException(status_code=500, detail="inference_error") from None
    ms = (time.perf_counter() - started) * 1000.0
    if len(scored) != len(texts):
        logger.error("classify.misaligned results=%d texts=%d", len(scored), len(texts))
        raise HTTPException(status_code=500, detail="inference_error")
    results = [
        _result(s, cut, req.threshold) for s, cut in zip(scored, char_cut, strict=True)
    ]
    return results, ms


@router.post(
    "/classify", response_model=ClassifyResponse, response_model_exclude_none=True
)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    service = get_classifier()
    if not service.ready:
        detail = not_ready_detail(service)
        logger.warning("classify.refused reason=%s texts=%d", detail, len(req.texts))
        raise HTTPException(status_code=503, detail=detail)

    gate = get_gate()
    try:
        async with gate.slot():
            results, ms = await _score(service, req)
    except Busy:
        logger.warning(
            "classify.busy in_flight=%d texts=%d", gate.admitted, len(req.texts)
        )
        raise HTTPException(status_code=429, detail="busy") from None

    logger.info(
        "classify ms=%.1f texts=%d labels=%d chars=%d truncated=%d matched=%s mode=%s",
        ms,
        len(req.texts),
        len(req.labels),
        sum(len(t) for t in req.texts),
        sum(1 for r in results if r.truncated),
        "-" if req.threshold is None else sum(len(r.matched or ()) for r in results),
        settings.label_mode,
    )
    return ClassifyResponse(
        results=results,
        labels=req.labels,
        model=service.model_id,
        revision=service.revision,
        engine=engine_fingerprint(service, settings),
        default_threshold=settings.default_threshold,
        ms=round(ms, 1),
    )
