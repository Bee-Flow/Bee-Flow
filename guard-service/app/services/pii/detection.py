"""The detection pass: text in, UNRESOLVED candidate spans out.

The two-tier pipeline — the deterministic regex tier plus the BSN checksum
carve-out, then GLiNER over the active label groups — together with everything
that shapes it: category gating, the per-category acceptance floor, chunk
fan-out across predict workers, the degraded signal, and the partial-scan
boundary for oversize input. Overlap resolution is deliberately NOT here: it
lives in ``overlaps`` so ``detect_candidates`` can skip it.

A request may also carry CUSTOM labels (organisation-defined, see
``custom_labels``). They run as one extra label group, AFTER the built-in
passes, with their own floors and their own chunk budget, and their spans are
collected into a separate list that never meets the built-in candidates. With
no custom labels every step below is the path it always was.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from functools import partial

from .categories import CATEGORY_LABELS, GLINER_LABELS_TO_CATEGORY
from .chunking import (
    _CUSTOM_CHUNK_CHAR_LIMIT,
    _MIN_TEXT_TOKEN_BUDGET,
    _PRETRIM_MARGIN_CHARS,
    _ChunkBudget,
    _overlap_tokens_for,
)
from .custom_labels import CUSTOM_SOURCE, _CustomSpec
from .inference import _MODEL_BATCH_SIZE
from .label_groups import _grouped_categories, label_groups
from .noise import _is_noise_person_org, _is_skippable
from .overlaps import _finalise_custom
from .postprocess import (
    _apply_validators,
    _postprocess_entities,
    _precision_filter,
)
from .scan_policy import configured_regions, resolve_tier_mode
from .thresholds import (
    _ABSOLUTE_CEIL,
    _ABSOLUTE_FLOOR,
    _PER_CATEGORY_THRESHOLD,
    _UI_DEFAULT_THRESHOLD,
)

logger = logging.getLogger("guard.pii")

# One (label group x chunk slice) forward pass, as queued for the workers. The
# labels are a list for a shipped group and the {id: prompt} mapping for the
# custom one (gliner 0.2.29 returns the mapping's KEYS as labels).
_Labels = list[str] | dict[str, str]
_ScanUnit = tuple[int, _Labels, float, list[str], list[int], int]
# (chunks, processed_chars, total_chars) for one chunk list.
_ChunkPlan = tuple[list[tuple[int, str]], int | None, int | None]
# What a worker answers: the per-chunk raw spans, or the exception instead.
_Outcome = tuple[list[list[dict]] | None, Exception | None]


@dataclass(frozen=True)
class ScanRequest:
    """One scan, as the service runs it.

    ``custom`` is None for every caller that predates custom labels, and then
    the scan is exactly the historical one. The positional order matches
    ``detect()``'s parameters.
    """

    text: str
    confidence_threshold: float = 0.7
    enabled_categories: list[str] | None = None
    scan_char_limit: int | None = None
    enabled_regions: list[str] | None = None
    custom: _CustomSpec | None = None


@dataclass(frozen=True)
class _ScanScope:
    """What one request asked for, resolved against the pod's policy."""

    enabled_set: frozenset[str] | None
    tier_mode: str
    region_set: frozenset[str] | None


@dataclass
class _Deterministic:
    """The regex tier's spans, the BSN carve-out's spans, and the near-miss
    counters. Both lists stay apart: the shadow-mode diff reads regex only."""

    regex: list[dict]
    bsn: list[dict]
    stats: dict

    @property
    def entities(self) -> list[dict]:
        return self.regex + self.bsn


@dataclass
class _Timings:
    """Request-local accumulators for the pii.scan line: time spent waiting
    for the inference lock, and time inside each forward pass."""

    lock_wait_ms: list[float] = field(default_factory=list)
    predict_ms: list[float] = field(default_factory=list)


