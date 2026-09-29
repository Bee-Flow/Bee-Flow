"""Unit tests for classify-service/eval/metrics.py on toy data. No model, no torch.

Run from the repo root:  python -m pytest classify-service/tests
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "eval"))

import metrics  # noqa: E402


def item(gold, scores, kind="email", lang="nl"):
    return {"kind": kind, "lang": lang, "gold": list(gold), "scores": dict(scores)}


# Three email items over two labels, A and B.
#   1: gold A,   scores A .9  B .2   -> at .5: TP(A)
#   2: gold B,   scores A .6  B .4   -> at .5: FP(A), FN(B)
#   3: no gold,  scores A .1  B .7   -> at .5: FP(B)
TOY = [
    item(["A"], {"A": 0.9, "B": 0.2}),
    item(["B"], {"A": 0.6, "B": 0.4}, lang="en"),
    item([], {"A": 0.1, "B": 0.7}),
]


def test_thresholds_are_the_documented_sweep():
    assert metrics.THRESHOLDS[0] == 0.05
    assert metrics.THRESHOLDS[-1] == 0.95
    assert len(metrics.THRESHOLDS) == 19


def test_predicted_is_at_or_above():
    assert metrics.predicted({"A": 0.5, "B": 0.49}, 0.5) == {"A"}


def test_class_counts_by_hand():
    c = metrics.class_counts(TOY, 0.5)
    assert c["email:A"] == {"tp": 1, "fp": 1, "fn": 0, "gold": 1}
    assert c["email:B"] == {"tp": 0, "fp": 1, "fn": 1, "gold": 1}


def test_macro_and_micro_f1_by_hand():
    # A: P 1/2, R 1 -> F1 2/3.  B: P 0, R 0 -> F1 0.  Macro = 1/3.
    assert metrics.macro_f(TOY, 0.5) == pytest.approx(1 / 3)
    # Pooled: TP 1, FP 2, FN 1 -> P 1/3, R 1/2 -> F1 0.4.
    p, r, f1 = metrics.micro_prf(TOY, 0.5)
    assert (p, r) == pytest.approx((1 / 3, 1 / 2))
    assert f1 == pytest.approx(0.4)


def test_macro_skips_classes_without_gold():
    items = [item(["A"], {"A": 0.9, "C": 0.8})]
    # C has no gold anywhere: its FP shows in micro, but it has no recall to average.
    assert metrics.macro_f(items, 0.5) == pytest.approx(1.0)
    assert metrics.micro_prf(items, 0.5)[2] == pytest.approx(2 / 3)


def test_classes_are_per_kind():
    items = [
        item(["A"], {"A": 0.9}, kind="email"),
        item([], {"A": 0.9}, kind="filename"),
    ]
    c = metrics.class_counts(items, 0.5)
    assert c["email:A"]["tp"] == 1
    assert c["filename:A"] == {"tp": 0, "fp": 1, "fn": 0, "gold": 0}
    # filename:A has no gold, so macro only averages email:A.
    assert metrics.macro_f(items, 0.5) == pytest.approx(1.0)


def test_fbeta_leans_the_right_way():
    # High recall, low precision: F2 > F1 > F0.5.
    f05 = metrics.fbeta(0.2, 1.0, 0.5)
    f1 = metrics.fbeta(0.2, 1.0, 1.0)
    f2 = metrics.fbeta(0.2, 1.0, 2.0)
    assert f2 > f1 > f05
    assert metrics.fbeta(0.0, 0.0) == 0.0


def test_sweep_and_best_threshold():
    rows = metrics.sweep(TOY)
    assert [r["threshold"] for r in rows] == list(metrics.THRESHOLDS)
    by_t = {r["threshold"]: r for r in rows}
    # 0.45 is above B's gold score (0.4) and still admits item 2's A (0.6).
    # 0.65: A gets TP only, B gets FP from item 3 and FN from item 2 -> macro 0.5.
    assert by_t[0.65]["macro_f1"] == pytest.approx(0.5)
    # 0.75: item 3's B (0.7) no longer fires, so the no-gold item is clean.
    assert by_t[0.75]["none_fp_rate"] == 0.0
    assert by_t[0.5]["none_fp_rate"] == 1.0
    best = metrics.best_threshold(rows)
    assert by_t[best]["macro_f1"] == max(r["macro_f1"] for r in rows)


def test_best_threshold_tie_goes_to_closest_to_half():
    rows = [
        {"threshold": 0.2, "macro_f1": 0.8},
        {"threshold": 0.45, "macro_f1": 0.8},
        {"threshold": 0.6, "macro_f1": 0.8},
        {"threshold": 0.9, "macro_f1": 0.7},
    ]
    assert metrics.best_threshold(rows) == 0.45
    rows.append({"threshold": 0.55, "macro_f1": 0.8})
    # 0.45 and 0.55 are equally close; the lower one wins, deterministically.
    assert metrics.best_threshold(rows) == 0.45
    with pytest.raises(ValueError):
        metrics.best_threshold([])


def test_top1_only_counts_single_label_items():
    items = TOY + [item(["A", "B"], {"A": 0.1, "B": 0.2})]
    t = metrics.top1_accuracy(items)
    # Item 1 ranks A first (hit); item 2 ranks A over gold B (miss).
    assert t == {"n": 2, "accuracy": 0.5}
    assert metrics.top1_accuracy([item([], {"A": 1.0})]) == {"n": 0, "accuracy": None}


def test_none_fp_rate():
    assert metrics.none_fp_rate(TOY, 0.5) == 1.0
    assert metrics.none_fp_rate(TOY, 0.8) == 0.0
    assert metrics.none_fp_rate([item(["A"], {"A": 0.9})], 0.5) is None


def test_breakdown_by_language_and_kind():
    b = metrics.breakdown(TOY, 0.5, "lang")
    assert set(b) == {"en", "nl"}
    assert b["en"]["n"] == 1
    assert b["nl"]["n"] == 2
    k = metrics.breakdown(TOY, 0.5, "kind")
    assert list(k) == ["email"]
    assert k["email"]["macro_f1"] == pytest.approx(round(1 / 3, 4))


def test_report_shape():
    r = metrics.report(TOY)
    for key in (
        "sweep",
        "best_threshold",
        "loose_threshold",
        "strict_threshold",
        "at_best",
        "at_0_5",
        "top1",
        "by_lang",
        "by_kind",
        "per_class_at_best",
    ):
        assert key in r
    assert r["at_0_5"]["macro_f1"] == pytest.approx(round(1 / 3, 4))
    assert r["per_class_at_best"]["email:A"]["gold"] == 1


def test_loose_threshold_not_above_strict_on_a_clean_ranking():
    # Gold scores spread from .3 to .9, non-gold at .2: recall-leaning F2 wants a
    # low threshold, precision-leaning F0.5 does not mind a higher one.
    items = [item(["A"], {"A": s, "B": 0.2}) for s in (0.3, 0.5, 0.7, 0.9)]
    items += [item(["B"], {"A": 0.2, "B": s}) for s in (0.3, 0.5, 0.7, 0.9)]
    r = metrics.report(items)
    assert r["loose_threshold"] <= r["strict_threshold"]


def test_mean_abs_delta_gold_only_and_flips():
    before = [item(["A"], {"A": 0.9, "B": 0.2})]
    after = [item(["A"], {"A": 0.6, "B": 0.5, "D": 0.4})]
    d = metrics.mean_abs_delta(before, after)
    assert d["n"] == 1
    assert d["mean"] == pytest.approx(0.3)
    d_all = metrics.mean_abs_delta(before, after, gold_only=False)
    assert d_all["n"] == 2
    assert d_all["mean"] == pytest.approx(0.3)
    # At .55: A stays in (.9 -> .6), B stays out (.2 -> .5). At .65 A flips out.
    assert metrics.decision_flips(before, after, 0.55) == 0
    assert metrics.decision_flips(before, after, 0.65) == 1
    assert (
        metrics.mean_abs_delta([item([], {"A": 0.1})], [item([], {"A": 0.2})])["n"] == 0
    )
