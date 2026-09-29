"""The async entry point: the result cache and the pod-wide inference gate.

``detect_async`` is what the router calls. It owns the two size ceilings
(refuse outright / scan a bounded prefix), the opt-out Redis cache keyed by
the engine fingerprint, and the semaphore that bounds simultaneous inferences
so one big scan cannot starve every other user. A degraded result is never
cached.
"""

from __future__ import annotations

import logging

from .custom_labels import _CustomSpec
from .detection import ScanRequest
from .fingerprint import _engine_fingerprint
from .noise import _is_skippable
from .scan_policy import _effective_regions, _scan_budget_chars, resolve_tier_mode

logger = logging.getLogger("guard.pii")

# Bumped whenever the cache-key derivation changes. The prefix carries it too,
# so a deploy simply stops reading entries whose provenance it cannot verify
# rather than serving them under new semantics.
# v4: the key now carries the effective detection REGIONS. Without it a
# region-scoped tenant and an all-regions tenant shared entries, and regions
# change which patterns run and which categories GLiNER is asked about — so the
# narrower scan's blind spots would have been served as the broader one's result.
# v5: the key carries the request's custom labels (id, prompt, base floor), and
# beside them tells enabled_categories [] ("no built-ins") from None ("all").
_CACHE_SCHEMA_VERSION = 5


# Bounds concurrent GLiNER inferences per pod so one big-document scan can
# never oversubscribe cores / balloon memory and starve other users. Lazily
# created so it binds to the running event loop.
_inference_semaphore = None


def _get_inference_semaphore():
    global _inference_semaphore
    if _inference_semaphore is None:
        import asyncio
        from app.config import settings

        _inference_semaphore = asyncio.Semaphore(max(1, settings.pii_max_concurrency))
    return _inference_semaphore


def reset_inference_semaphore() -> None:
    """Drop the semaphore so the next call binds one to the current loop.

    A semaphore belongs to the event loop it was created on, so a test that
    runs its own loop — or patches `pii_max_concurrency` — must be able to let
    go of the previous one. Same reasoning as reset_engine_fingerprint(): a
    call, so the seam is visible, instead of an assignment that only worked
    because the package mirrored it here.
    """
    global _inference_semaphore
    _inference_semaphore = None


def _categories_key(
    enabled_categories: list[str] | None, custom: _CustomSpec | None
) -> list[str] | None:
    """The categories component of the key.

    Without custom labels [] and None both mean "every category" and share an
    entry, as they always did. With custom labels [] means "no built-ins", so
    the two must key apart or one would be served the other's answer."""
    if custom is None:
        return sorted(enabled_categories) if enabled_categories else None
    return sorted(enabled_categories) if enabled_categories is not None else None