def _resolve_scope(
    enabled_categories: list[str] | None,
    enabled_regions: list[str] | None,
    custom: bool = False,
) -> _ScanScope:
    from app.services.pii_regex import normalise_regions

    # [] has always meant "every category", and still does on its own. Beside
    # custom labels it means "none of the built-in ones": a request that asks
    # only for its own labels must neither pay for nor receive the rest.
    if enabled_categories:
        enabled_set: frozenset[str] | None = frozenset(enabled_categories)
    elif custom and enabled_categories is not None:
        enabled_set = frozenset()
    else:
        enabled_set = None
    # Per-request regions win over the pod default so one tenant can be
    # narrowed without redeploying; None from both means every region.
    region_set = (
        normalise_regions(enabled_regions)
        if enabled_regions is not None
        else configured_regions()
    )
    return _ScanScope(enabled_set, resolve_tier_mode(), region_set)


def _deterministic_tier(text: str, scope: _ScanScope) -> _Deterministic:
    """Tier 1. The regex tier is skipped in `off`; in `shadow` it still runs
    and still contributes, so only the observability differs from `on`."""
    from app.services.pii_bsn import detect_bsn
    from app.services.pii_regex import detect_regex_pii

    stats: dict = {}
    regex_entities = (
        []
        if scope.tier_mode == "off"
        else detect_regex_pii(
            text,
            enabled_categories=scope.enabled_set,
            enabled_regions=scope.region_set,
            stats=stats,
        )
    )
    # Provenance tags: calibration must sweep model spans only, and a
    # validator's fixed 0.99 would turn a threshold curve into a step function.
    for ent in regex_entities:
        ent.setdefault("source", "regex")
    # The elfproef carve-out runs in `off` only: an unanchored nine-digit BSN
    # carries no signal a NER can read (measured recall 0.04). In `on`/`shadow`
    # the regex tier emits the same spans and _finalise dedups them.
    bsn_entities = (
        detect_bsn(text, enabled_categories=scope.enabled_set)
        if scope.tier_mode == "off"
        else []
    )
    for ent in bsn_entities:
        ent.setdefault("source", "validator")
    return _Deterministic(regex_entities, bsn_entities, stats)


def _model_categories(scope: _ScanScope) -> set[str]:
    """The categories GLiNER is asked about.

    In `on`, the categories the regex tier owns end-to-end for the ACTIVE
    regions are dropped so the NER spends its attention where it helps; in
    `shadow`/`off` it is asked about everything.
    """
    from app.services.pii_regex import regex_complete_categories

    excluded = (
        regex_complete_categories(scope.region_set)
        if scope.tier_mode == "on"
        else frozenset()
    )
    if scope.enabled_set is None:
        categories = {
            cat for cat in GLINER_LABELS_TO_CATEGORY.values() if cat not in excluded
        }
    else:
        categories = {cat for cat in scope.enabled_set if cat not in excluded}

    # A category with no label in any group yields silence, which in a privacy
    # product reads as "clean" — say so whenever the regex tier is not covering.
    if scope.tier_mode != "on":
        uncovered = categories - _grouped_categories()
        if uncovered:
            logger.warning(
                "[PiiService] tier_mode=%s but %d requested categor(y/ies) have no "
                "GLiNER label in any label group and CANNOT be detected: %s",
                scope.tier_mode,
                len(uncovered),
                sorted(uncovered),
            )
    return categories


def _active_label_groups(categories: set[str]) -> list[list[str]]:
    """Per-group label lists intersected with the categories GLiNER is
    responsible for; a group with no active labels is a wasted model call."""
    active_groups: list[list[str]] = []
    for group in label_groups():
        active = [
            lbl for lbl in group if GLINER_LABELS_TO_CATEGORY.get(lbl) in categories
        ]
        if active:
            active_groups.append(active)
    return active_groups


