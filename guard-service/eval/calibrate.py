"""Threshold calibration — propose per-category confidence floors from data.

Efficiency trick: run detection ONCE at a slider low enough that every
per-category floor collapses to the absolute floor (0.10), capturing every
candidate span with its confidence. Then, per category, sweep a candidate floor
and recompute precision/recall/F_beta against gold WITHOUT re-running the model.

Recalibration is DEFERRED (see the plan): this tool only *proposes*. It prints a
paste-ready ``_PER_CATEGORY_THRESHOLD`` dict and a diff vs the current values; a
human reviews the PR curves and commits. Model-based (needs real confidences).

Run:  python -m eval.calibrate --split calibrate --out eval/calibration.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .schema import Record
from .matcher import SpanTuple, match_spans
from .metrics import _fbeta
from .run_eval import load_corpus, _to_spans

# Per-category operating-point policy. High-leak categories are recall-biased
# (beta=2) with a modest precision floor; noisier ones favour precision.
# (category -> (beta, min_precision)). Person is deliberately the most lenient.
_CALIBRATION_POLICY: dict[str, tuple[float, float]] = {
    "Person": (2.0, 0.55),
    "Organization": (1.0, 0.80),
    "Address": (2.0, 0.70),
    "DateOfBirth": (1.0, 0.80),
    "PassportNumber": (1.0, 0.85),
    "DriversLicenseNumber": (1.0, 0.85),
    "BankAccountNumber": (1.0, 0.80),
    "MedicalCondition": (2.0, 0.70),
    "Medication": (1.0, 0.80),
    "HealthInsuranceNumber": (1.0, 0.80),
    # ── Formerly regex-owned ───────────────────────────────────────────
    # These had no policy because the regex tier owned them outright, and no
    # floor either — so they fell through _final_floor to the raw slider
    # (0.70), which silently dropped every borderline span.
    #
    # The precision floors are deliberately HIGH: each of these is losing a
    # checksum or an anchor, and under GLiNER-only a precision regression
    # surfaces as a user-facing BLOCK (the org default action is 'block' and
    # nothing filters on confidence Node-side). beta=2 where a miss is a leak.
    "PhoneNumber": (2.0, 0.85),
    "Email": (2.0, 0.90),
    "InternationalBankingAccountNumber": (2.0, 0.85),
    "CreditCardNumber": (2.0, 0.90),
    "NationalIdentificationNumber": (2.0, 0.85),
    "USSocialSecurityNumber": (2.0, 0.85),
    "ApiKeyOrSecret": (2.0, 0.80),
    "TaxIdentificationNumber": (1.0, 0.85),
    "LicensePlateNumber": (1.0, 0.85),
    # Highest structural FP risk in the set (version strings, 1.2.3.4, build
    # numbers) and the lowest leak consequence — so precision-first.
    "IPAddress": (1.0, 0.90),
    "URL": (1.0, 0.90),
}

_GRID = [round(0.10 + 0.01 * i, 2) for i in range(0, 90)]  # 0.10 .. 0.99

# Below this, one span moves recall by more than 3pp and the fitted floor is
# describing sampling noise. Warned about rather than refused, because the
# reviewer may still want to see the curve.
_MIN_GOLD_FOR_A_FLOOR = 30


def _collect_candidates(records, preds):
    """Group gold and candidate spans by category. Candidates carry confidence."""
    gold_by_cat: dict[str, list[tuple[int, int, int]]] = {}
    cand_by_cat: dict[str, list[tuple[int, int, int, float]]] = {}
    for ri, (rec, ps) in enumerate(zip(records, preds)):
        for s in rec.spans:
            gold_by_cat.setdefault(s.category, []).append((ri, s.start, s.end))
        for p in ps:
            cand_by_cat.setdefault(p.category, []).append(
                (ri, p.start, p.end, p.confidence)
            )
    return gold_by_cat, cand_by_cat


def _prf_at(gold, cand, t):
    """Precision/recall for candidates with confidence >= t, matched per record."""
    from collections import defaultdict

    golds_by_r: dict[int, list[SpanTuple]] = defaultdict(list)
    for ri, s, e in gold:
        golds_by_r[ri].append(SpanTuple(s, e, "X"))
    preds_by_r: dict[int, list[SpanTuple]] = defaultdict(list)
    for ri, s, e, c in cand:
        if c >= t:
            preds_by_r[ri].append(SpanTuple(s, e, "X", c))
    tp = fp = fn = 0
    for ri in set(golds_by_r) | set(preds_by_r):
        mr = match_spans(golds_by_r.get(ri, []), preds_by_r.get(ri, []), mode="overlap")
        tp += len(mr.tp)
        fp += len(mr.fp)
        fn += len(mr.fn)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    return precision, recall, tp, fp, fn


def calibrate(
    records: list[Record],
    threshold_probe: float = 0.10,
    tier: str = "off",
    label_groups: list[list[str]] | None = None,
) -> dict:
    from app.config import settings
    from app.services.pii import get_pii_service
    import app.services.pii as pii_mod

    svc = get_pii_service()
    svc.load(settings.pii_model)
    if not svc.ready:
        raise RuntimeError(f"model failed to load: {svc.load_error}")

    # In hybrid mode the regex tier emits the formerly-regex categories at
    # 0.95-0.99 and _finalise discards the model's competing spans, so their
    # calibration curves would come back empty and every proposed floor would
    # be meaningless. Calibrate the tier we intend to ship.
    #
    # Flip the REAL switch rather than patching detect_regex_pii out: detect()
    # also gates the BSN checksum carve-out on tier_mode == "off", so the old
    # patching measured a configuration that ships nowhere.
    import contextlib
    from unittest.mock import patch

    _stack = contextlib.ExitStack()
    _stack.enter_context(
        patch.object(settings, "pii_regex_tier", "off" if tier == "off" else "on")
    )
    if label_groups:
        # Floors are only valid for the grouping they were fitted under: the
        # group decides which labels compete in one forward pass, and therefore
        # the whole score distribution the floor sits in.
        _stack.enter_context(pii_mod.use_label_groups(label_groups))
        if svc._tokenizer is not None:
            prompt = pii_mod._label_prompt_tokens(svc._tokenizer, label_groups)
            budget = max(64, svc._max_len - prompt - 16)
            _stack.callback(setattr, svc, "_text_token_budget", svc._text_token_budget)
            _stack.callback(setattr, svc, "_overlap_tokens", svc._overlap_tokens)
            svc._text_token_budget = budget
            svc._overlap_tokens = min(budget // 2, max(48, budget * 15 // 100))

    preds = []
    with _stack:
        for r in records:
            # detect_candidates(), NOT detect(): detect() emits one entity per
            # overlap cluster and DELETES the losers, so a category that lost
            # its cluster is absent from its own curve at EVERY threshold. Of
            # 85 gold IBANs, 43 were emitted as BankAccountNumber — their
            # sweep was bounded far below achievable recall and the floor it
            # proposed was fitted on a truncated candidate set.
            cands = svc.detect_candidates(
                r.text, confidence_threshold=threshold_probe, enabled_categories=None
            )
            # Two corrections, both about sweeping the quantity the floor is
            # actually applied to:
            #
            #  * model spans only — a validator-generated span (BSN elfproef)
            #    arrives at a fixed 0.99 and turns the curve into a step
            #    function fitted to a constant the model never produced;
            #  * the MODEL's own score, not the post-validation one. _accept()
            #    applies the floor before _apply_validators runs, so a floor
            #    fitted to boosted confidences is unreachable by construction.
            #    Measured: 37 IBAN candidates sat on exactly VALIDATED_CONFIDENCE
            #    while the model scored them 0.11-0.26; the fitted floor of 0.92
            #    detected 0 of 90 on dev.
            model_spans = []
            for e in cands:
                if e.get("source", "model") != "model":
                    continue
                e = dict(e)
                e["confidence"] = e.get("model_confidence", e["confidence"])
                model_spans.append(e)
            preds.append(_to_spans(model_spans))

    gold_by_cat, cand_by_cat = _collect_candidates(records, preds)
    return {"proposals": _propose(gold_by_cat, cand_by_cat), "n_records": len(records)}


def calibrate_endpoint(
    records: list[Record], url: str, api_key: str | None, threshold_probe: float = 0.10
) -> dict:
    """Collect candidates over HTTP and run the same sweep.

    For CANDIDATE SHIMS (tools/candidate_shim) that emit unresolved spans at a
    low query floor — the sweep then operates on the same kind of candidate
    set as detect_candidates() provides in-process. Do NOT point this at a
    production guard: /pii there returns post-_finalise cluster winners, which
    re-creates the truncated-candidate-set trap documented above (43 of 85
    gold IBANs absent from their own curve at every threshold).
    """
    from .run_eval import predict_endpoint

    preds, _degraded, meta = predict_endpoint(records, url, api_key, threshold_probe)
    gold_by_cat, cand_by_cat = _collect_candidates(records, preds)
    return {
        "proposals": _propose(gold_by_cat, cand_by_cat),
        "n_records": len(records),
        "endpoint": url,
        "timing_ms": meta.get("timing_ms"),
    }


def _propose(gold_by_cat: dict, cand_by_cat: dict) -> dict:
    """The pure sweep: policy × grid → per-category proposals."""
    proposals: dict[str, dict] = {}
    from app.services.pii import _PER_CATEGORY_THRESHOLD

    for cat, (beta, p_min) in _CALIBRATION_POLICY.items():
        gold = gold_by_cat.get(cat, [])
        cand = cand_by_cat.get(cat, [])
        curve = []
        best = None
        for t in _GRID:
            p, r, tp, fp, fn = _prf_at(gold, cand, t)
            f = _fbeta(p, r, beta)
            curve.append(
                {
                    "t": t,
                    "precision": round(p, 4),
                    "recall": round(r, 4),
                    "fbeta": round(f, 4),
                    "tp": tp,
                    "fp": fp,
                    "fn": fn,
                }
            )
            if p >= p_min and (best is None or f > best["fbeta"]):
                best = {
                    "t": t,
                    "precision": round(p, 4),
                    "recall": round(r, 4),
                    "fbeta": round(f, 4),
                }
        # NO silent fallback. The old code, when the precision floor was never
        # reachable, quietly returned max-F_beta with a note buried in JSON —
        # a floor with NO precision guarantee at all, which is the exact
        # inverse of what _CALIBRATION_POLICY asked for. Under model-only a
        # precision regression surfaces as a user-facing BLOCK, so an
        # unreachable policy is a decision for a human, not a default.
        unreachable = best is None and bool(curve)
        frontier = None
        if unreachable:
            # Show the achievable trade-off so the human can either lower the
            # policy or accept that this category cannot ship model-only.
            frontier = sorted(
                (
                    {"t": c["t"], "precision": c["precision"], "recall": c["recall"]}
                    for c in curve
                    if c["tp"] + c["fp"] > 0
                ),
                key=lambda c: -c["precision"],
            )[:5]
            best_p = max((c["precision"] for c in curve), default=0.0)
            print(
                f"  !! {cat}: REFUSING to propose a floor — min_precision "
                f"{p_min} is unreachable (best achievable precision "
                f"{best_p:.4f} over the whole 0.10-0.99 grid). Lower the "
                f"policy or accept this category cannot ship model-only.",
                flush=True,
            )
        if not cand and gold:
            # Silent empty curves are how a meaningless floor gets committed.
            print(
                f"  !! {cat}: {len(gold)} gold spans but ZERO candidates — the "
                f"model was never asked, or the tier is wrong",
                flush=True,
            )
        if gold and len(gold) < _MIN_GOLD_FOR_A_FLOOR:
            print(
                f"  !! {cat}: only {len(gold)} gold spans — one span moves "
                f"recall {1 / len(gold):.1%}; this floor is fitted on noise",
                flush=True,
            )
        proposals[cat] = {
            "beta": beta,
            "min_precision": p_min,
            "current_floor": _PER_CATEGORY_THRESHOLD.get(cat),
            "proposed_floor": best["t"] if best else None,
            "at_operating_point": best,
            "policy_unreachable": unreachable,
            "precision_frontier": frontier,
            "gold_count": len(gold),
            "candidate_count": len(cand),
        }
    return proposals


def _print_paste(proposals: dict) -> None:
    refused = [c for c, pr in proposals.items() if pr["proposed_floor"] is None]
    print(
        "\n# Proposed _PER_CATEGORY_THRESHOLD (review the PR curves before committing):"
    )
    print("_PER_CATEGORY_THRESHOLD = {")
    for cat, pr in proposals.items():
        cur = pr["current_floor"]
        new = pr["proposed_floor"]
        if new is None:
            # Never emit a paste-able value for a category whose policy could
            # not be met — the whole point of refusing is that a human decides.
            print(
                f"    {cat!r:38s} {cur},   # UNCHANGED: policy unreachable, decide manually"
            )
            continue
        arrow = "" if cur == new else f"   # was {cur}"
        print(f"    {cat!r:38s} {new},{arrow}")
    print("}")
    if refused:
        print(
            f"\n!! {len(refused)} categor(y/ies) have NO proposal because their "
            f"min_precision was unreachable: {', '.join(sorted(refused))}"
        )
        print(
            "   See proposals[cat]['precision_frontier'] for the achievable "
            "trade-off, then either lower _CALIBRATION_POLICY or accept that "
            "the category cannot ship model-only."
        )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Propose per-category PII confidence floors."
    )
    ap.add_argument(
        "--split", choices=["all", "calibrate", "dev", "held-out"], default="calibrate"
    )
    ap.add_argument(
        "--tier",
        choices=["hybrid", "off", "gliner"],
        default="off",
        help="calibrate the tier you intend to ship; in hybrid the "
        "regex tier hides the model's candidates. 'gliner' is "
        "the old spelling of 'off'.",
    )
    ap.add_argument(
        "--probe", type=float, default=0.10, help="low slider to collect candidates"
    )
    ap.add_argument(
        "--endpoint",
        help="collect candidates from a live /pii URL "
        "instead of in-process. For CANDIDATE "
        "SHIMS only (see calibrate_endpoint) — "
        "not for a production guard.",
    )
    ap.add_argument("--api-key", default=os.environ.get("SERVICES_API_KEY"))
    ap.add_argument(
        "--label-groups",
        help="JSON file overriding _LABEL_GROUPS. "
        "Floors are only valid for the grouping "
        "they were fitted under.",
    )
    ap.add_argument(
        "--max-records",
        type=int,
        default=0,
        help="cap records (0 = all). A cap trades statistical power "
        "for turnaround; the warnings still fire.",
    )
    ap.add_argument(
        "--out", default=os.path.join(os.path.dirname(__file__), "calibration.json")
    )
    args = ap.parse_args()

    records = load_corpus(split=args.split)
    if not records:
        print("no corpus records — run `python -m eval.generate_corpus` first")
        return 2
    if args.split in ("held-out", "all"):
        # Fitting floors on the decision set and then reporting that set's
        # score is training-set evaluation with extra steps.
        print(
            f"refusing to calibrate on --split {args.split}: floors must be "
            f"fitted on 'calibrate' and gated on 'held-out'",
            file=sys.stderr,
        )
        return 2
    if args.max_records:
        records = records[: args.max_records]
    groups = None
    if args.label_groups:
        with open(args.label_groups, encoding="utf-8") as fh:
            groups = json.load(fh)
    if args.endpoint:
        if groups:
            print(
                "--label-groups has no effect over --endpoint (grouping lives "
                "inside the endpoint); refusing the ambiguous combination",
                file=sys.stderr,
            )
            return 2
        result = calibrate_endpoint(
            records, args.endpoint, args.api_key, threshold_probe=args.probe
        )
    else:
        tier = "off" if args.tier in ("off", "gliner") else "hybrid"
        result = calibrate(
            records, threshold_probe=args.probe, tier=tier, label_groups=groups
        )
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2, sort_keys=True)
    for cat, pr in result["proposals"].items():
        op = pr["at_operating_point"] or {}
        print(
            f"{cat:38s} {str(pr['current_floor']):>5s} -> {str(pr['proposed_floor']):>5s}  "
            f"(P={op.get('precision')} R={op.get('recall')} n_gold={pr['gold_count']})"
        )
    _print_paste(result["proposals"])
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