def _cache_key(req: ScanRequest) -> str:
    """sha256 over everything that decides the answer, namespaced by schema."""
    import hashlib
    import json

    key_payload = json.dumps(
        [
            _CACHE_SCHEMA_VERSION,
            req.text,
            round(req.confidence_threshold, 4),
            _categories_key(req.enabled_categories, req.custom),
            # The EFFECTIVE regions, not the request's, so a request
            # that omits them and a request that names the pod
            # default share an entry — while two tenants scoped to
            # different countries never do. Regions change both which
            # patterns run AND which categories GLiNER is asked
            # about, so a shared entry here would serve one tenant's
            # blind spots to another.
            sorted(_effective_regions(req.enabled_regions) or []) or None,
            # Identity of the CONFIGURATION that produced the
            # result — see _engine_fingerprint().
            _engine_fingerprint(),
            # The custom labels, canonically ordered: (id, prompt, base floor).
            # Two tenants with the same ids but different prompts or floors
            # must never share an entry.
            req.custom.cache_material() if req.custom is not None else None,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(key_payload.encode("utf-8")).hexdigest()
    return f"guard:pii:v{_CACHE_SCHEMA_VERSION}:{digest}"


def _unscanned(reason: str | None, custom: _CustomSpec | None) -> dict:
    """The envelope for input that was never scanned: trivial (reason None) or
    refused. A request with custom labels still gets its (empty) list."""
    out: dict = {
        "hasPii": False,
        "entities": [],
        "degraded": reason is not None,
        "degraded_reason": reason,
    }
    if custom is not None:
        out["custom_entities"] = []
    return out


class _CacheAware:
    """``PiiService``'s async, cached entry point. Mixed into the service."""

    async def detect_async(
        self,
        text: str,
        confidence_threshold: float = 0.7,
        enabled_categories: list[str] | None = None,
        enabled_regions: list[str] | None = None,
        custom_labels: list[dict] | None = None,
    ) -> dict:
        """Cache-aware async wrapper around ``detect()``.

        Identical inputs return identical outputs, so cache the JSON-
        encoded response in Redis keyed by sha256 of the normalised
        inputs. TTL is short (10 min) — chat replay / multi-turn
        rehydration are the dominant cache-hit scenarios. The hot path
        cost on a hit is one Redis GET (~0.3 ms) vs ~300-500 ms for
        regex + ONNX inference.

        The cache is *opt-out*: if Redis is unavailable or any cache
        operation throws, we silently bypass and call ``detect()``
        directly so a Redis outage never blocks PII detection.

        ``custom_labels`` (``[{id, prompt, floor}]``) adds the request's
        organisation-defined labels; see ``custom_labels.py``. Absent or
        empty, everything here is exactly what it was before they existed.
        """
        import json
        from app.config import settings

        custom = _CustomSpec.from_request(custom_labels, confidence_threshold)

        # Trivial inputs skip both the cache and the model — match
        # the early-return in ``detect()`` so we don't fill Redis with
        # empty results.
        if _is_skippable(text):
            return _unscanned(None, custom)

        # Size handling (two ceilings):
        #  * > pii_hard_max_chars → refuse outright (bounds just holding the
        #    string in memory). Fail closed via degraded=input_too_large.
        #  * over the WORK budget (_scan_budget_chars) → scan a bounded PREFIX
        #    and return a partial result (processed_chars/total_chars) instead
        #    of dropping everything, so a huge doc still gets the redactions we
        #    computed while the unscanned tail is failed closed by a
        #    coverage-aware caller (BFSF-269).
        #
        # The work budget used to be pii_max_chars (1M), which is a memory
        # bound, not a time bound — so "too big to scan in the 90s the caller
        # waits" had no ceiling at all and simply timed out. See
        # _scan_budget_chars.
        scan_char_limit: int | None = None
        hard_max = getattr(settings, "pii_hard_max_chars", settings.pii_max_chars)
        if len(text) > hard_max:
            logger.warning(
                "[PiiService] input too large (%d chars > hard cap %d) — refusing scan (degraded)",
                len(text),
                hard_max,
            )
            return _unscanned("input_too_large", custom)
        budget = _scan_budget_chars()
        if len(text) > budget:
            scan_char_limit = budget
            logger.warning(
                "[PiiService] input large (%d chars > scan budget %d, tier=%s) — "
                "partial scan of prefix",
                len(text),
                budget,
                resolve_tier_mode(),
            )

        req = ScanRequest(
            text,
            confidence_threshold,
            enabled_categories,
            scan_char_limit,
            enabled_regions,
            custom,
        )
        cache_key: str | None = None
        redis = None
        try:
            from app.dependencies import get_redis

            redis = get_redis()
        except Exception:
            redis = None

        if redis is not None:
            try:
                cache_key = _cache_key(req)

                cached = await redis.get(cache_key)
                if cached:
                    hit = json.loads(cached)
                    # Disposition for the pii.scan line only — never written
                    # back to Redis, so cached payloads stay disposition-free.
                    hit.setdefault("scan_stats", {})["cache"] = "hit"
                    return hit
            except Exception as exc:
                logger.debug("[PiiService] cache lookup failed: %s", exc)
                cache_key = None

        # ── Cache miss — run detection under the concurrency gate ─────
        # The semaphore bounds simultaneous inferences so a big scan can't
        # oversubscribe cores / balloon memory; extra requests await here
        # (the event loop stays free to serve cache hits + health checks).
        # The wait is measured: a request that spent 9 of its 10 seconds
        # HERE was queued, not slow — the distinction the incident analysis
        # had to reconstruct from log archaeology.
        import asyncio
        import time as _time

        _sem_t0 = _time.perf_counter()
        async with _get_inference_semaphore():
            _sem_wait_ms = (_time.perf_counter() - _sem_t0) * 1000
            result = await asyncio.to_thread(self.detect_request, req)

        # Never cache a degraded (regex-only) result — otherwise the
        # incomplete entity set would be served for 10 min after the model
        # recovers, silently under-redacting (BFSF-269).
        if cache_key is not None and redis is not None and not result.get("degraded"):
            try:
                await redis.set(
                    cache_key,
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    ex=600,
                )
            except Exception as exc:
                logger.debug("[PiiService] cache write failed: %s", exc)

        # AFTER the cache write, so sem-wait and disposition never enter Redis
        # (they describe THIS request, not the payload).
        stats = result.setdefault("scan_stats", {})
        stats["sem_wait_ms"] = round(_sem_wait_ms, 1)
        stats["cache"] = "miss" if cache_key else "bypass"
        return result