def _acceptance_floor(category: str, confidence_threshold: float) -> float:
    """The per-category floor, shifted by (slider - anchor) so the slider works
    in both directions while the relative tuning between categories holds.
    Categories without a tuned entry track the slider directly (BFSF-269)."""
    tuned = _PER_CATEGORY_THRESHOLD.get(category)
    if tuned is not None:
        shifted = tuned + (confidence_threshold - _UI_DEFAULT_THRESHOLD)
        return min(_ABSOLUTE_CEIL, max(_ABSOLUTE_FLOOR, shifted))
    return min(_ABSOLUTE_CEIL, max(_ABSOLUTE_FLOOR, confidence_threshold))


def _query_threshold(group: list[str]) -> float:
    """The threshold to QUERY the model with — deliberately not the floor.

    GLiNER's span decoding is greedy and the threshold takes part in it, so a
    high query threshold changes which spans exist at all (a fitted IBAN floor
    of 0.92 as the query threshold found 0 of 90 IBANs). Query low; filter per
    category in ``_SpanCollector.accept``, the one place a floor is applied.
    """
    return _ABSOLUTE_FLOOR


class _SpanCollector:
    """Turns raw GLiNER spans (offsets local to their chunk) into accepted
    entities: the per-category floor, category gating, the Person/Org noise
    filter and cross-chunk dedup. Runs on the calling thread only.

    With a custom spec, a label the shipped map does not know is looked up in
    the spec: it is accepted at its own per-request floor, WITHOUT the
    Person/Org noise filter (a code name is no common noun), and collected into
    ``custom_entities`` so it never mixes with the built-in candidates."""

    def __init__(
        self,
        text: str,
        categories: set[str],
        confidence_threshold: float,
        custom: _CustomSpec | None = None,
    ) -> None:
        self._text = text
        self._categories = categories
        self._threshold = confidence_threshold
        self._custom = custom
        self._seen: set[tuple[int, int, str]] = set()
        self.entities: list[dict] = []
        self.custom_entities: list[dict] = []

    def _placed(self, ent: dict, chunk_offset: int) -> tuple[int, int, str]:
        local_start = int(ent.get("start", 0))
        local_end = int(ent.get("end", local_start))
        start = chunk_offset + local_start
        end = chunk_offset + local_end
        return start, end, ent.get("text") or self._text[start:end]

    def accept(self, ent: dict, chunk_offset: int) -> None:
        score = float(ent.get("score", 0))
        raw_label = (ent.get("label") or "").lower()
        category = GLINER_LABELS_TO_CATEGORY.get(raw_label)
        if category is None:
            if self._custom is not None and self._custom.knows(raw_label):
                self._accept_custom(raw_label, score, ent, chunk_offset)
            return
        if category not in self._categories:
            return
        if score < _acceptance_floor(category, self._threshold):
            return

        start, end, word = self._placed(ent, chunk_offset)

        if category in ("Person", "Organization") and _is_noise_person_org(word):
            return

        key = (start, end, category)
        if key in self._seen:
            return
        self._seen.add(key)

        self.entities.append(
            {
                "text": word,
                "category": category,
                "label": CATEGORY_LABELS.get(category, category),
                "confidence": round(score, 4),
                "offset": start,
                "length": end - start,
                "source": "model",
            }
        )

    def _accept_custom(
        self, label_id: str, score: float, ent: dict, chunk_offset: int
    ) -> None:
        if score < self._custom.floor_for(label_id):
            return
        start, end, word = self._placed(ent, chunk_offset)
        # Ids never equal a shipped category name, so one seen-set serves both.
        key = (start, end, label_id)
        if key in self._seen:
            return
        self._seen.add(key)
        self.custom_entities.append(
            {
                "text": word,
                "category": label_id,
                "label": label_id,
                "confidence": round(score, 4),
                "offset": start,
                "length": end - start,
                "source": CUSTOM_SOURCE,
            }
        )


