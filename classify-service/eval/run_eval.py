"""Score one candidate on one split and write results/<model>.<split>.json.

    python run_eval.py --model gliclass --split dev
    python run_eval.py --model gliclass --split heldout   # once, after dev

Headline configuration (fixed in MODEL-DECISIONS.md before any run): English
labels in the articled form, the text cut to its first 512 tokens of the
model's own tokenizer, and all of a kind's labels scored in one call.

On dev the runner also measures three probes:
  (a) label-set sensitivity  two distractor labels added to every kind's set
  (b) label phrasing         "complaint" vs "a complaint"; Dutch labels on Dutch items
  (c) truncation             long emails: head vs head+tail vs full text

On held-out it reports the metrics at the thresholds chosen on dev, which it
reads from results/<model>.dev.json. It never picks a threshold of its own.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass
from typing import NamedTuple

import metrics
from common import (
    CORPUS,
    HEAD_TOKENS,
    RESULTS,
    env_info,
    load_adapter,
    load_corpus,
    load_labelsets,
    set_threads,
    token_offsets,
    write_json,
)
from common import cap_text as _cap


def _sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


class Variant(NamedTuple):
    """How to score: which label phrasing, which truncation, extra labels, NLI template.

    `form` picks the phrasing sent to the model ("en", "bare" or "nl"); `mode` is
    a common.cap_text mode; `distractors` appends the kind's distractor labels.
    """

    form: str = "en"
    mode: str = "head"
    distractors: bool = False
    template: str | None = None


HEADLINE = Variant()


@dataclass
class Ctx:
    """One loaded model, one split, and the headline scoring the probes compare to."""

    adapter: object
    items: list
    labelsets: dict
    base: list
    best: float
    n_tokens: dict


def score_items(adapter, items, labelsets, variant=HEADLINE):
    """Score items kind by kind; every score is keyed by the label's English form,
    so every variant is comparable with the headline item by item."""
    tok = adapter.tokenizer()
    kwargs = {"hypothesis_template": variant.template} if variant.template else {}
    by_id = {}
    for kind in sorted({i["kind"] for i in items}):
        extra = labelsets[kind]["distractors"] if variant.distractors else []
        entries = labelsets[kind]["labels"] + extra
        sent = [e[variant.form] for e in entries]
        back = {e[variant.form]: e["en"] for e in entries}
        group = [i for i in items if i["kind"] == kind]
        texts = [_cap(tok, i["text"], variant.mode) for i in group]
        for item, row in zip(group, adapter.scores(texts, sent, **kwargs), strict=True):
            by_id[item["id"]] = {
                "id": item["id"],
                "kind": kind,
                "lang": item["lang"],
                "gold": list(item["labels"]),
                "scores": {back[label]: score for label, score in row.items()},
            }
    return [by_id[i["id"]] for i in items]


def restrict(scored, labelsets):
    """Drop distractor scores, so routing on the node's own labels can be compared."""
    out = []
    for s in scored:
        keep = {e["en"] for e in labelsets[s["kind"]]["labels"]}
        out.append({**s, "scores": {k: v for k, v in s["scores"].items() if k in keep}})
    return out


def compare(base, variant, threshold):
    """How a variant scoring differs from the headline on the same items."""
    own = metrics.report(variant)
    return {
        "n": len(base),
        "headline_macro_f1_at_best": round(metrics.macro_f(base, threshold), 4),
        "variant_macro_f1_at_best": round(metrics.macro_f(variant, threshold), 4),
        "variant_best_threshold": own["best_threshold"],
        "variant_macro_f1_at_own_best": own["at_best"]["macro_f1"],
        "headline_top1": metrics.top1_accuracy(base)["accuracy"],
        "variant_top1": metrics.top1_accuracy(variant)["accuracy"],
        "gold_score_mean_abs_delta": metrics.mean_abs_delta(base, variant),
        "decision_flips_at_best": metrics.decision_flips(base, variant, threshold),
        # Whole curves, so a single default threshold can be checked against
        # every variant, not just each variant's own peak.
        "macro_f1_by_threshold": {
            str(t): [
                round(metrics.macro_f(base, t), 4),
                round(metrics.macro_f(variant, t), 4),
            ]
            for t in metrics.THRESHOLDS
        },
    }


