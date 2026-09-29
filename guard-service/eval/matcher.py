"""Span matching between gold and predicted PII spans.

Two modes, both reported by the runner:
  * ``strict``  — exact boundaries AND same category.
  * ``overlap`` — char-level IoU >= threshold (default 0.5) AND same category.
                  This is the PRIMARY mode: legitimate boundary shifts
                  (tussenvoegsel back-extension, trailing-punct trim) must not
                  count as errors.

Assignment is one-to-one and greedy by descending IoU so a gold span can't be
double-credited. Category-mismatched overlaps feed a confusion view.
Pure stdlib.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import NamedTuple, Sequence


class SpanTuple(NamedTuple):
    start: int
    end: int
    category: str
    confidence: float = 1.0


def iou(a: tuple[int, int], b: tuple[int, int]) -> float:
    """Character-level Jaccard overlap of two half-open [start,end) ranges."""
    inter = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    if inter <= 0:
        return 0.0
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def overlaps(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


@dataclass
class MatchResult:
    # matched pairs: (gold_index, pred_index, iou)
    tp: list[tuple[int, int, float]] = field(default_factory=list)
    fp: list[int] = field(default_factory=list)  # unmatched pred indices
    fn: list[int] = field(default_factory=list)  # unmatched gold indices
    # confusion: (gold_category, pred_category, iou) for overlapping mismatches
    confusion: list[tuple[str, str, float]] = field(default_factory=list)


def match_spans(  # noqa: C901, PLR0912
    golds: Sequence[SpanTuple],
    preds: Sequence[SpanTuple],
    *,
    mode: str = "overlap",
    iou_threshold: float = 0.5,
) -> MatchResult:
    """One-to-one greedy match. ``mode`` ∈ {'strict','overlap','cover'}.

    ``cover`` is redaction-correct matching: the prediction must FULLY CONTAIN
    the gold span (over-extension allowed, clipping not). It exists because the
    Node side redacts by splicing offset/length, so a prediction that covers
    only part of a gold span leaves the remainder in the prompt — which
    ``overlap`` happily scores as a true positive at IoU >= 0.5. Where
    ``overlap`` and ``cover`` disagree, the difference is partial redaction.
    """
    if mode not in ("strict", "overlap", "cover"):
        raise ValueError(f"unknown match mode {mode!r}")

    # Build candidate same-category pairs that satisfy the span rule.
    candidates: list[tuple[float, int, int]] = []
    for gi, g in enumerate(golds):
        for pi, p in enumerate(preds):
            if g.category != p.category:
                continue
            score = iou((g.start, g.end), (p.start, p.end))
            if mode == "strict":
                if g.start == p.start and g.end == p.end:
                    candidates.append((1.0, gi, pi))
            elif mode == "cover":
                if p.start <= g.start and p.end >= g.end:
                    # Rank by IoU so the tightest containing span wins the
                    # greedy assignment — otherwise a huge over-extended span
                    # could claim a gold that a precise one also covers.
                    candidates.append((score, gi, pi))
            else:
                if score >= iou_threshold:
                    candidates.append((score, gi, pi))

    # Greedy by descending IoU (stable on ties by gold then pred index).
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
    used_g: set[int] = set()
    used_p: set[int] = set()
    result = MatchResult()
    for score, gi, pi in candidates:
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        result.tp.append((gi, pi, score))

    result.fp = [pi for pi in range(len(preds)) if pi not in used_p]
    result.fn = [gi for gi in range(len(golds)) if gi not in used_g]

    # Confusion: an unmatched pred that overlaps an unmatched gold with a
    # DIFFERENT category is a category mislabel. Record it (still counts as
    # FP for pred_cat + FN for gold_cat — both already in fp/fn).
    for pi in result.fp:
        p = preds[pi]
        best: tuple[str, float] | None = None
        for gi in result.fn:
            g = golds[gi]
            if g.category == p.category:
                continue
            ov = iou((g.start, g.end), (p.start, p.end))
            if ov > 0 and (best is None or ov > best[1]):
                best = (g.category, ov)
        if best is not None:
            result.confusion.append((best[0], p.category, best[1]))
        else:
            result.confusion.append(("∅", p.category, 0.0))  # spurious ∅→cat
    for gi in result.fn:
        g = golds[gi]
        # A missed gold with no overlapping pred of any category → cat→∅.
        if not any(
            overlaps((g.start, g.end), (preds[pi].start, preds[pi].end))
            for pi in result.fp
        ):
            result.confusion.append((g.category, "∅", 0.0))

    return result


__all__ = ["SpanTuple", "iou", "overlaps", "MatchResult", "match_spans"]
