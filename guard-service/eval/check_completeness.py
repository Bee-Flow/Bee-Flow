"""Measured completeness: every `complete=True` claim must be earned.

`complete=True` on a PatternSpec tells pii.py to stop asking GLiNER about that
category for tenants in the spec's regions (regex_complete_categories). The
structural guard (`PatternSpec.__post_init__`: an anchored spec can never be
complete) cannot see the empirical failure mode: a pattern whose SHAPE misses
real-world forms. PhoneNumber shipped as complete for every region while its
regex measured recall 0.000 on four everyday shapes (bare Dutch mobile, bare
landline, 0031-prefixed, parenthesised NANP) that the model scores 0.985 on —
under tier=on those spans were detected by NOTHING, silently.

This check makes that class of claim fail loudly. Per claim:

  (a) absolute:  regex recall >= 0.90 on the corpus for that (region, category)
  (b) relative:  regex recall >= model recall - 0.02, read from the committed
                 off-tier baseline — suppression is only justified when the
                 regex is at least as good as the detector it silences.

Rows with < 30 gold spans are SKIPPED LOUDLY (below that a single span moves
recall further than any tolerance here — the same rule as run_eval's
_MIN_GOLD_TO_GATE). A skipped row is not a passed row: growing the corpus for
that region is the only way to earn the claim.

Model-free and CI-cheap: predictions come from predict_regex_only (the real
regex tier + the real _finalise), never from GLiNER.

Run:  python -m eval.check_completeness            exit 1 on violation
      python -m eval.check_completeness --json     machine-readable report
      python -m eval.check_completeness --strict   allowlist ignored
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

from .categories import WAS_REGEX
from .matcher import SpanTuple, match_spans
from .metrics import _region_of, evaluate
from .run_eval import (
    _MIN_GOLD_TO_GATE,
    _corpus_lock_digest,
    load_corpus,
    predict_regex_only,
)

_ABS_FLOOR = 0.90
_REL_MARGIN = 0.02
_BASELINE_OFF = os.path.join(
    os.path.dirname(__file__), "baseline", "metrics_off_baseline.json"
)

# Rows allowed to fail during STAGED LANDING only. Every entry names the phase
# that removes it; an entry without a removal plan is a suppressed alarm, which
# is the exact failure mode this module exists to end.
#
# Emptied when phase A2 landed the PhoneNumber demotion (complete=False) —
# the first claim this check ever caught. Keep it empty: the fix for a
# violation is fixing the spec, not allowlisting the alarm.
ALLOWED_FAILURES: dict[str, str] = {}


def _row_key(region: str, category: str) -> str:
    return f"{region}:{category}"


def _claims() -> tuple[set[str], dict[str, set[str]]]:
    """(global claims from _ANY specs, region -> claims from that region's specs).

    Read from the registry itself rather than regex_complete_categories(None),
    because before the regions=None semantics fix (phase A2) that function
    returns the union over every country — the very bug whose victims this
    check must attribute to their own (region, category) row, not to a blur.
    """
    from app.services.pii_regex import _SPECS, ANY_REGION

    global_claims: set[str] = set()
    region_claims: dict[str, set[str]] = defaultdict(set)
    for spec in _SPECS:
        if not spec.complete:
            continue
        if ANY_REGION in spec.regions:
            global_claims.add(spec.category)
        else:
            for r in spec.regions:
                region_claims[r].add(spec.category)
    return global_claims, region_claims


def _model_reference() -> tuple[dict | None, str | None]:
    """Per-category model recall from the committed off-tier baseline.

    Returns (per_category or None, note). The baseline must carry the current
    corpus lock — a stale reference would compare this corpus's regex against
    a different corpus's model, the exact confusion the lock exists to end.
    """
    if not os.path.isfile(_BASELINE_OFF):
        return None, (
            "no off-tier baseline committed (eval/baseline/"
            "metrics_off_baseline.json) — relative rule (b) NOT applied"
        )
    with open(_BASELINE_OFF, encoding="utf-8") as fh:
        data = json.load(fh)
    base_lock = (data.get("meta") or {}).get("corpus_lock")
    if base_lock != _corpus_lock_digest():
        return None, (
            "off-tier baseline has a STALE corpus lock — relative "
            "rule (b) NOT applied; regenerate it "
            "(python -m eval.run_eval --tier off --split held-out)"
        )
    return data["overall"]["per_category"], None


def _value_kind_recall(records, preds) -> dict[tuple[str, str], list[int]]:
    """(category, value_kind) -> [matched, total] over gold spans."""
    out: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for rec, pred in zip(records, preds):
        golds = [SpanTuple(s.start, s.end, s.category) for s in rec.spans]
        mr = match_spans(golds, list(pred), mode="overlap", iou_threshold=0.5)
        matched = {gi for gi, _pi, _score in mr.tp}
        for gi, s in enumerate(rec.spans):
            key = (s.category, s.value_kind or "-")
            out[key][1] += 1
            if gi in matched:
                out[key][0] += 1
    return out


def build_report(split: str = "all") -> dict:  # noqa: C901
    records = load_corpus(split=split)
    if not records:
        raise SystemExit(
            "no corpus records — run `python -m eval.generate_corpus` first"
        )
    preds, _ = predict_regex_only(records)
    report = evaluate(records, preds, regex_categories=WAS_REGEX)
    kinds = _value_kind_recall(records, preds)
    model_ref, model_note = _model_reference()
    global_claims, region_claims = _claims()

    rows: list[dict] = []

    def _check(region: str, category: str, metrics: dict | None) -> None:
        tp = int((metrics or {}).get("tp", 0))
        fn = int((metrics or {}).get("fn", 0))
        n = tp + fn
        row: dict = {"region": region, "category": category, "gold": n}
        if n == 0:
            row.update(
                verdict="SKIP",
                detail="no gold spans in this bucket — "
                "the claim is UNMEASURED, not passed",
            )
            rows.append(row)
            return
        if n < _MIN_GOLD_TO_GATE:
            row.update(
                verdict="SKIP",
                detail=f"only {n} gold spans (<{_MIN_GOLD_TO_GATE}) "
                f"— one span moves recall {1 / n:.0%}; grow the corpus to gate this",
            )
            rows.append(row)
            return
        recall = tp / n
        row["recall"] = round(recall, 4)
        reasons = []
        if recall < _ABS_FLOOR:
            reasons.append(f"recall {recall:.3f} < absolute floor {_ABS_FLOOR}")
        model_recall = None
        if model_ref is not None and category in model_ref:
            model_recall = float(model_ref[category].get("recall", 0.0))
            row["model_recall"] = model_recall
            if recall < model_recall - _REL_MARGIN:
                reasons.append(
                    f"recall {recall:.3f} < model {model_recall:.3f} - {_REL_MARGIN} "
                    f"— the regex silences a better detector"
                )
        if reasons:
            row.update(verdict="FAIL", detail="; ".join(reasons))
            # Which shapes are missing, exactly. Report-only: a 0.0 value_kind
            # hidden inside a passing category row is how the phone hole hid.
            row["value_kinds"] = {
                kind: {"matched": m, "gold": t, "recall": round(m / t, 4)}
                for (cat, kind), (m, t) in sorted(kinds.items())
                if cat == category
                and t
                and (region == "*" or _region_of(kind) == region)
            }
        else:
            row.update(verdict="ok")
        rows.append(row)

    overall = report["overall"]["per_category"]
    for cat in sorted(global_claims):
        _check("*", cat, overall.get(cat))
    by_region = report.get("by_region") or {}
    for region in sorted(region_claims):
        per_cat = (by_region.get(region) or {}).get("per_category", {})
        for cat in sorted(region_claims[region]):
            _check(region, cat, per_cat.get(cat))

    return {
        "split": split,
        "corpus_lock": _corpus_lock_digest(),
        "abs_floor": _ABS_FLOOR,
        "rel_margin": _REL_MARGIN,
        "model_reference_note": model_note,
        "rows": rows,
    }


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    ap = argparse.ArgumentParser(
        description="Verify that every complete=True claim is empirically earned."
    )
    ap.add_argument(
        "--split", choices=["all", "calibrate", "dev", "held-out"], default="all"
    )
    ap.add_argument("--json", action="store_true", help="print the full report as JSON")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="ignore ALLOWED_FAILURES (the staged-landing allowlist)",
    )
    ap.add_argument(
        "--allow",
        action="append",
        default=[],
        metavar="REGION:Category",
        help="extra allowed row keys (repeatable)",
    )
    args = ap.parse_args(argv)

    report = build_report(split=args.split)
    allowed = (
        {}
        if args.strict
        else {**ALLOWED_FAILURES, **{k: "--allow flag" for k in args.allow}}
    )

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    violations: list[str] = []
    print(
        f"completeness check — split={report['split']}  "
        f"floors: recall>={_ABS_FLOOR} and >=model-{_REL_MARGIN}"
    )
    if report["model_reference_note"]:
        print(f"  NOTE: {report['model_reference_note']}", file=sys.stderr)
    for row in report["rows"]:
        key = _row_key(row["region"], row["category"])
        mark = row["verdict"]
        if row["verdict"] == "FAIL" and key in allowed:
            mark = "FAIL (allowed)"
        line = (
            f"  {mark:15s} {row['region']:3s} {row['category']:35s} "
            f"gold={row['gold']:<5d}"
        )
        if "recall" in row:
            line += f" R={row['recall']:.3f}"
        if "model_recall" in row:
            line += f" model={row['model_recall']:.3f}"
        if row.get("detail"):
            line += f"  — {row['detail']}"
        print(line)
        if row["verdict"] == "FAIL":
            for kind, k in (row.get("value_kinds") or {}).items():
                print(
                    f"        value_kind {kind:28s} R={k['recall']:.3f} "
                    f"({k['matched']}/{k['gold']})"
                )
            if key in allowed:
                print(f"        allowed: {allowed[key]}")
            else:
                violations.append(key)

    if violations:
        print(
            f"\nCOMPLETENESS: FAIL — {len(violations)} unearned complete=True "
            f"claim(s): {', '.join(violations)}",
            file=sys.stderr,
        )
        print(
            "Fix: set complete=False on the offending spec (the category then "
            "returns to GLiNER), or fix the pattern and prove it here.",
            file=sys.stderr,
        )
        return 1
    print("\nCOMPLETENESS: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