def probe_sensitivity(ctx: Ctx):
    labelsets, base, best = ctx.labelsets, ctx.base, ctx.best
    with_d = score_items(ctx.adapter, ctx.items, labelsets, Variant(distractors=True))
    own = restrict(with_d, labelsets)
    fired = 0
    for s in with_d:
        names = {d["en"] for d in labelsets[s["kind"]]["distractors"]}
        fired += any(s["scores"][n] >= best for n in names)
    return {
        "distractors": {
            k: [d["en"] for d in v["distractors"]] for k, v in labelsets.items()
        },
        **compare(base, own, best),
        "all_labels_mean_abs_delta": metrics.mean_abs_delta(base, own, gold_only=False),
        "distractor_fired_share_at_best": round(fired / len(with_d), 4),
    }


def probe_phrasing(ctx: Ctx):
    """Label wording. Dutch labels are scored on EVERY item, not only the Dutch
    ones: a node an author labels in Dutch will also see English mail, so the
    question for the UI placeholder is what Dutch labels do to the whole inbox."""
    bare = score_items(ctx.adapter, ctx.items, ctx.labelsets, Variant(form="bare"))
    template = getattr(ctx.adapter, "TEMPLATE_NL", None)
    dutch = score_items(
        ctx.adapter, ctx.items, ctx.labelsets, Variant(form="nl", template=template)
    )
    out = {
        "bare_vs_articled": compare(ctx.base, bare, ctx.best),
        "dutch_labels": {"hypothesis_template": template},
    }
    for lang in ("nl", "en", "all"):

        def keep(s, lang=lang):
            return lang == "all" or s["lang"] == lang

        out["dutch_labels"][f"on_{lang}_items"] = compare(
            [b for b in ctx.base if keep(b)], [d for d in dutch if keep(d)], ctx.best
        )
    return out


def _gold_and_rival(scored):
    gold = [s["scores"][g] for s in scored for g in s["gold"]]
    rival = [
        max(v for k, v in s["scores"].items() if k not in s["gold"]) for s in scored
    ]
    return round(statistics.fmean(gold), 4) if gold else None, round(
        statistics.fmean(rival), 4
    )


def probe_truncation(ctx: Ctx):
    n_tokens = ctx.n_tokens
    long_items = [
        i for i in ctx.items if i["kind"] == "email" and n_tokens[i["id"]] > HEAD_TOKENS
    ]
    ids = {i["id"] for i in long_items}
    variants = {"head": [b for b in ctx.base if b["id"] in ids]}
    for mode in ("head_tail", "full"):
        variants[mode] = score_items(
            ctx.adapter, long_items, ctx.labelsets, Variant(mode=mode)
        )
    out = {
        "n": len(long_items),
        "tokens": {i["id"]: n_tokens[i["id"]] for i in long_items},
    }
    for mode, scored in variants.items():
        p, r, f1 = metrics.micro_prf(scored, ctx.best)
        gold_mean, rival_mean = _gold_and_rival(scored)
        out[mode] = {
            "micro_f1_at_best": round(f1, 4),
            "micro_precision": round(p, 4),
            "micro_recall": round(r, 4),
            "mean_gold_score": gold_mean,
            "mean_best_non_gold_score": rival_mean,
            "per_item_gold_scores": {
                s["id"]: {g: round(s["scores"][g], 4) for g in s["gold"]}
                for s in scored
            },
        }
    return out


def probe_independent(ctx: Ctx):
    """Each label scored ALONE: one pass per label, so no label can move another.

    This is the service's label_mode="independent". It answers joint vs
    independent with an F1 and a cost, rather than with the sensitivity number
    alone. Skipped for a model whose labels are independent by construction.
    """
    if getattr(ctx.adapter, "INDEPENDENT_BY_CONSTRUCTION", False):
        return {"skipped": "labels are scored independently by construction"}
    tok = ctx.adapter.tokenizer()
    by_id = {i["id"]: {**i, "gold": list(i["labels"]), "scores": {}} for i in ctx.items}
    t0 = time.perf_counter()
    for kind in sorted({i["kind"] for i in ctx.items}):
        group = [i for i in ctx.items if i["kind"] == kind]
        texts = [_cap(tok, i["text"], "head") for i in group]
        for label in (e["en"] for e in ctx.labelsets[kind]["labels"]):
            for item, row in zip(
                group, ctx.adapter.scores(texts, [label]), strict=True
            ):
                by_id[item["id"]]["scores"][label] = row[label]
    seconds = time.perf_counter() - t0
    indep = [by_id[i["id"]] for i in ctx.items]
    return {
        **compare(ctx.base, indep, ctx.best),
        "seconds_per_item": round(seconds / len(ctx.items), 3),
    }


