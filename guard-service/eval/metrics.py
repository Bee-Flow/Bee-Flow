"""Precision / recall / F1 / F2 aggregation with breakdowns. Pure stdlib.

Given gold records and a parallel list of predicted spans, produce a
JSON-serialisable metrics report:

  * per-category TP/FP/FN + precision/recall/F1/F2,
  * micro (pooled) and macro (unweighted mean) P/R/F1,
  * breakdowns by size_class (short vs large — the headline split), language,
    and tier (regex-complete vs GLiNER-only),
  * boundary quality (mean IoU over matched pairs, % exact),
  * a confusion counter over (gold_category -> pred_category),
  * degraded rate (must be 0 with the model loaded).

F2 (recall-weighted) is the operative number for a privacy filter: a missed
entity is a leak, a false positive is a nuisance.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Sequence

from .matcher import SpanTuple, match_spans
from .schema import Record


def _fbeta(precision: float, recall: float, beta: float) -> float:
    b2 = beta * beta
    denom = b2 * precision + recall
    return (1 + b2) * precision * recall / denom if denom > 0 else 0.0


def _prf(tp: int, fp: int, fn: int) -> dict:
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(_fbeta(precision, recall, 1.0), 4),
        "f2": round(_fbeta(precision, recall, 2.0), 4),
    }


def _tier(category: str, regex_categories: frozenset[str]) -> str:
    return "regex" if category in regex_categories else "gliner"


# value_kind is written as `<thing>_<cc>` (iban_de, natid_es, plate_it), so the
# country falls out of the suffix. Kinds with no suffix are country-neutral.
_KNOWN_REGIONS = frozenset(
    {
        "nl",
        "be",
        "de",
        "fr",
        "es",
        "it",
        "pl",
        "se",
        "at",
        "us",
        "gb",
        "uk",
    }
)


def _region_of(value_kind: str | None) -> str:
    """Region a gold span belongs to, or "any" when the value is country-neutral.

    This is what makes "did the non-Dutch tenants actually gain recall?" a number
    instead of an argument. The regex tier suppresses GLiNER per category, so a
    Dutch-only pattern set was a measured recall loss for every other country —
    but nothing in the report could show it, because every view was bucketed by
    category and the categories looked fine.
    """
    if not value_kind:
        return "any"
    suffix = value_kind.rsplit("_", 1)[-1].lower()
    return suffix.upper() if suffix in _KNOWN_REGIONS else "any"


def evaluate(  # noqa: C901, PLR0912, PLR0913, PLR0915
    records: Sequence[Record],
    predictions: Sequence[Sequence[SpanTuple]],
    *,
    regex_categories: frozenset[str],
    mode: str = "overlap",
    iou_threshold: float = 0.5,
    degraded_flags: Sequence[bool] | None = None,
    class_maps: dict[str, dict[str, str]] | None = None,
    control_group: frozenset[str] | None = None,
) -> dict:
    """Compute the full metrics report. ``predictions`` is parallel to ``records``.

    ``class_maps`` ({grouping: {category: class}}) adds
    ``report["by_class"][grouping][class]``. The cutover decision turns on
    ``by_structure`` (structured vs fuzzy) and ``by_prior_owner`` (was_regex vs
    was_gliner); without them a reviewer has to re-bucket 21 rows by hand.

    ``control_group`` adds ``report["control_group"]`` — categories that no
    change was supposed to touch. Drift there means something moved underneath
    the experiment (the label-group count changes the prompt length, which
    changes the text token budget, which changes the chunking) and no other row
    in the report can be trusted until it is explained.
    """
    if len(records) != len(predictions):
        raise ValueError("records and predictions must be the same length")

    # counts[group_key][category] = {"tp","fp","fn"}
    def _new_cat() -> dict:
        return {"tp": 0, "fp": 0, "fn": 0}

    overall: dict[str, dict[str, int]] = defaultdict(_new_cat)
    by_size: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(_new_cat)
    )
    by_lang: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(_new_cat)
    )
    # Region view. RECALL-ONLY by construction: a false positive has no gold span
    # and therefore no country, so precision here would be a made-up number.
    # Recall is the question regions were added to answer.
    by_region: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(_new_cat)
    )
    confusion: Counter = Counter()
    iou_sum = 0.0
    iou_n = 0
    exact_n = 0

    for idx, (rec, preds) in enumerate(zip(records, predictions)):
        golds = [SpanTuple(s.start, s.end, s.category) for s in rec.spans]
        preds = list(preds)
        mr = match_spans(golds, preds, mode=mode, iou_threshold=iou_threshold)

        for gi, pi, score in mr.tp:
            cat = golds[gi].category
            overall[cat]["tp"] += 1
            by_size[rec.size_class][cat]["tp"] += 1
            by_lang[rec.lang][cat]["tp"] += 1
            by_region[_region_of(rec.spans[gi].value_kind)][cat]["tp"] += 1
            iou_sum += score
            iou_n += 1
            if score >= 0.99999:
                exact_n += 1
        for pi in mr.fp:
            cat = preds[pi].category
            overall[cat]["fp"] += 1
            by_size[rec.size_class][cat]["fp"] += 1
            by_lang[rec.lang][cat]["fp"] += 1
        for gi in mr.fn:
            cat = golds[gi].category
            overall[cat]["fn"] += 1
            by_size[rec.size_class][cat]["fn"] += 1
            by_lang[rec.lang][cat]["fn"] += 1
            by_region[_region_of(rec.spans[gi].value_kind)][cat]["fn"] += 1
        for gcat, pcat, _ in mr.confusion:
            confusion[f"{gcat}->{pcat}"] += 1

    def _summarise(cat_counts: dict[str, dict[str, int]]) -> dict:
        per_cat = {
            cat: _prf(c["tp"], c["fp"], c["fn"])
            for cat, c in sorted(cat_counts.items())
        }
        tot_tp = sum(c["tp"] for c in cat_counts.values())
        tot_fp = sum(c["fp"] for c in cat_counts.values())
        tot_fn = sum(c["fn"] for c in cat_counts.values())
        micro = _prf(tot_tp, tot_fp, tot_fn)
        # Macro: unweighted mean over categories that appear at all.
        if per_cat:
            macro = {
                "precision": round(
                    sum(m["precision"] for m in per_cat.values()) / len(per_cat), 4
                ),
                "recall": round(
                    sum(m["recall"] for m in per_cat.values()) / len(per_cat), 4
                ),
                "f1": round(sum(m["f1"] for m in per_cat.values()) / len(per_cat), 4),
                "f2": round(sum(m["f2"] for m in per_cat.values()) / len(per_cat), 4),
            }
        else:
            macro = {"precision": 0.0, "recall": 0.0, "f1": 0.0, "f2": 0.0}
        return {"per_category": per_cat, "micro": micro, "macro": macro}

    # Tier breakdown derived from the overall per-category counts.
    tier_counts: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(_new_cat)
    )
    for cat, c in overall.items():
        tier_counts[_tier(cat, regex_categories)][cat] = dict(c)

    degraded_rate = 0.0
    if degraded_flags is not None and len(degraded_flags):
        degraded_rate = round(
            sum(1 for d in degraded_flags if d) / len(degraded_flags), 4
        )

    # Arbitrary category groupings, re-bucketed from the overall per-category
    # counts (so they are consistent with `overall` by construction).
    by_class: dict[str, dict] = {}
    for grouping, mapping in (class_maps or {}).items():
        grouped: dict[str, dict[str, dict[str, int]]] = defaultdict(
            lambda: defaultdict(_new_cat)
        )
        for cat, c in overall.items():
            cls = mapping.get(cat)
            if cls is not None:
                grouped[cls][cat] = dict(c)
        by_class[grouping] = {k: _summarise(v) for k, v in sorted(grouped.items())}

    control: dict | None = None
    if control_group is not None:
        control = _summarise(
            {cat: dict(c) for cat, c in overall.items() if cat in control_group}
        )

    report = {
        "match_mode": mode,
        "iou_threshold": iou_threshold,
        "n_records": len(records),
        "overall": _summarise(overall),
        "by_size_class": {k: _summarise(v) for k, v in sorted(by_size.items())},
        "by_lang": {k: _summarise(v) for k, v in sorted(by_lang.items())},
        "by_region": {k: _summarise(v) for k, v in sorted(by_region.items())},
        "by_tier": {k: _summarise(v) for k, v in sorted(tier_counts.items())},
        "by_class": by_class,
        "control_group": control,
        "boundary_quality": {
            "mean_iou": round(iou_sum / iou_n, 4) if iou_n else 0.0,
            "pct_exact": round(exact_n / iou_n, 4) if iou_n else 0.0,
            "matched_pairs": iou_n,
        },
        "confusion": dict(confusion.most_common()),
        "degraded_rate": degraded_rate,
    }
    return report


def format_summary(report: dict) -> str:
    """Human-readable PASS/FAIL-style summary (mirrors training/eval.mjs)."""
    lines: list[str] = []
    o = report["overall"]
    lines.append(
        f"records: {report['n_records']}  match: {report['match_mode']}"
        f"  degraded_rate: {report['degraded_rate']}"
    )
    lines.append("")
    lines.append(
        f"{'category':38s} {'P':>7s} {'R':>7s} {'F1':>7s} {'F2':>7s}  "
        f"{'TP':>5s} {'FP':>5s} {'FN':>5s}"
    )
    lines.append("-" * 92)
    for cat, m in o["per_category"].items():
        lines.append(
            f"{cat:38s} {m['precision']:7.3f} {m['recall']:7.3f} "
            f"{m['f1']:7.3f} {m['f2']:7.3f}  {m['tp']:5d} {m['fp']:5d} {m['fn']:5d}"
        )
    lines.append("-" * 92)
    mi, ma = o["micro"], o["macro"]
    lines.append(
        f"{'MICRO':38s} {mi['precision']:7.3f} {mi['recall']:7.3f} {mi['f1']:7.3f} {mi['f2']:7.3f}"
    )
    lines.append(
        f"{'MACRO':38s} {ma['precision']:7.3f} {ma['recall']:7.3f} {ma['f1']:7.3f} {ma['f2']:7.3f}"
    )
    bq = report["boundary_quality"]
    lines.append("")
    lines.append(
        f"boundary: mean_iou={bq['mean_iou']} pct_exact={bq['pct_exact']} pairs={bq['matched_pairs']}"
    )
    for size, s in report.get("by_size_class", {}).items():
        lines.append(
            f"  size[{size}]: micro_f1={s['micro']['f1']} micro_recall={s['micro']['recall']}"
        )
    # The groupings the cutover decision is actually read off. by_structure in
    # particular is the axis the external evidence says will split: models are
    # weakest exactly on checksummed structured identifiers.
    for grouping, classes in (report.get("by_class") or {}).items():
        lines.append("")
        for cls, s in classes.items():
            m = s["micro"]
            lines.append(
                f"  {grouping}[{cls}]: P={m['precision']:.3f} R={m['recall']:.3f} "
                f"F1={m['f1']:.3f} F2={m['f2']:.3f} (n={m['tp'] + m['fn']})"
            )
    regions = report.get("by_region") or {}
    if len(regions) > 1:
        lines.append("")
        lines.append("  by_region (RECALL only — a false positive has no country):")
        for region, s in regions.items():
            m = s["micro"]
            lines.append(f"    {region:4s} R={m['recall']:.3f} (n={m['tp'] + m['fn']})")
    cg = report.get("control_group")
    if cg:
        m = cg["micro"]
        lines.append("")
        lines.append(
            f"  CONTROL GROUP: P={m['precision']:.3f} R={m['recall']:.3f} "
            f"F1={m['f1']:.3f} (n={m['tp'] + m['fn']}) — must not move"
        )
    return "\n".join(lines)


__all__ = ["evaluate", "format_summary"]