def _scan_units(
    active_groups: list[_Labels],
    chunks: list[tuple[int, str]],
    first_group_idx: int = 0,
) -> list[_ScanUnit]:
    """A scan is a queue of independent (label group x chunk slice) passes;
    small fixed batches keep peak memory bounded per forward pass.
    ``first_group_idx`` numbers a group queued after others (the custom one)."""
    chunk_texts = [c for _, c in chunks]
    chunk_offsets = [off for off, _ in chunks]
    units: list[_ScanUnit] = []
    for group_idx, group_labels in enumerate(active_groups, first_group_idx):
        group_threshold = _query_threshold(group_labels)
        for i in range(0, len(chunk_texts), _MODEL_BATCH_SIZE):
            units.append(
                (
                    group_idx,
                    group_labels,
                    group_threshold,
                    chunk_texts[i : i + _MODEL_BATCH_SIZE],
                    chunk_offsets[i : i + _MODEL_BATCH_SIZE],
                    i,
                )
            )
    return units


def _collect_outcomes(
    units: list[_ScanUnit],
    outcomes: list[_Outcome],
    collector: _SpanCollector,
) -> tuple[dict[int, int], dict[int, int]]:
    """Feed every successful pass to the collector; count passes per group so
    a group can be judged failed only when EVERY one of its slices raised."""
    slices_total: dict[int, int] = {}
    slices_failed: dict[int, int] = {}
    for unit, (batched, exc) in zip(units, outcomes):
        group_idx, _labels, _thr, _texts, sub_offsets, _i = unit
        slices_total[group_idx] = slices_total.get(group_idx, 0) + 1
        if exc is not None or batched is None:
            slices_failed[group_idx] = slices_failed.get(group_idx, 0) + 1
            continue
        # zip() stops at the shorter side — safe if the batch length differs.
        for raw, chunk_offset in zip(batched, sub_offsets):
            for ent in raw:
                collector.accept(ent, chunk_offset)
    return slices_total, slices_failed


def _failed_groups(
    active_groups: list[_Labels],
    slices_total: dict[int, int],
    slices_failed: dict[int, int],
    label_map: dict[str, str] | None = None,
) -> tuple[int, set[str]]:
    """How many groups failed outright, and which categories lost coverage.

    ``label_map`` is the shipped map, merged with the custom ids when the
    request has any (a NEW dict; the shipped one is never written to), so a
    dead custom group reports exactly its own ids."""
    label_map = GLINER_LABELS_TO_CATEGORY if label_map is None else label_map
    groups_failed = 0
    failed_categories: set[str] = set()
    for group_idx, group_labels in enumerate(active_groups):
        total = slices_total.get(group_idx, 0)
        if total > 0 and slices_failed.get(group_idx, 0) == total:
            groups_failed += 1
            failed_categories.update(
                label_map[lbl] for lbl in group_labels if lbl in label_map
            )
    return groups_failed, failed_categories


def _label_map(custom: _CustomSpec | None) -> dict[str, str] | None:
    if custom is None:
        return None
    return {**GLINER_LABELS_TO_CATEGORY, **custom.label_to_category}


def _not_ready_envelope(
    load_error: str | None,
    categories: set[str],
    custom: _CustomSpec | None,
    envelope: dict,
) -> dict:
    """Regex-only is DEGRADED so the Node side fails closed instead of
    sending bare names to the LLM in plaintext (BFSF-269).

    With custom labels the lost categories are KNOWN, so they are listed (the
    model-dependent built-ins plus the custom ids): a request whose built-ins
    were all regex-complete then fails closed only for its custom labels.
    Without custom labels the list stays absent, as it always was."""
    n_model = len(categories) + (len(custom.ids) if custom is not None else 0)
    logger.warning(
        "[PiiService] Model not ready (%s) — returning DEGRADED "
        "regex-only result for %d GLiNER categor(y/ies)",
        load_error or "loading",
        n_model,
    )
    out = {
        "degraded": True,
        "degraded_reason": f"model_not_ready: {load_error or 'loading'}",
        **envelope,
    }
    if custom is not None:
        out["degraded_categories"] = sorted(set(categories) | set(custom.ids))
    return out


def _narrower(a: int | None, b: int | None) -> int | None:
    """The smaller of two processed-char marks; None means "not partial"."""
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


