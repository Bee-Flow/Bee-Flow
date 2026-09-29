#!/usr/bin/env python3
"""Measure the cost of ONE GLiNER forward pass, and what batching rows does to it.

WHY THIS EXISTS
---------------
A scan costs `chunks x label-buckets` forward passes. Until this script existed,
the only visible number was end-to-end `ms` from the `pii.scan` line, which
bundles chunking, the regex tier, validators, `_finalise` AND queueing. So
"the model got faster" and "the queue got shorter" were indistinguishable, and
every tuning decision was a guess.

This measures the pass itself, at the batch widths the label-group bucketing
actually produces.

THE MEASUREMENT THAT MATTERS
----------------------------
`ms_per_row` at width 1 versus width N. Batching only pays when one sequence
does NOT already saturate the CPU quota. Measured 2026-07-31 at `cpus: 3`, two
label groups cost 906 ms sequentially and 992 ms as one 2-row call — batching
was a small LOSS. That is why `_MODEL_BATCH_SIZE` is 1 and why raising the
quota comes before any batching work. Re-run this after any change to
`GUARD_CPUS` / `GUARD_PII_ORT_INTRA_OP_THREADS`; the answer is a function of
core count, not a universal truth.

RAGGED BATCHES ARE NOT MEASURED
-------------------------------
Under gliner 0.2.28, rows with different label COUNTS raised `KeyError: 4`
(a (3,5) batch). 0.2.29 fixed that — re-checked 2026-09-26, bit-identical to
sequential calls — so ragged widths are now possible, just not measured here.
Batching was rejected on speed, not correctness (see `_MODEL_BATCH_SIZE`).

Usage (from the repo root, against the running container):
    Get-Content guard-service/scripts/bench_passes.py | docker exec -i beeflow-guard python -
    docker exec beeflow-guard python /app/scripts/bench_passes.py --reps 9 --widths 1,2,3
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import warnings

warnings.filterwarnings("ignore", category=FutureWarning)

# A realistic Dutch chunk. Sized to fill the ~348-token text budget so the
# measurement reflects a FULL chunk, which is what a document scan is made of —
# benchmarking a short sentence measures per-call overhead, not the model.
_PARA = (
    "Theodorus van der Brug (10:14): We hebben de storing bij Dekker Techniek gisteren "
    "opgelost, maar de melding staat nog open bij Beheer IT. Tom Smit heeft de "
    "klant gebeld op 0612345678 en doorgegeven dat de factuur met IBAN "
    "NL91ABNA0417164301 al voldaan is. Sjoerd van Veldhuijzen (10:16): Ik zie in "
    "het ticket dat de monteur pas om 14:30 ter plaatse kon zijn, dus we moeten de "
    "SLA-rapportage aanpassen voordat die naar de directie gaat. "
)

_LABEL_POOL = [
    ["person", "organization", "address"],
    ["passport number", "driver's license number", "social security number"],
    ["IBAN", "iban", "credit card number"],
    ["email address", "phone number", "url", "ip address"],
    [
        "medical condition",
        "medication",
        "health insurance id number",
        "health insurance number",
        "national health insurance number",
    ],
    [
        "burgerservicenummer",
        "citizen service number",
        "national id number",
        "identity card number",
        "identity document number",
    ],
    [
        "date of birth",
        "license plate number",
        "tax identification number",
        "bank account number",
        "api key",
    ],
]


def _build_text(tokenizer, target_tokens: int) -> str:
    text = _PARA
    while True:
        n = len(tokenizer(text, add_special_tokens=False)["input_ids"])
        if n >= target_tokens:
            return text
        text += _PARA


def main() -> int:  # noqa: C901, PLR0915
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=7, help="timed repetitions per width")
    ap.add_argument(
        "--widths",
        default="1,2,3,4",
        help="comma-separated batch widths (rows per call)",
    )
    ap.add_argument(
        "--label-count",
        type=int,
        default=3,
        help="labels per row; all rows MUST have the same count",
    )
    ap.add_argument(
        "--tokens", type=int, default=348, help="target chunk length in tokens"
    )
    ap.add_argument(
        "--threads",
        type=int,
        default=0,
        help="ORT intra_op_num_threads; 0 = the cgroup quota (what the service uses)",
    )
    ap.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="worker threads issuing passes CONCURRENTLY against one session. "
        ">1 installs a thread-local tokenizer (see _ThreadLocalTokenizer)",
    )
    ap.add_argument("--json", action="store_true", help="emit machine-readable results")
    args = ap.parse_args()

    import onnxruntime as ort
    from gliner import GLiNER

    onnx_dir = os.environ.get("GUARD_PII_ONNX_DIR", "/opt/gliner-onnx")
    onnx_file = os.environ.get("GUARD_PII_ONNX_FILE", "model.onnx")

    # Reproduce the service's session EXACTLY. Loading with gliner's defaults
    # instead lets ORT size its pool from the visible core count — which inside a
    # cgroup-limited container is the HOST's core count, not the quota. That
    # oversubscription is itself a large slowdown, so a bench that skips this
    # measures the wrong machine.
    # Run as a file (`python /app/scripts/bench_passes.py`), sys.path[0] is
    # scripts/, so `app` is not importable and the fallback below silently sized
    # ORT for the HOST's cores: 32 threads in an 8-core quota, 7x slower passes
    # (measured 2026-09-26). Put the service root on the path first.
    if "__file__" in globals():
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        from app.cpu import available_cpus  # type: ignore

        quota = available_cpus()
    except Exception:  # noqa: BLE001 — bench must work outside the app package
        quota = os.cpu_count() or 1
    threads = args.threads if args.threads > 0 else quota

    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = threads
    session_options.inter_op_num_threads = 1
    session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    t0 = time.perf_counter()
    # Same load as the service (app/services/pii/model_loading.py). No
    # low_cpu_mem_usage: gliner 0.2.29 rejects it for an ONNX runtime.
    model = GLiNER.from_pretrained(
        onnx_dir,
        runtime="onnxruntime",
        runtime_model_file=onnx_file,
        runtime_options={
            "session_options": session_options,
            "providers": ["CPUExecutionProvider"],
        },
        load_tokenizer=True,
        local_files_only=True,
    )
    load_s = time.perf_counter() - t0

    tokenizer = model.data_processor.transformer_tokenizer
    text = _build_text(tokenizer, args.tokens)
    n_tokens = len(tokenizer(text, add_special_tokens=False)["input_ids"])

    pool = [g for g in _LABEL_POOL if len(g) == args.label_count]
    if not pool:
        raise SystemExit(f"no label group of width {args.label_count} in the pool")

    env = {
        "os_cpu_count": os.cpu_count(),  # the HOST's cores — not the quota
        "cgroup_quota": quota,
        "ort_intra_op": threads,
        "concurrency": args.concurrency,
        "omp": os.environ.get("OMP_NUM_THREADS", "(unset)"),
        "load_s": round(load_s, 1),
        "chunk_tokens": n_tokens,
        "chunk_chars": len(text),
    }
    print(f"env: {env}")

    if args.concurrency > 1:
        # Concurrent passes need a per-thread tokenizer: transformers'
        # _set_truncation_and_padding MUTATES the Rust backend on every call that
        # passes padding=/truncation= (and gliner's processor passes both), so two
        # threads inside it raise "Already borrowed". ORT's Run() itself is
        # thread-safe on the CPU EP; the tokenizer is the only thing that is not.
        import threading

        from transformers import AutoTokenizer

        class _ThreadLocalTokenizer:
            def __init__(self, factory):
                self._factory = factory
                self._local = threading.local()
                self._prototype = factory()

            @property
            def _tok(self):
                tok = getattr(self._local, "tok", None)
                if tok is None:
                    tok = self._factory()
                    self._local.tok = tok
                return tok

            def __call__(self, *a, **kw):
                return self._tok(*a, **kw)

            def __len__(self):
                return len(self._prototype)

            def __getattr__(self, name):
                return getattr(self._tok, name)

        model.data_processor.transformer_tokenizer = _ThreadLocalTokenizer(
            lambda: AutoTokenizer.from_pretrained(onnx_dir)
        )

    # Warm-up: the first call pays lazy graph init and arena growth, and it is
    # large enough (measured ~10x the steady state) to swamp a small sample.
    # Never let it into the statistics.
    model.inference([text], pool[0], threshold=0.10, batch_size=1, flat_ner=True)

    def _one_pass(width):
        labels = [pool[i % len(pool)] for i in range(width)]
        model.inference(
            [text] * width, labels, threshold=0.10, batch_size=width, flat_ner=True
        )

    results = []
    for width in [int(w) for w in args.widths.split(",") if w.strip()]:
        samples = []
        if args.concurrency > 1:
            # Wall-clock for C passes issued at once, reported as time-per-pass:
            # that is the number a document scan actually experiences, because a
            # scan is a queue of independent (chunk, label-group) passes.
            import concurrent.futures as cf

            with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool_exec:
                for _ in range(args.reps):
                    t = time.perf_counter()
                    list(pool_exec.map(_one_pass, [width] * args.concurrency))
                    samples.append((time.perf_counter() - t) * 1000 / args.concurrency)
        else:
            for _ in range(args.reps):
                t = time.perf_counter()
                _one_pass(width)
                samples.append((time.perf_counter() - t) * 1000)
        samples.sort()
        p50 = statistics.median(samples)
        # Small samples: index-based p95 is honest about being the near-worst
        # observation rather than pretending to an interpolated quantile.
        p95 = samples[min(len(samples) - 1, int(round(0.95 * (len(samples) - 1))))]
        row = {
            "width": width,
            "p50_ms": round(p50, 1),
            "p95_ms": round(p95, 1),
            "min_ms": round(samples[0], 1),
            "ms_per_row_p50": round(p50 / width, 1),
        }
        results.append(row)
        print(
            f"  width={width:2d}  p50={row['p50_ms']:8.1f} ms  p95={row['p95_ms']:8.1f} ms"
            f"  -> {row['ms_per_row_p50']:7.1f} ms/row"
        )

    if results:
        base = results[0]["ms_per_row_p50"]
        print("\nspeedup per row vs width=1:")
        for r in results:
            print(f"  width={r['width']:2d}  {base / r['ms_per_row_p50']:.2f}x")

    if args.json:
        print(json.dumps({"env": env, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
