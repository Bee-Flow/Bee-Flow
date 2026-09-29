"""Leak-shaped failure metrics — the safety view, separate from the quality view.

Recall cannot see the failure that actually matters here. Two reasons, both
grounded in what the Node side does with a span:

1. ``server/core/piiDetection.js`` ``tokenizeText`` redacts by splicing:
   ``text.slice(0, offset) + token + text.slice(offset + length)``. A span
   clipped by one character leaves a digit of the IBAN in the prompt. The
   default match mode (``overlap``, IoU >= 0.5) scores that as a clean true
   positive — a live data leak reported as a success.

2. Conversely, a span that is fully covered but carries the WRONG category is
   still fully redacted; the token just reads ``[bank_account_number_1]``
   instead of ``[iban_1]``. That is a naming defect, not a leak.

Measured on the real corpus, those two effects pointed in opposite directions
for the same category: IBAN label-recall was 0.094 while its redaction-recall
was 0.988. Reporting only recall would have condemned a category that was in
fact being redacted almost perfectly; reporting only coverage would have hidden
that the token names were wrong. Hence two metrics, never one.

  label_recall      gold matched by a prediction OF THE SAME category (quality)
  redaction_recall  gold CHARACTERS covered by ANY predicted span    (safety)

``partial_leak`` — covered, but not fully — is the headline: a span can be a
recall true-positive at IoU 0.6 and simultaneously leak 40% of its characters.

Pure stdlib; sits on the model-free CI path.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Sequence

from .matcher import SpanTuple
from .schema import Record


# Characters that carry the identifying payload. A leaked space or dash is
# harmless; a leaked digit or letter of a bank account is not.
def _alnum(s: str) -> int:
    return sum(1 for c in s if c.isalnum())


def _covered_chars(start: int, end: int, spans: Sequence[SpanTuple]) -> int:
    """Characters of [start,end) covered by the UNION of spans (any category)."""
    if end <= start:
        return 0
    covered = 0
    pos = start
    # Sort once by start; walk the overlap-merged union.
    for s in sorted(spans, key=lambda x: x.start):
        if s.end <= pos or s.start >= end:
            continue
        lo = max(pos, s.start)
        hi = min(end, s.end)
        if hi > lo:
            covered += hi - lo
            pos = hi
        if pos >= end:
            break
    return covered


def evaluate_leak(  # noqa: C901, PLR0915
    records: Sequence[Record],
    predictions: Sequence[Sequence[SpanTuple]],
) -> dict:
    """Coverage-based safety metrics, per category and overall."""
    if len(records) != len(predictions):
        raise ValueError("records and predictions must be the same length")

    def _new() -> dict:
        return {
            "gold_spans": 0,
            "gold_chars": 0,
            "full_cover": 0,
            "partial_cover": 0,
            "zero_cover": 0,
            "leaked_chars": 0,
            "leaked_alnum_chars": 0,
            "label_matched": 0,
        }

    per_cat: dict[str, dict] = defaultdict(_new)
    worst: list[dict] = []
    over_redaction_chars = 0
    total_chars = 0

    for rec, preds in zip(records, predictions):
        total_chars += len(rec.text)
        gold_spans = list(rec.spans)

        # Over-redaction: predicted characters outside every gold span. The
        # usability counterweight — a detector that redacts the whole document
        # scores perfectly on every safety metric and destroys the prompt.
        gold_ranges = [SpanTuple(s.start, s.end, s.category) for s in gold_spans]
        for p in preds:
            outside = (p.end - p.start) - _covered_chars(p.start, p.end, gold_ranges)
            over_redaction_chars += max(0, outside)

        for s in gold_spans:
            c = per_cat[s.category]
            c["gold_spans"] += 1
            c["gold_chars"] += s.end - s.start

            cov = _covered_chars(s.start, s.end, preds)
            span_len = s.end - s.start
            if span_len and cov >= span_len:
                c["full_cover"] += 1
            elif cov > 0:
                c["partial_cover"] += 1
            else:
                c["zero_cover"] += 1

            leaked = max(0, span_len - cov)
            c["leaked_chars"] += leaked
            if leaked:
                # Which characters leaked matters: approximate by taking the
                # uncovered count from the span text's alnum density.
                text = rec.text[s.start : s.end]
                density = (_alnum(text) / len(text)) if text else 0.0
                c["leaked_alnum_chars"] += int(round(leaked * density))
                if cov > 0:
                    worst.append(
                        {
                            "record": rec.id,
                            "category": s.category,
                            "coverage": round(cov / span_len, 4) if span_len else 1.0,
                            "leaked_chars": leaked,
                            "text_len": span_len,
                        }
                    )

            if any(
                p.category == s.category and p.start < s.end and s.start < p.end
                for p in preds
            ):
                c["label_matched"] += 1

    def _finish(c: dict) -> dict:
        n = c["gold_spans"] or 1
        out = dict(c)
        out["full_cover_rate"] = round(c["full_cover"] / n, 4)
        out["partial_leak_rate"] = round(c["partial_cover"] / n, 4)
        out["zero_miss_rate"] = round(c["zero_cover"] / n, 4)
        # Safety: fraction of gold spans fully redacted, regardless of label.
        out["redaction_recall"] = round(c["full_cover"] / n, 4)
        # Quality: fraction whose label was also right.
        out["label_recall"] = round(c["label_matched"] / n, 4)
        # Fully covered but mislabelled — a token-naming defect, NOT a leak.
        out["label_only_failures"] = max(0, c["full_cover"] - c["label_matched"])
        return out

    per_category = {k: _finish(v) for k, v in sorted(per_cat.items())}

    agg = _new()
    for v in per_cat.values():
        for k in agg:
            agg[k] += v[k]
    overall = _finish(agg)
    overall["over_redaction_chars"] = over_redaction_chars
    overall["total_chars"] = total_chars
    overall["over_redaction_rate"] = (
        round(over_redaction_chars / total_chars, 6) if total_chars else 0.0
    )

    worst.sort(key=lambda w: w["coverage"])
    return {
        "per_category": per_category,
        "overall": overall,
        "worst_partial": worst[:25],
    }


__all__ = ["evaluate_leak"]