def _degraded_signal(
    groups_attempted: int, groups_failed: int, failed_categories: set[str]
) -> tuple[bool, str | None]:
    """Degraded means "this entity list may be incomplete". Every group dead
    is treated like model-not-ready; one dead group also counts, because the
    seven groups cover DISJOINT categories, unless the setting says otherwise."""
    from app.config import settings

    degraded = groups_attempted > 0 and groups_failed == groups_attempted
    degraded_reason = "gliner_predict_failed" if degraded else None
    if (
        not degraded
        and failed_categories
        and getattr(settings, "pii_degrade_on_partial_group_failure", True)
    ):
        degraded = True
        degraded_reason = "gliner_group_failed:" + ",".join(sorted(failed_categories))
        logger.warning(
            "[PiiService] %d/%d label group(s) failed — marking DEGRADED; "
            "categories with no coverage: %s",
            groups_failed,
            groups_attempted,
            sorted(failed_categories),
        )
    return degraded, degraded_reason


def _log_tier_diff(regex_entities: list[dict], model_entities: list[dict]) -> None:
    """Shadow mode's one honest answer: would `off` have detected FEWER?
    Category names and integer counts only — never offsets, spans or input."""

    def _cats(ents):
        return Counter(e["category"] for e in ents)

    regex_cats = _cats(regex_entities)
    model_cats = _cats(model_entities)
    logger.info(
        "pii.tier_diff regex_total=%d model_total=%d "
        "regex_only_categories=%s model_only_categories=%s "
        "regex_by_category=%s model_by_category=%s",
        sum(regex_cats.values()),
        sum(model_cats.values()),
        sorted(set(regex_cats) - set(model_cats)),
        sorted(set(model_cats) - set(regex_cats)),
        dict(sorted(regex_cats.items())),
        dict(sorted(model_cats.items())),
    )


def _scan_stats(
    chunks: int, groups: int, timings: _Timings, workers: int
) -> dict[str, float | int]:
    """Diagnosability floor (counts/durations only): what the pii.scan line
    needs to tell "queued behind another scan" from "the model is slow".
    ``predict_ms`` is the SUM over passes, so under fan-out it exceeds the
    wall clock; ``predict_ms_max`` is the slowest single pass."""
    predict_ms = timings.predict_ms
    return {
        "chunks": chunks,
        "groups": groups,
        "lock_wait_ms": round(sum(timings.lock_wait_ms), 1),
        "passes": len(predict_ms),
        "predict_ms": round(sum(predict_ms), 1),
        "predict_ms_max": round(max(predict_ms), 1) if predict_ms else 0.0,
        "workers": workers,
    }


