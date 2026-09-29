"""Multi-label metrics for the "is about" classifier eval. Pure stdlib.

An *item* is a dict with at least::

    {"kind": "email", "lang": "nl", "gold": ["a complaint"],
     "scores": {"a complaint": 0.91, "an invoice": 0.12, ...}}

`scores` holds every label of the item's kind (the model scored them jointly).
At a threshold t, the item is predicted to be about every label whose score is
>= t, which is exactly how the Condition node routes: down every output at or
above the threshold, "otherwise" when none is.

A *class* is a (kind, label) pair, because every kind has its own label set and
"an invoice" as a file name is a different decision from "an invoice" as a
file's text.

  * macro-F1: the unweighted mean of per-class F1, over the classes with at
    least one gold positive in the items. A class nobody wrote gold for cannot
    have a meaningful recall, so it is left out and counted in `n_classes`.
  * micro-F1: TP/FP/FN pooled over every (item, label) decision.
  * F2 leans towards recall (the "loose" preset) and F0.5 towards precision
    (the "strict" preset).
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable, Sequence

# 0.05, 0.10, ..., 0.95. Rounded so the keys are stable in JSON.
THRESHOLDS: tuple[float, ...] = tuple(round(0.05 * i, 2) for i in range(1, 20))


def fbeta(precision: float, recall: float, beta: float = 1.0) -> float:
    b2 = beta * beta
    denom = b2 * precision + recall
    return (1 + b2) * precision * recall / denom if denom > 0 else 0.0


def prf(tp: int, fp: int, fn: int, beta: float = 1.0) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    return precision, recall, fbeta(precision, recall, beta)


def predicted(scores: dict[str, float], threshold: float) -> set[str]:
    """The labels an item goes down: every score at or above the threshold."""
    return {label for label, score in scores.items() if score >= threshold}


def class_counts(items: Iterable[dict], threshold: float) -> dict[str, dict[str, int]]:
    """Per-class TP/FP/FN plus the gold count, keyed "kind:label"."""
    counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"tp": 0, "fp": 0, "fn": 0, "gold": 0}
    )
    for item in items:
        gold = set(item["gold"])
        pred = predicted(item["scores"], threshold)
        for label in item["scores"]:
            c = counts[f"{item['kind']}:{label}"]
            if label in gold:
                c["gold"] += 1
                c["tp" if label in pred else "fn"] += 1
            elif label in pred:
                c["fp"] += 1
    return dict(counts)


def macro_f(items: Sequence[dict], threshold: float, beta: float = 1.0) -> float:
    counts = class_counts(items, threshold)
    scored = [
        prf(c["tp"], c["fp"], c["fn"], beta)[2]
        for c in counts.values()
        if c["gold"] > 0
    ]
    return sum(scored) / len(scored) if scored else 0.0


def micro_prf(
    items: Sequence[dict], threshold: float, beta: float = 1.0
) -> tuple[float, float, float]:
    tp = fp = fn = 0
    for c in class_counts(items, threshold).values():
        tp += c["tp"]
        fp += c["fp"]
        fn += c["fn"]
    return prf(tp, fp, fn, beta)


def sweep(
    items: Sequence[dict], thresholds: Sequence[float] = THRESHOLDS
) -> list[dict]:
    rows = []
    for t in thresholds:
        p, r, f1 = micro_prf(items, t)
        rows.append(
            {
                "threshold": t,
                "macro_f1": round(macro_f(items, t, 1.0), 4),
                "macro_f2": round(macro_f(items, t, 2.0), 4),
                "macro_f05": round(macro_f(items, t, 0.5), 4),
                "micro_f1": round(f1, 4),
                "micro_precision": round(p, 4),
                "micro_recall": round(r, 4),
                "none_fp_rate": none_fp_rate(items, t),
            }
        )
    return rows


def best_threshold(rows: Sequence[dict], key: str = "macro_f1") -> float:
    """The threshold with the highest `key`; a tie goes to the one closest to 0.5.

    Closest-to-0.5 rather than lowest or highest, so a flat plateau does not
    drag the default to an extreme that only happens to tie on this corpus.
    """
    if not rows:
        raise ValueError("empty sweep")
    top = max(row[key] for row in rows)
    tied = [row["threshold"] for row in rows if row[key] == top]
    return min(tied, key=lambda t: (abs(t - 0.5), t))


def top1_accuracy(items: Iterable[dict]) -> dict:
    """Over items with exactly one gold label: is that label the highest score?

    Threshold-free, so it separates "ranks the right label first" from "puts
    the scores on a usable scale", the two ways a zero-shot model can fail.
    """
    n = hit = 0
    for item in items:
        if len(item["gold"]) != 1:
            continue
        n += 1
        best = max(item["scores"].items(), key=lambda kv: kv[1])[0]
        hit += best == item["gold"][0]
    return {"n": n, "accuracy": round(hit / n, 4) if n else None}


def none_fp_rate(items: Iterable[dict], threshold: float) -> float | None:
    """Share of the items with no gold label that still go down some output."""
    none_items = [item for item in items if not item["gold"]]
    if not none_items:
        return None
    fired = sum(1 for item in none_items if predicted(item["scores"], threshold))
    return round(fired / len(none_items), 4)


def summary(items: Sequence[dict], threshold: float) -> dict:
    p, r, f1 = micro_prf(items, threshold)
    return {
        "n": len(items),
        "n_classes": sum(
            1 for c in class_counts(items, threshold).values() if c["gold"] > 0
        ),
        "macro_f1": round(macro_f(items, threshold), 4),
        "micro_f1": round(f1, 4),
        "micro_precision": round(p, 4),
        "micro_recall": round(r, 4),
        "none_fp_rate": none_fp_rate(items, threshold),
    }


def breakdown(items: Sequence[dict], threshold: float, field: str) -> dict[str, dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        groups[str(item[field])].append(item)
    return {key: summary(group, threshold) for key, group in sorted(groups.items())}


def per_class(items: Sequence[dict], threshold: float) -> dict[str, dict]:
    out = {}
    for key, c in sorted(class_counts(items, threshold).items()):
        p, r, f1 = prf(c["tp"], c["fp"], c["fn"])
        out[key] = {
            **c,
            "precision": round(p, 4),
            "recall": round(r, 4),
            "f1": round(f1, 4),
        }
    return out


def report(items: Sequence[dict], thresholds: Sequence[float] = THRESHOLDS) -> dict:
    """Everything a results file needs from one scored split."""
    rows = sweep(items, thresholds)
    best = best_threshold(rows, "macro_f1")
    return {
        "sweep": rows,
        "best_threshold": best,
        "loose_threshold": best_threshold(rows, "macro_f2"),
        "strict_threshold": best_threshold(rows, "macro_f05"),
        "at_best": summary(items, best),
        "at_0_5": summary(items, 0.5),
        "top1": top1_accuracy(items),
        "by_lang": breakdown(items, best, "lang"),
        "by_kind": breakdown(items, best, "kind"),
        "per_class_at_best": per_class(items, best),
    }


def mean_abs_delta(
    before: Sequence[dict], after: Sequence[dict], gold_only: bool = True
) -> dict:
    """Mean |score change| per (item, label) between two scorings of the same items.

    `before` and `after` are parallel lists of items. With gold_only, only each
    item's gold labels count: that is the label-set sensitivity number.
    """
    deltas = []
    for b, a in zip(before, after, strict=True):
        labels = b["gold"] if gold_only else list(b["scores"])
        for label in labels:
            deltas.append(abs(a["scores"][label] - b["scores"][label]))
    if not deltas:
        return {"n": 0, "mean": None, "max": None}
    deltas.sort()
    return {
        "n": len(deltas),
        "mean": round(sum(deltas) / len(deltas), 4),
        "median": round(deltas[len(deltas) // 2], 4),
        "max": round(deltas[-1], 4),
    }


def decision_flips(
    before: Sequence[dict], after: Sequence[dict], threshold: float
) -> int:
    """How many (item, label) routing decisions change between two scorings."""
    flips = 0
    for b, a in zip(before, after, strict=True):
        for label in b["scores"]:
            flips += (b["scores"][label] >= threshold) != (
                a["scores"][label] >= threshold
            )
    return flips
