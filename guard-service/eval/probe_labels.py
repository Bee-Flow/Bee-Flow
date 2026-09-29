"""Per-label probe — measure ONE category's labels in isolation.

The full eval answers "how good is the detector". This answers the question you
need when a single category collapses: *does the model see these spans at all,
and under which label string?*

Those are different questions and the full eval cannot separate them. A category
can score zero for three unrelated reasons:

  1. the model never proposes the span (no label works — a model problem),
  2. it proposes it under a label we did not ask for (a mapping problem),
  3. it proposes it but another label in the same group outscores it and
     _finalise drops it (label dilution — a grouping problem).

This probe isolates each label into its own single-label group, scans at a floor
low enough that nothing is filtered, and reports coverage of that category's
gold spans. Existing measurements in pii.py's header (IBAN P 0.950 vs iban
P 0.474; burgerservicenummer P 1.000 vs "national id number" P 0.323) were
produced this way — casing and language are per-label empirical facts.

Run (inside the guard container, needs the model):
  python -m eval.probe_labels --category InternationalBankingAccountNumber \\
      --labels "IBAN" "iban" "international bank account number" \\
      --split calibrate --max-records 40
"""

from __future__ import annotations

import argparse
import json
import sys

from .run_eval import load_corpus

# Low enough that _final_floor collapses to _ABSOLUTE_FLOOR for every category,
# so a label's absence means the MODEL is silent rather than the floor filtering.
_PROBE_FLOOR = 0.10


def probe(category: str, labels: list[str], records, max_records: int) -> dict:
    import contextlib
    from unittest.mock import patch

    from app.config import settings
    from app.services.pii import get_pii_service
    import app.services.pii as pii_mod

    svc = get_pii_service()
    svc.load(settings.pii_model)
    if not svc.ready:
        raise RuntimeError(f"model failed to load: {svc.load_error}")

    # Only records that actually carry a gold span of this category.
    with_gold = [r for r in records if any(s.category == category for s in r.spans)]
    with_gold = with_gold[:max_records]
    n_gold = sum(1 for r in with_gold for s in r.spans if s.category == category)
    if not n_gold:
        raise SystemExit(f"no gold {category} spans in this split")

    results = {}
    for label in labels:
        # "a+b" probes a and b together, so label DILUTION is measurable: a
        # label that scores well alone can collapse when grouped (measured for
        # ApiKeyOrSecret: "api key" alone P 1.000, with three siblings P 0.475).
        group = [p.strip() for p in label.split("+") if p.strip()]

        # One group, mapped to the category under test. Everything else is
        # removed so nothing outside the group can outscore or dilute it.
        #
        # The map needs BOTH casings of every label, because detect() reads it
        # two different ways: active_groups filters on the label EXACTLY as
        # written in _LABEL_GROUPS, while _accept() looks up
        # (ent["label"] or "").lower(). Register only one casing and the label
        # silently yields zero detections — which is why production carries
        # both "IBAN" and "iban" keys for the same category.
        keys = {}
        for g in group:
            keys[g] = category
            keys[g.lower()] = category
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(settings, "pii_regex_tier", "off"))
            stack.enter_context(pii_mod.use_label_groups([group]))
            stack.enter_context(
                patch.dict(pii_mod.GLINER_LABELS_TO_CATEGORY, keys, clear=True)
            )
            stack.enter_context(
                patch.dict(pii_mod._PER_CATEGORY_THRESHOLD, {category: _PROBE_FLOOR})
            )

            covered = exact = predicted = 0
            for r in with_gold:
                cands = [
                    c
                    for c in svc.detect_candidates(
                        r.text,
                        confidence_threshold=_PROBE_FLOOR,
                        enabled_categories=[category],
                    )
                    if c["category"] == category
                ]
                predicted += len(cands)
                for s in (x for x in r.spans if x.category == category):
                    hits = [
                        c
                        for c in cands
                        if c["offset"] < s.end and s.start < c["offset"] + c["length"]
                    ]
                    if hits:
                        covered += 1
                        if any(
                            c["offset"] == s.start
                            and c["offset"] + c["length"] == s.end
                            for c in hits
                        ):
                            exact += 1

        recall = covered / n_gold
        precision = covered / predicted if predicted else 0.0
        results[label] = {
            "recall": round(recall, 4),
            "precision_approx": round(precision, 4),
            "exact_boundary": round(exact / n_gold, 4),
            "predicted_spans": predicted,
            "covered_gold": covered,
        }
        print(
            f"  {label!r:44s} R={recall:.3f}  P~={precision:.3f}  "
            f"exact={exact / n_gold:.3f}  (predicted {predicted} for {n_gold} gold)",
            flush=True,
        )

    return {
        "category": category,
        "n_gold": n_gold,
        "n_records": len(with_gold),
        "labels": results,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Probe individual GLiNER labels for one category."
    )
    ap.add_argument("--category", required=True)
    ap.add_argument("--labels", nargs="+", required=True)
    ap.add_argument(
        "--split", choices=["all", "calibrate", "dev", "held-out"], default="calibrate"
    )
    ap.add_argument("--max-records", type=int, default=40)
    ap.add_argument("--out")
    args = ap.parse_args()

    if args.split == "held-out":
        # Same rule as calibrate.py: held-out is the decision set, spent once.
        print(
            "refusing to probe on held-out — sweep on calibrate, confirm on dev",
            file=sys.stderr,
        )
        return 2

    records = load_corpus(split=args.split)
    print(
        f"probing {args.category} over {args.split} "
        f"({len(args.labels)} labels, floor {_PROBE_FLOOR}):"
    )
    result = probe(args.category, args.labels, records, args.max_records)

    best = max(result["labels"].items(), key=lambda kv: kv[1]["recall"])
    print(f"\nbest: {best[0]!r} at recall {best[1]['recall']}")
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2, sort_keys=True)
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