def heldout_view(scored, model):
    dev = _read_dev(model)
    view = {"dev_file": f"results/{model}.dev.json", "thresholds_from_dev": dev}
    for name, t in dev.items():
        view[f"at_{name}"] = metrics.summary(scored, t)
    t = dev["best_threshold"]
    view["by_lang_at_dev_best"] = metrics.breakdown(scored, t, "lang")
    view["by_kind_at_dev_best"] = metrics.breakdown(scored, t, "kind")
    return view


def _read_dev(model):
    path = os.path.join(RESULTS, f"{model}.dev.json")
    if not os.path.isfile(path):
        sys.exit(
            f"no {path}: run --split dev first; held-out never picks its own threshold"
        )
    with open(path, encoding="utf-8") as fh:
        r = json.load(fh)["results"]
    return {k: r[k] for k in ("best_threshold", "loose_threshold", "strict_threshold")}


def token_stats(items, tok):
    n_tokens = {i["id"]: len(token_offsets(tok, i["text"])) for i in items}
    by_kind = {}
    for kind in sorted({i["kind"] for i in items}):
        counts = sorted(n_tokens[i["id"]] for i in items if i["kind"] == kind)
        by_kind[kind] = {
            "min": counts[0],
            "median": counts[len(counts) // 2],
            "max": counts[-1],
        }
    return n_tokens, by_kind


def run(args):
    set_threads(args.threads)
    adapter, info, load_s = load_adapter(args.model)
    items = load_corpus(args.split)
    labelsets = load_labelsets()
    n_tokens, tokens_by_kind = token_stats(items, adapter.tokenizer())

    t0 = time.perf_counter()
    base = score_items(adapter, items, labelsets)
    score_s = time.perf_counter() - t0
    rep = metrics.report(base)

    out = {
        "model": args.model,
        "split": args.split,
        "provenance": info,
        "env": env_info(),
        "load_seconds": load_s,
        "corpus": {
            "items_sha256": _sha256(os.path.join(CORPUS, f"items.{args.split}.jsonl")),
            "labelsets_sha256": _sha256(os.path.join(CORPUS, "labelsets.json")),
            "n": len(items),
            "tokens_by_kind": tokens_by_kind,
        },
        "headline_config": {
            "labels": "en (articled)",
            "truncation": f"head {HEAD_TOKENS} tokens",
            "joint_call": True,
        },
        "timing": {
            "score_seconds": round(score_s, 2),
            "seconds_per_item": round(score_s / len(items), 3),
        },
        "results": rep,
    }
    if args.split == "heldout":
        out["heldout"] = heldout_view(base, args.model)
    if args.probes:
        ctx = Ctx(adapter, items, labelsets, base, rep["best_threshold"], n_tokens)
        out["probes"] = {
            "label_set_sensitivity": probe_sensitivity(ctx),
            "label_phrasing": probe_phrasing(ctx),
            "truncation": probe_truncation(ctx),
            "independent_labels": probe_independent(ctx),
        }
    out["items"] = [
        {**s, "n_tokens": n_tokens[s["id"]], "scores": _round(s["scores"])}
        for s in base
    ]
    return out


def _round(scores):
    return {k: round(v, 5) for k, v in scores.items()}


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--model",
        required=True,
        choices=["gliclass", "gliclass-edge", "gliner2", "nli"],
    )
    ap.add_argument("--split", required=True, choices=["dev", "heldout"])
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument(
        "--probes",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="default: on for dev only",
    )
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if args.probes is None:
        args.probes = args.split == "dev"
    out = run(args)
    path = args.out or os.path.join(RESULTS, f"{args.model}.{args.split}.json")
    write_json(path, out)
    r = out["results"]
    print(
        f"{args.model} {args.split}: best t={r['best_threshold']} macro-F1={r['at_best']['macro_f1']} "
        f"micro-F1={r['at_best']['micro_f1']} | at 0.5 macro-F1={r['at_0_5']['macro_f1']} | "
        f"nl={r['by_lang'].get('nl', {}).get('macro_f1')} en={r['by_lang'].get('en', {}).get('macro_f1')} -> {path}"
    )


if __name__ == "__main__":
    main()
