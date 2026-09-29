"""Evaluation runner CLI.

Modes:
  --tier hybrid  in-process against PiiService.detect() — regex + model (default)
  --tier off     in-process with GUARD_PII_REGEX_TIER=off — the model-only path
  --tier regex   detect_regex_pii() only — model-free, CI-cheap (--regex-only)
  --endpoint URL POST to a running guard /pii endpoint

Scoring runs with all categories enabled (enabled_categories=None) — the target
"all 21 at once" scenario. Writes metrics.json and, with --baseline, gates the
run against a checked-in baseline (fail on a regression beyond tolerance).

Examples:
  python -m eval.run_eval --regex-only
  python -m eval.run_eval --tier off --split held-out --timing
  python -m eval.run_eval --tier off --bsn off --split held-out   # pure model-only
  python -m eval.run_eval --baseline eval/baseline/metrics_baseline.json --tol 0.02
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Sequence

from .schema import Record, load_jsonl
from .matcher import SpanTuple
from .metrics import evaluate, format_summary
from .categories import HIGH_RISK, WAS_REGEX, CLASS_MAPS, CONTROL_GROUP
from .leak import evaluate_leak

_CORPUS_DIR = os.path.join(os.path.dirname(__file__), "corpus")
_CORPUS_FILES = ("short.jsonl", "large.jsonl", "negatives.jsonl")


def _corpus_lock_digest() -> dict | None:
    """Per-file hashes of the corpus this run scored.

    Embedded in every metrics file so two reports can never be compared
    without it being visible that they scored different corpora — the
    quietest way to produce a wrong conclusion in a head-to-head.
    """
    path = os.path.join(_CORPUS_DIR, "CORPUS.lock.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            lock = json.load(fh)
        return {k: v.get("sha256") for k, v in lock.get("files", {}).items()}
    except Exception:
        return None


def load_corpus(split: str = "all", subset: str | None = None) -> list[Record]:
    records: list[Record] = []
    for f in _CORPUS_FILES:
        path = os.path.join(_CORPUS_DIR, f)
        if os.path.isfile(path):
            records.extend(load_jsonl(path))
    if split != "all":
        # Three-way split so held-out is touched exactly ONCE, at decision time:
        #   calibrate  <50   fit per-category floors
        #   dev      50-69   choose label groups, sanity-check calibration
        #   held-out  >=70   the decision run, used once
        # Calibrating and evaluating on the same records would report the
        # threshold sweep's training score as if it were a result.
        lo, hi = {"calibrate": (0, 50), "dev": (50, 70), "held-out": (70, 100)}[split]
        records = [r for r in records if lo <= _bucket(r.id) < hi]
    if subset == "ci":
        # A fast model-based gate. This MUST be sampled WITHIN the split, on an
        # independent hash: sharing _bucket() with the split made `ci` a
        # competing filter on the same axis, so `--subset ci --split held-out`
        # intersected (0,30) with (70,100) and returned ZERO records. The
        # documented fast gate could not run at all.
        records = [r for r in records if _bucket(r.id, salt="ci") < 30]
    return records


def _bucket(rec_id: str, salt: str = "") -> int:
    """Deterministic 0-99 bucket from the record id (no RNG — resume-safe).

    ``salt`` selects an INDEPENDENT bucketing of the same ids. Without it,
    any second use of this function is perfectly correlated with the split.
    """
    h = hashlib.sha256((salt + rec_id).encode("utf-8")).hexdigest()
    return int(h[:8], 16) % 100


def _to_spans(entities: list[dict]) -> list[SpanTuple]:
    out: list[SpanTuple] = []
    for e in entities:
        off = int(e.get("offset", 0))
        length = int(e.get("length", 0))
        out.append(
            SpanTuple(
                off,
                off + length,
                str(e.get("category", "")),
                float(e.get("confidence", 1.0)),
            )
        )
    return out


# ── Prediction backends ────────────────────────────────────────────────────


def predict_regex_only(
    records: Sequence[Record],
    regions: list[str] | None = None,
) -> tuple[list[list[SpanTuple]], list[bool]]:
    # Run the real regex tier, then the detector's own overlap-resolution
    # (_finalise) so the numbers reflect what PiiService.detect() actually
    # returns for regex-complete categories — e.g. a credit card written with
    # spaces no longer leaves a phone-shaped sub-span. _finalise is a static,
    # model-free method, so this stays CI-cheap.
    #
    # ``regions`` (--regions) restricts country-specific patterns. Its purpose is
    # comparative: running `--regions NL` reproduces the pre-region behaviour, so
    # the gain for every other country is a diff rather than a claim. That diff is
    # the evidence for turning GUARD_PII_REGEX_TIER back to `on` in production,
    # which is only safe once non-Dutch coverage exists.
    from app.services.pii_regex import detect_regex_pii
    from app.services.pii import PiiService

    preds, degraded = [], []
    for r in records:
        entities = detect_regex_pii(r.text, enabled_regions=regions)
        resolved = PiiService._finalise(entities, text=r.text)["entities"]
        preds.append(_to_spans(resolved))
        degraded.append(False)
    return preds, degraded


def _provenance(svc) -> dict:
    """Identity of the thing that produced these numbers.

    A baseline that does not pin the model, the inference libraries and the
    ONNX graph is not reproducible — a later run can differ for reasons that
    are invisible in the report, and the regression will be blamed on the code.
    """
    import importlib.metadata as md

    prov: dict = {
        "model_id": getattr(svc, "_model_id", None),
        "max_len": getattr(svc, "_max_len", None),
    }
    for pkg in ("gliner", "onnxruntime", "torch", "transformers"):
        try:
            prov[f"{pkg}_version"] = md.version(pkg)
        except Exception:
            prov[f"{pkg}_version"] = None
    from app.config import settings

    onnx_path = os.path.join(settings.pii_onnx_dir, settings.pii_onnx_file)
    if os.path.isfile(onnx_path):
        h = hashlib.sha256()
        with open(onnx_path, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        prov["onnx_sha256"] = h.hexdigest()
        prov["onnx_bytes"] = os.path.getsize(onnx_path)
    return prov


def predict_in_process(  # noqa: PLR0913
    records: Sequence[Record],
    threshold: float,
    tier: str = "hybrid",
    label_groups: list[list[str]] | None = None,
    bsn: bool = True,
    thresholds: dict[str, float] | None = None,
) -> tuple[list[list[SpanTuple]], list[bool], dict]:
    """In-process detection. ``tier`` ∈ {'hybrid','off'}.

    ``off`` is runnable on the CURRENT tree, before the production cutover, so
    the candidate configuration can be measured before anything ships.

    It flips the REAL switch — ``settings.pii_regex_tier`` — rather than
    patching ``detect_regex_pii`` out from under detect(). That distinction is
    not cosmetic: detect() also gates the BSN checksum carve-out on
    ``tier_mode == "off"`` (pii.py), so patching only the regex module measured
    GLiNER *without* the BSN validator while reporting it as the shipped `off`
    configuration. Every NationalIdentificationNumber number produced that way
    understated what ships.

    ``bsn=False`` additionally disables the checksum carve-out, so one corpus
    run can measure "model + validators" against "pure model-only".

    Returns (preds, degraded, meta). ``meta`` records the chunking parameters
    actually in force, because they change with the label groups and silently
    change what is being measured, plus the tier mode OBSERVED in the responses.
    """
    import contextlib
    import time
    from unittest.mock import patch

    from app.config import settings
    from app.services.pii import get_pii_service
    import app.services.pii as pii_mod
    import app.services.pii_bsn as bsn_mod

    svc = get_pii_service()
    svc.load(settings.pii_model)
    if not svc.ready:
        raise RuntimeError(f"model failed to load: {svc.load_error}")

    want_mode = "off" if tier == "off" else "on"
    meta: dict = {
        "tier": tier,
        "backend": svc.backend,
        "bsn": bsn,
        "requested_tier_mode": want_mode,
        **_provenance(svc),
    }
    stack = contextlib.ExitStack()
    with stack:
        stack.enter_context(patch.object(settings, "pii_regex_tier", want_mode))
        if thresholds:
            # Evaluate a CANDIDATE calibration without editing production
            # source. Without this, trying a floor means changing
            # _PER_CATEGORY_THRESHOLD in app/services/pii.py and remembering to
            # change it back — which is exactly how a wrong number ships.
            stack.enter_context(patch.dict(pii_mod._PER_CATEGORY_THRESHOLD, thresholds))
            meta["threshold_overrides"] = dict(sorted(thresholds.items()))
        if not bsn:
            # detect() imports detect_bsn from pii_bsn INSIDE the function body,
            # so the name must be patched on its defining module — patching it
            # on pii_mod would bind nothing and silently leave the carve-out on.
            stack.enter_context(
                patch.object(
                    bsn_mod, "detect_bsn", lambda text, enabled_categories=None: []
                )
            )
        if label_groups:
            stack.enter_context(pii_mod.use_label_groups(label_groups))
            # The token budget was computed at load() from the ORIGINAL groups.
            # Leaving it stale measures the wrong chunk count and the wrong
            # latency, so re-derive it with the same formula load() uses.
            if svc._tokenizer is not None:
                prompt = pii_mod._label_prompt_tokens(svc._tokenizer, label_groups)
                budget = max(64, svc._max_len - prompt - 16)
                stack.callback(
                    setattr, svc, "_text_token_budget", svc._text_token_budget
                )
                stack.callback(setattr, svc, "_overlap_tokens", svc._overlap_tokens)
                svc._text_token_budget = budget
                svc._overlap_tokens = min(budget // 2, max(48, budget * 15 // 100))
                meta["label_prompt_tokens"] = prompt

        meta["n_label_groups"] = len(label_groups or pii_mod._LABEL_GROUPS)
        meta["text_token_budget"] = svc._text_token_budget
        meta["overlap_tokens"] = svc._overlap_tokens

        preds, degraded, times = [], [], []
        observed: set[str] = set()
        for r in records:
            t0 = time.perf_counter()
            res = svc.detect(
                r.text, confidence_threshold=threshold, enabled_categories=None
            )
            times.append((time.perf_counter() - t0) * 1000.0)
            preds.append(_to_spans(res.get("entities", [])))
            degraded.append(bool(res.get("degraded")))
            # Skippable records return early without a tier_mode; only real
            # scans report one.
            if res.get("tier_mode") is not None:
                observed.add(str(res["tier_mode"]))

    # The service reports the mode it ACTUALLY ran in. Trusting the flag we
    # passed in is how this harness measured `on` for months while reporting
    # `gliner`. A harness that can silently measure a different configuration
    # than it reports is worse than no harness — so this is fatal, not a warning.
    meta["observed_tier_mode"] = sorted(observed)
    if observed and observed != {want_mode}:
        raise RuntimeError(
            f"tier mode mismatch: requested {want_mode!r} but the service "
            f"reported {sorted(observed)}. The measurement does not describe "
            f"the configuration it claims to."
        )

    meta["timing_ms"] = _timing_summary(times, records)
    return preds, degraded, meta


def _timing_summary(times: list[float], records: Sequence[Record]) -> dict:
    """Percentiles + sustained throughput. Percentiles via stdlib only."""
    if not times:
        return {}
    import statistics

    ordered = sorted(times)

    def pct(p: float) -> float:
        idx = min(len(ordered) - 1, int(round(p / 100 * (len(ordered) - 1))))
        return round(ordered[idx], 1)

    total_ms = sum(times)
    total_chars = sum(len(r.text) for r in records)
    return {
        "n": len(times),
        "p50": pct(50),
        "p90": pct(90),
        "p95": pct(95),
        "p99": pct(99),
        "max": round(ordered[-1], 1),
        "mean": round(statistics.fmean(times), 1),
        "total_ms": round(total_ms, 1),
        "chars_per_sec": round(total_chars / (total_ms / 1000.0), 1)
        if total_ms
        else 0.0,
        # A cache hit returns in ~0.3ms; real inference is 100ms+. A nonzero
        # count here means a stale Redis result is being benchmarked, not the
        # model. Only reachable via --endpoint, but reported everywhere so the
        # check is never silently skipped.
        "suspected_cache_hits": sum(1 for t in times if t < 5.0),
    }


def predict_endpoint(
    records: Sequence[Record], url: str, api_key: str | None, threshold: float
) -> tuple[list[list[SpanTuple]], list[bool], dict]:
    """POST every record to a live /pii endpoint.

    Returns (preds, degraded, meta) like predict_in_process, with wall-clock
    timing per request. Endpoint runs used to return NO timing at all, so
    `suspected_cache_hits` — written specifically for this mode, where a Redis
    hit can masquerade as inference — could never fire. Wall clock includes
    the network hop; comparisons against in-process numbers must say so.
    """
    import time
    import urllib.request

    preds, degraded, times = [], [], []
    observed: set[str] = set()
    for r in records:
        body = json.dumps(
            {
                "text": r.text,
                "confidence_threshold": threshold,
                "enabled_categories": None,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST", headers={"Content-Type": "application/json"}
        )
        if api_key:
            req.add_header("X-API-Key", api_key)
        t0 = time.perf_counter()
        # 300s: sized for candidate shims (a torch-fp32 GLiNER2 measured
        # ~15s per 5k-char record on 3 cores), not for the guard itself,
        # which answers in seconds. A hung endpoint still fails the run.
        with urllib.request.urlopen(req, timeout=300) as resp:
            res = json.loads(resp.read().decode("utf-8"))
        times.append((time.perf_counter() - t0) * 1000.0)
        preds.append(_to_spans(res.get("entities", [])))
        degraded.append(bool(res.get("degraded")))
        if res.get("tier_mode") is not None:
            observed.add(str(res["tier_mode"]))
    meta = {
        "endpoint": url,
        "observed_tier_mode": sorted(observed),
        "timing_ms": _timing_summary(times, records),
        "timing_includes_network": True,
    }
    return preds, degraded, meta


# ── Gate ────────────────────────────────────────────────────────────────────

# Gate tolerances. Deliberately NOT one --tol for everything: these answer
# different questions and a leak deserves a tighter bound than a mislabel.
_TOL_REDACTION = 0.01  # safety — characters actually removed
_TOL_CONTROL = 0.03  # control-group drift, BIDIRECTIONAL
_TOL_BOUNDARY = 0.05  # boundary exactness on structured categories
# Below this many gold spans a single span moves recall >3pp, which is wider
# than any tolerance here. Gating such a category measures sampling noise, so
# it is skipped — LOUDLY, because a silently ungated category is how a
# regression ships.
_MIN_GOLD_TO_GATE = 30


def gate(report: dict, baseline: dict, tol: float, gate_tier: str) -> list[str]:  # noqa: C901, PLR0912, PLR0915
    """Return a list of regression failures (empty == pass).

    This gate used to check micro-F1, HIGH_RISK recall and degraded_rate only.
    A detector that flagged every character in the document passed it: recall
    1.0, F1 respectable, nothing degraded. Under model-only that is not a
    hypothetical — the Node side defaults to fail_closed with action=block
    (server/core/piiDetection.js), so an over-redacting model is a user-facing
    outage that CI would wave through. Precision and over-redaction are gated
    here for that reason, and the leak metrics (computed since the harness was
    written, never checked) are gated harder than the quality metrics.
    """
    # A report and its baseline must describe the SAME corpus. The hybrid
    # baseline sat stale for weeks after a corpus fix — every delta computed
    # against it compared two different corpora, and nothing noticed until a
    # human diffed the locks by hand. A mismatch invalidates every row below,
    # so it fails before any metric is read.
    cur_lock = (report.get("meta") or {}).get("corpus_lock")
    base_lock = (baseline.get("meta") or {}).get("corpus_lock")
    if not base_lock:
        return [
            "baseline has no meta.corpus_lock — it predates the lock, so "
            "nothing proves it scored this corpus; regenerate it before "
            "gating against it"
        ]
    if cur_lock != base_lock:
        return [
            f"corpus_lock mismatch — the baseline scored a DIFFERENT corpus "
            f"(report {cur_lock} vs baseline {base_lock}); regenerate the "
            f"baseline on the current corpus before trusting any delta"
        ]

    # SAME SPLIT, SAME TIER. The lock above cannot catch this: dev and held-out
    # are subsets of ONE locked corpus, so they share a lock while scoring
    # different records. Gating `--split dev` against the held-out baseline
    # produced eight confident, entirely spurious regression rows — including
    # redaction_recall through its floor — and cost a wrong diagnosis and a code
    # change made for a reason that did not exist (2026-08-01, MODEL-DECISIONS).
    # Tier likewise: an `off` baseline versus a `hybrid` run compares two
    # detectors and calls the difference a regression.
    cur_meta, base_meta = report.get("meta") or {}, baseline.get("meta") or {}
    for field in ("split", "tier"):
        cur_v, base_v = cur_meta.get(field), base_meta.get(field)
        if cur_v is not None and base_v is not None and cur_v != base_v:
            return [
                f"{field} mismatch — this run is {field}={cur_v!r} but the "
                f"baseline is {field}={base_v!r}. Those are different "
                f"measurements; every delta below would be an artefact. "
                f"Gate against a baseline measured on {field}={cur_v!r}."
            ]

    failures: list[str] = []
    notes: list[str] = []
    scope = (
        report["overall"]
        if gate_tier == "all"
        else report.get("by_tier", {}).get(gate_tier, {})
    )
    base_scope = (
        baseline["overall"]
        if gate_tier == "all"
        else baseline.get("by_tier", {}).get(gate_tier, {})
    )
    if not scope or not base_scope:
        return [f"gate tier {gate_tier!r} missing in report or baseline"]

    df1 = base_scope["micro"]["f1"] - scope["micro"]["f1"]
    if df1 > tol:
        failures.append(
            f"micro F1 dropped {df1:.4f} (> {tol}) "
            f"[{base_scope['micro']['f1']} -> {scope['micro']['f1']}]"
        )

    # Micro precision: the missing half of F1. A recall gate alone rewards
    # over-flagging, and F1 can absorb a big precision loss behind a recall win.
    dp = base_scope["micro"]["precision"] - scope["micro"]["precision"]
    if dp > tol:
        failures.append(
            f"micro precision dropped {dp:.4f} (> {tol}) "
            f"[{base_scope['micro']['precision']} -> {scope['micro']['precision']}]"
        )

    base_cats = base_scope.get("per_category", {})
    cur_cats = scope.get("per_category", {})

    def _n_gold(cats: dict, cat: str) -> int:
        m = cats.get(cat) or {}
        return int(m.get("tp", 0)) + int(m.get("fn", 0))

    for cat in sorted(HIGH_RISK):
        if cat not in base_cats or cat not in cur_cats:
            continue
        n = _n_gold(base_cats, cat)
        if n < _MIN_GOLD_TO_GATE:
            notes.append(
                f"{cat}: only {n} gold spans — NOT GATED (one span = "
                f"{1 / n:.1%} recall; below every tolerance here)"
                if n
                else f"{cat}: no gold spans — NOT GATED"
            )
            continue
        dr = base_cats[cat]["recall"] - cur_cats[cat]["recall"]
        if dr > tol:
            failures.append(
                f"{cat} recall dropped {dr:.4f} (> {tol}) "
                f"[{base_cats[cat]['recall']} -> {cur_cats[cat]['recall']}]"
            )
        dcp = base_cats[cat]["precision"] - cur_cats[cat]["precision"]
        if dcp > tol:
            failures.append(
                f"{cat} precision dropped {dcp:.4f} (> {tol}) "
                f"[{base_cats[cat]['precision']} -> {cur_cats[cat]['precision']}]"
            )

    # ── Safety view (leak.py). Computed on every run since the harness was
    # written and never gated. redaction_recall is "did the characters actually
    # get removed" — the product truth, and tighter than label quality because
    # a mislabel is cosmetic while a partial cover is a live leak.
    cur_leak = (report.get("leak") or {}).get("overall") or {}
    base_leak = (baseline.get("leak") or {}).get("overall") or {}
    if cur_leak and base_leak:
        drr = base_leak.get("redaction_recall", 0) - cur_leak.get("redaction_recall", 0)
        if drr > _TOL_REDACTION:
            failures.append(
                f"redaction_recall dropped {drr:.4f} (> {_TOL_REDACTION}) "
                f"[{base_leak['redaction_recall']} -> {cur_leak['redaction_recall']}] "
                f"— gold characters that are no longer redacted"
            )
        dpl = cur_leak.get("partial_leak_rate", 0) - base_leak.get(
            "partial_leak_rate", 0
        )
        if dpl > _TOL_REDACTION:
            failures.append(
                f"partial_leak_rate rose {dpl:.4f} (> {_TOL_REDACTION}) "
                f"[{base_leak['partial_leak_rate']} -> {cur_leak['partial_leak_rate']}] "
                f"— spans covered but CLIPPED, which scores as a true positive"
            )
        dor = cur_leak.get("over_redaction_rate", 0) - base_leak.get(
            "over_redaction_rate", 0
        )
        if dor > _TOL_REDACTION:
            failures.append(
                f"over_redaction_rate rose {dor:.6f} (> {_TOL_REDACTION}) "
                f"[{base_leak['over_redaction_rate']} -> {cur_leak['over_redaction_rate']}] "
                f"— characters redacted that are not PII; with action=block "
                f"this is a user-facing outage"
            )
    elif base_leak:
        notes.append(
            "baseline has leak metrics but this report does not — safety view NOT GATED"
        )

    # ── Boundary fidelity on STRUCTURED categories. A span clipped by one
    # character leaves a digit of the IBAN in the prompt, and `overlap` mode
    # scores it as a clean true positive.
    cur_cover = (report.get("mode_micro") or {}).get("cover") or {}
    base_cover = (baseline.get("mode_micro") or {}).get("cover") or {}
    if cur_cover and base_cover:
        dc = base_cover.get("recall", 0) - cur_cover.get("recall", 0)
        if dc > _TOL_BOUNDARY:
            failures.append(
                f"cover-mode recall dropped {dc:.4f} (> {_TOL_BOUNDARY}) "
                f"[{base_cover['recall']} -> {cur_cover['recall']}] "
                f"— gold spans no longer FULLY contained by a prediction"
            )

    # ── Control group: categories nothing was supposed to touch. Checked in
    # BOTH directions — an unexplained IMPROVEMENT means the chunking moved
    # underneath the experiment, and then no other row is trustworthy.
    cur_cg = (report.get("control_group") or {}).get("micro") or {}
    base_cg = (baseline.get("control_group") or {}).get("micro") or {}
    if cur_cg and base_cg:
        dcg = abs(base_cg.get("f1", 0) - cur_cg.get("f1", 0))
        if dcg > _TOL_CONTROL:
            failures.append(
                f"CONTROL GROUP moved {dcg:.4f} (> {_TOL_CONTROL}, bidirectional) "
                f"[{base_cg['f1']} -> {cur_cg['f1']}] — these categories were not "
                f"supposed to change; explain this before trusting any other row"
            )

    if report.get("degraded_rate", 0) > 0:
        failures.append(
            f"degraded_rate is {report['degraded_rate']} (expected 0 with model loaded)"
        )

    for n in notes:
        print(f"  GATE NOTE: {n}", file=sys.stderr)
    return failures


def main() -> int:  # noqa: C901, PLR0912, PLR0915
    ap = argparse.ArgumentParser(description="Run the PII detection eval.")
    ap.add_argument(
        "--regex-only", action="store_true", help="model-free regex tier only"
    )
    ap.add_argument(
        "--regions",
        default=None,
        help="comma-separated ISO 3166-1 alpha-2 codes restricting "
        "country-specific patterns (default: all). `--regions NL` "
        "reproduces the pre-region behaviour for comparison.",
    )
    ap.add_argument("--endpoint", help="POST to a guard /pii URL instead of in-process")
    ap.add_argument("--api-key", default=os.environ.get("SERVICES_API_KEY"))
    ap.add_argument("--threshold", type=float, default=0.7)
    ap.add_argument("--mode", choices=["overlap", "strict", "cover"], default="overlap")
    ap.add_argument("--iou", type=float, default=0.5)
    ap.add_argument(
        "--tier",
        choices=["hybrid", "regex", "off", "gliner"],
        default=None,
        help="detection tier to measure. 'off' flips the real "
        "GUARD_PII_REGEX_TIER switch in-process, so the shipped "
        "cutover configuration is measurable BEFORE it ships. "
        "'gliner' is the old spelling of 'off'.",
    )
    ap.add_argument(
        "--bsn",
        choices=["on", "off"],
        default="on",
        help="with --tier off, whether the BSN elfproef carve-out "
        "runs. 'off' measures pure model-only: no arithmetic "
        "anywhere. The delta is the price of the strict rule.",
    )
    ap.add_argument(
        "--label-groups",
        help="JSON file: list of lists of GLiNER labels, overriding _LABEL_GROUPS",
    )
    ap.add_argument(
        "--thresholds",
        help="JSON file: {category: floor} overriding "
        "_PER_CATEGORY_THRESHOLD. Use it to "
        "validate a candidate calibration on "
        "--split dev before committing it.",
    )
    # Timing is ALWAYS collected by predict_in_process and written to
    # report["meta"]["timing_ms"]; this only echoes it to stdout, where a
    # before/after comparison is actually readable.
    ap.add_argument(
        "--timing",
        action="store_true",
        help="print the latency summary (p50/p90/p95/p99, chars/sec)",
    )
    ap.add_argument(
        "--split", choices=["all", "calibrate", "dev", "held-out"], default="all"
    )
    ap.add_argument("--subset", choices=["ci"], default=None)
    ap.add_argument(
        "--out", default=os.path.join(os.path.dirname(__file__), "metrics.json")
    )
    ap.add_argument("--baseline", help="baseline metrics.json to gate against")
    ap.add_argument("--tol", type=float, default=0.02, help="max allowed regression")
    ap.add_argument(
        "--gate-tier",
        choices=["all", "regex", "gliner"],
        default="all",
        help="which by_tier scope to gate on. Use 'all' for a "
        "--tier off run: under model-only there is no second "
        "tier to scope to.",
    )
    args = ap.parse_args()

    records = load_corpus(split=args.split, subset=args.subset)
    if not records:
        print(
            "no corpus records found — run `python -m eval.generate_corpus` first",
            file=sys.stderr,
        )
        return 2

    # --regex-only is the historical spelling of --tier regex; keep it working.
    # --tier gliner is the historical spelling of --tier off.
    tier = args.tier or ("regex" if args.regex_only else "hybrid")
    if tier == "gliner":
        tier = "off"
    if args.bsn == "off" and tier != "off":
        print(
            "--bsn off is only meaningful with --tier off (in hybrid the regex "
            "tier emits BSNs regardless)",
            file=sys.stderr,
        )
        return 2
    label_groups = None
    if args.label_groups:
        with open(args.label_groups, encoding="utf-8") as fh:
            label_groups = json.load(fh)
    thresholds = None
    if args.thresholds:
        with open(args.thresholds, encoding="utf-8") as fh:
            raw = json.load(fh)
        # calibrate.py writes {"proposals": {cat: {"proposed_floor": ...}}};
        # accept that shape as well as a plain {cat: floor} mapping.
        if "proposals" in raw:
            raw = {
                c: p["proposed_floor"]
                for c, p in raw["proposals"].items()
                if p.get("proposed_floor") is not None
            }
        thresholds = {k: float(v) for k, v in raw.items()}

    run_meta: dict = {}
    if tier == "regex":
        _regions = (
            [r.strip() for r in args.regions.split(",") if r.strip()]
            if args.regions
            else None
        )
        preds, degraded = predict_regex_only(records, regions=_regions)
        gate_tier = "regex"
    elif args.endpoint:
        preds, degraded, run_meta = predict_endpoint(
            records, args.endpoint, args.api_key, args.threshold
        )
        gate_tier = args.gate_tier
    else:
        preds, degraded, run_meta = predict_in_process(
            records,
            args.threshold,
            tier=tier,
            label_groups=label_groups,
            bsn=(args.bsn == "on"),
            thresholds=thresholds,
        )
        gate_tier = args.gate_tier

    report = evaluate(
        records,
        preds,
        regex_categories=WAS_REGEX,
        mode=args.mode,
        iou_threshold=args.iou,
        degraded_flags=degraded,
        class_maps=CLASS_MAPS,
        control_group=CONTROL_GROUP,
    )
    report["meta"] = {
        "split": args.split,
        "subset": args.subset,
        "threshold": args.threshold,
        "tier": tier,
        "backend": "regex-only"
        if tier == "regex"
        else ("endpoint" if args.endpoint else "in-process"),
        "corpus_files": list(_CORPUS_FILES),
        "corpus_lock": _corpus_lock_digest(),
        "regions": args.regions or "*",
        **run_meta,
    }
    # All three match modes in every run. They answer different questions and
    # reporting one alone is how a partial-redaction leak stays invisible:
    #   overlap  did we find it?          (IoU >= 0.5 — the primary quality view)
    #   strict   did we find it exactly?  (boundary fidelity)
    #   cover    did we fully redact it?  (the prediction contains the gold span)
    report["mode_micro"] = {
        m: evaluate(
            records, preds, regex_categories=WAS_REGEX, mode=m, degraded_flags=degraded
        )["overall"]["micro"]
        for m in ("overlap", "strict", "cover")
    }
    report["strict_micro"] = report["mode_micro"]["strict"]  # back-compat

    # Coverage-based safety view: redaction_recall vs label_recall.
    report["leak"] = evaluate_leak(records, preds)

    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print(format_summary(report))
    t = report.get("meta", {}).get("timing_ms") or {}
    if args.timing and t:
        n_groups = report["meta"].get("n_label_groups", "?")
        print(f"\ntiming ({t.get('n', 0)} records, {n_groups} label groups)")
        print(
            f"  p50={t.get('p50')}ms  p90={t.get('p90')}ms  "
            f"p95={t.get('p95')}ms  p99={t.get('p99')}ms  max={t.get('max')}ms"
        )
        print(
            f"  total={t.get('total_ms')}ms  "
            f"throughput={t.get('chars_per_sec', 0):,.0f} chars/sec"
        )
        if t.get("suspected_cache_hits"):
            print(
                f"  !! {t['suspected_cache_hits']} record(s) returned in <5ms - "
                f"likely served from the Redis cache, not measured inference"
            )
    print(f"\nwrote {args.out}")

    if args.baseline:
        with open(args.baseline, encoding="utf-8") as fh:
            baseline = json.load(fh)
        failures = gate(report, baseline, args.tol, gate_tier)
        if failures:
            print("\nGATE: FAIL", file=sys.stderr)
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            return 1
        print("\nGATE: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