class _Detection:
    """``PiiService``'s detection half. Mixed into the service."""

    def detect(
        self,
        text: str,
        confidence_threshold: float = 0.7,
        enabled_categories: list[str] | None = None,
        scan_char_limit: int | None = None,
        enabled_regions: list[str] | None = None,
    ) -> dict:
        """Run PII detection on *text* and resolve overlaps. See _detect_raw."""
        return self.detect_request(
            ScanRequest(
                text,
                confidence_threshold,
                enabled_categories,
                scan_char_limit,
                enabled_regions,
            )
        )

    def detect_request(self, req: ScanRequest) -> dict:
        """detect() for a ScanRequest, which may carry custom labels.

        The built-in candidates are resolved by _finalise exactly as without
        custom labels; the custom ones by _finalise_custom, among themselves,
        into ``custom_entities``. That key is present only when the request
        had custom labels.
        """
        entities, kwargs, custom = self._detect_scan(req)
        result = self._finalise(entities, text=req.text, **kwargs)
        if req.custom is not None:
            result["custom_entities"] = _finalise_custom(
                custom or [], req.text, req.custom
            )
        return result

    def detect_candidates(
        self,
        text: str,
        confidence_threshold: float = 0.7,
        enabled_categories: list[str] | None = None,
        scan_char_limit: int | None = None,
        enabled_regions: list[str] | None = None,
    ) -> list[dict]:
        """Every candidate span, BEFORE overlap resolution.

        ``detect()`` emits at most one entity per overlap cluster and *deletes*
        the losers. That is right for a redaction API and wrong for every
        offline analysis:

          * Threshold calibration sweeping detect() output can never propose a
            floor that recovers a category which lost its cluster. Measured: of
            85 gold IBANs, 43 were emitted as BankAccountNumber, so at EVERY
            candidate threshold those 43 were absent from the IBAN curve. The
            sweep looked healthy and the fitted floor was meaningless.
          * The confusion matrix only ever saw cluster winners.
          * Replaying a candidate tiebreak rule required re-running the model.

        Same code path as detect() by construction — this is not a second
        pipeline that can drift.
        """
        entities, _ = self._detect_raw(
            text,
            confidence_threshold,
            enabled_categories,
            scan_char_limit,
            enabled_regions,
        )
        return entities

    def _detect_raw(
        self,
        text: str,
        confidence_threshold: float = 0.7,
        enabled_categories: list[str] | None = None,
        scan_char_limit: int | None = None,
        enabled_regions: list[str] | None = None,
    ) -> tuple[list[dict], dict]:
        """Run PII detection on *text*, returning ``(entities, finalise_kwargs)``.

        Everything except overlap resolution. ``detect()`` applies _finalise to
        the result; ``detect_candidates()`` returns the entities unresolved.

        ``scan_char_limit`` (optional) bounds the GLiNER scan to chunks that
        start before it — a deterministic partial scan for oversize input.
        The regex tier still covers the whole text. The result is flagged
        ``degraded`` with ``processed_chars``/``total_chars`` so the caller
        fails closed on the unscanned tail while keeping what was found.

        The entities are OVERLAPPING dicts of {text, category, label,
        confidence, offset, length, source}; the kwargs are the envelope fields
        _finalise wraps around the resolved list (degraded, degraded_reason,
        degraded_categories, processed_chars, total_chars, tier_mode,
        near_miss_counts, scan_stats). ``text`` is supplied by detect().
        """
        entities, kwargs, _custom = self._detect_scan(
            ScanRequest(
                text,
                confidence_threshold,
                enabled_categories,
                scan_char_limit,
                enabled_regions,
            )
        )
        return entities, kwargs

    def _detect_scan(
        self, req: ScanRequest
    ) -> tuple[list[dict], dict, list[dict] | None]:
        """_detect_raw for a ScanRequest: ``(entities, finalise_kwargs,
        custom_candidates)``, the last None exactly when ``req.custom`` is."""
        custom = req.custom
        no_custom: list[dict] | None = [] if custom is not None else None
        # _finalise([]) wraps to exactly the old literal envelope.
        if _is_skippable(req.text):
            return [], {}, no_custom

        scope = _resolve_scope(
            req.enabled_categories, req.enabled_regions, custom=custom is not None
        )
        found = _deterministic_tier(req.text, scope)
        envelope: dict = {
            "tier_mode": scope.tier_mode,
            "near_miss_counts": found.stats.get("near_miss", {}),
        }

        # Fast path — every requested category is regex-complete. Not
        # degraded: nothing depended on GLiNER. Custom labels always do.
        categories = _model_categories(scope)
        if not categories and custom is None:
            return found.entities, envelope, None

        if not self._ready or self._model is None:
            return (
                found.entities,
                _not_ready_envelope(self._load_error, categories, custom, envelope),
                no_custom,
            )

        active_groups = _active_label_groups(categories)
        if not active_groups and custom is None:
            return found.entities, envelope, None

        model_entities, custom_entities, kwargs = self._model_tier(
            req, categories, active_groups
        )
        if scope.tier_mode == "shadow":
            _log_tier_diff(found.regex, model_entities)
        return found.entities + model_entities, {**kwargs, **envelope}, custom_entities

    def _model_tier(
        self,
        req: ScanRequest,
        categories: set[str],
        active_groups: list[list[str]],
    ) -> tuple[list[dict], list[dict] | None, dict]:
        """Tier 2: every GLiNER pass of one request, and their verdicts.

        The shipped groups over the shipped chunk list, then (with custom
        labels) the ONE custom group over its own chunk list. Custom units are
        queued last and collected apart, so the built-in candidates are exactly
        what they are without custom labels.
        """
        custom = req.custom
        chunks, processed_chars, total_chars = (
            self._chunks_for_scan(req.text, req.scan_char_limit)
            if active_groups
            else ([], None, None)
        )
        units = _scan_units(active_groups, chunks)
        groups: list[_Labels] = list(active_groups)
        custom_chunks: list[tuple[int, str]] | None = None
        if custom is not None:
            shared = (chunks, processed_chars, total_chars) if active_groups else None
            custom_chunks, c_processed, c_total = self._custom_chunks(
                req.text, req.scan_char_limit, custom, shared
            )
            units += _scan_units([custom.mapping], custom_chunks, len(groups))
            groups.append(list(custom.ids))
            processed_chars = _narrower(processed_chars, c_processed)
            total_chars = c_total if total_chars is None else total_chars

        timings = _Timings()
        outcomes, workers = self._run_scan_units(units, timings)

        collector = _SpanCollector(
            req.text, categories, req.confidence_threshold, custom
        )
        slices_total, slices_failed = _collect_outcomes(units, outcomes, collector)
        groups_failed, failed_categories = _failed_groups(
            groups, slices_total, slices_failed, _label_map(custom)
        )

        # Boundary repair, shape sanity, then the checksum arithmetic — in that
        # order, so validators see final spans and _finalise sees the verdicts.
        model_entities = _postprocess_entities(req.text, collector.entities)
        model_entities = _precision_filter(model_entities)
        model_entities = _apply_validators(model_entities)
        # Custom spans get the word-edge repair only: no shape filter and no
        # validator knows an admin-defined kind of data.
        custom_entities = (
            _postprocess_entities(req.text, collector.custom_entities)
            if custom is not None
            else None
        )

        degraded, degraded_reason = _degraded_signal(
            len(groups), groups_failed, failed_categories
        )

        # WHICH categories lost coverage, so the Node side fails closed only
        # when a REQUESTED category did. An unscanned tail can hide any
        # category, so a partial scan reports the empty list: assume everything.
        degraded_categories = sorted(failed_categories)
        if (
            processed_chars is not None
            and total_chars is not None
            and processed_chars < total_chars
        ):
            degraded = True
            degraded_reason = degraded_reason or "input_too_large_partial"
            degraded_categories = []

        stats = _scan_stats(len(chunks), len(groups), timings, workers if units else 0)
        if custom_chunks is not None:
            stats["custom_chunks"] = len(custom_chunks)
        return (
            model_entities,
            custom_entities,
            {
                "degraded": degraded,
                "degraded_reason": degraded_reason,
                "degraded_categories": degraded_categories,
                "processed_chars": processed_chars,
                "total_chars": total_chars,
                "scan_stats": stats,
            },
        )

    def _custom_budget(self, custom: _CustomSpec) -> _ChunkBudget | None:
        """The chunk budget for the custom group; None when the shipped chunks
        already fit it.

        The shipped text budget was cut for the widest shipped label prompt.
        Six admin-written prompts can be several times wider, and GLiNER
        prepends the prompt to every chunk, so a chunk sized for the shipped
        width would lose its tail to truncation. A wider custom prompt
        therefore costs exactly its extra width in text tokens (never below
        the floor every budget has); without a tokenizer there is nothing to
        measure, so the char fallback leaves a third more room instead.
        """
        char_only = _ChunkBudget(None, None, _CUSTOM_CHUNK_CHAR_LIMIT)
        if self._tokenizer is None or not self._text_token_budget:
            return char_only
        width = self._locked_prompt_width(custom.prompts)
        if width is None:
            return char_only
        shipped = self._label_prompt_tokens_max
        if shipped is None:
            # Not measured at load (a tokenizer installed from outside, as the
            # tests do): measure the shipped groups now, under the same lock.
            shipped = max(
                (self._locked_prompt_width(group) or 0) for group in label_groups()
            )
        if width <= shipped:
            return None
        budget = max(
            _MIN_TEXT_TOKEN_BUDGET, self._text_token_budget - (width - shipped)
        )
        return _ChunkBudget(
            budget, _overlap_tokens_for(budget), _CUSTOM_CHUNK_CHAR_LIMIT
        )

    def _custom_chunks(
        self,
        text: str,
        scan_char_limit: int | None,
        custom: _CustomSpec,
        shared: _ChunkPlan | None = None,
    ) -> _ChunkPlan:
        """The custom group's chunk list: ``shared`` (the built-in plan) when
        the custom prompt fits the width it was cut for, else a list of its own
        under the same partial-scan limit. /pii/probe calls this too, so its
        chunks are the ones production would use."""
        budget = self._custom_budget(custom)
        if budget is None and shared is not None:
            return shared
        return self._chunks_for_scan(text, scan_char_limit, budget)

    def _chunks_for_scan(
        self,
        text: str,
        scan_char_limit: int | None,
        budget: _ChunkBudget | None = None,
    ) -> _ChunkPlan:
        """Token-aware chunks, cut at the partial-scan boundary.

        Pre-trimming to budget + margin bounds how long the inference lock is
        held for tokenising oversize input; the margin exceeds any chunk, so
        every chunk that can start before the budget is bit-identical. Only
        chunks that START before the limit are kept — a deterministic prefix —
        and the tail is left for the caller to fail closed on (BFSF-269).
        ``budget`` overrides the chunking limits (the custom group's).
        """
        chunk_source = text
        if (
            scan_char_limit is not None
            and len(text) > scan_char_limit + _PRETRIM_MARGIN_CHARS
        ):
            chunk_source = text[: scan_char_limit + _PRETRIM_MARGIN_CHARS]
        chunks = self._locked_chunk(chunk_source, budget)

        processed_chars: int | None = None
        total_chars: int | None = None
        if scan_char_limit is not None and chunks:
            kept = [(off, c) for off, c in chunks if off < scan_char_limit]
            if not kept:
                kept = chunks[:1]
            processed_chars = kept[-1][0] + len(kept[-1][1])
            total_chars = len(text)
            chunks = kept
        return chunks, processed_chars, total_chars

    def _run_scan_unit(self, unit: _ScanUnit, timings: _Timings) -> _Outcome:
        """One forward pass. Workers do inference ONLY; acceptance stays on the
        calling thread so the accepted set is independent of completion order."""
        group_idx, group_labels, group_threshold, sub_texts, _sub_offsets, i = unit
        try:
            return self._locked_predict(
                sub_texts,
                group_labels,
                group_threshold,
                lock_wait_ms=timings.lock_wait_ms,
                predict_ms=timings.predict_ms,
            ), None
        except Exception as exc:
            # The custom group's labels are admin-written prompts, and an
            # exception message may quote its input: log only the type there.
            logger.error(
                "[PiiService] inference failed (group %d, chunks %d-%d): %s",
                group_idx,
                i,
                i + len(sub_texts),
                type(exc).__name__ if isinstance(group_labels, dict) else exc,
            )
            return None, exc

    def _run_scan_units(
        self, units: list[_ScanUnit], timings: _Timings
    ) -> tuple[list[_Outcome], int]:
        """Fan the passes out over the persistent predict pool when per-thread
        tokenizers allow it; otherwise walk them one at a time."""
        run = partial(self._run_scan_unit, timings=timings)
        pool = getattr(self, "_predict_pool", None)
        workers = max(
            1, min(int(getattr(self, "_predict_workers", 1) or 1), len(units))
        )
        if pool is not None and workers > 1 and len(units) > 1:
            return list(pool.map(run, units)), workers
        return [run(u) for u in units], 1
