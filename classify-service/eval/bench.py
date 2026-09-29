"""CPU latency, throughput and memory for one candidate: results/<model>.bench.json.

    python bench.py --model gliclass

Run it the way production runs: in a container started with
`--cpus 3 --memory 4g`, and with torch limited to 3 threads (the default here).
The text is cut from the long dev emails to about 64, 256 and 512 tokens of the
model's own tokenizer, and scored against 6 labels:

  batch 1   p50/p95 latency per call, over --reps calls cycling 8 texts
  batch 8   p50/p95 per call over --batch-reps calls; texts/s = 8 / p50

Peak RSS is VmHWM from /proc/self/status: once after load, once after all runs.
The adoption rule reads the 512-token rows (MODEL-DECISIONS.md, rules 3 to 5).

    python bench.py --model gliclass --memory-sweep 1,2,4,8

writes results/<model>.memory.json: the peak RSS at 512 tokens for each batch
size, each in a FRESH process. VmHWM only ever rises within a process, so the
peak of a small batch cannot be read after a big one has run.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time

from common import (
    RESULTS,
    cap_text,
    env_info,
    load_adapter,
    load_corpus,
    load_labelsets,
    proc_status_kb,
    set_threads,
    token_offsets,
    write_json,
)

SIZES = (64, 256, 512)
N_TEXTS = 8
N_LABELS = 6


def percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile, so p95 of 30 runs is an observed run, not an interpolation."""
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * q // 100))
    return ordered[int(rank) - 1]


def timed(fn, reps: int) -> list[float]:
    out = []
    for i in range(reps):
        t0 = time.perf_counter()
        fn(i)
        out.append(time.perf_counter() - t0)
    return out


def summarise(latencies: list[float], batch: int) -> dict:
    p50 = statistics.median(latencies)
    return {
        "reps": len(latencies),
        "p50_s": round(p50, 4),
        "p95_s": round(percentile(latencies, 95), 4),
        "mean_s": round(statistics.fmean(latencies), 4),
        "min_s": round(min(latencies), 4),
        "max_s": round(max(latencies), 4),
        "texts_per_s": round(batch / p50, 3),
    }


def bench_texts(tok) -> dict[int, list[str]]:
    """8 different texts per size, cut from the longest dev emails (Dutch and English)."""
    emails = [i for i in load_corpus("dev") if i["kind"] == "email"]
    emails.sort(key=lambda i: -len(token_offsets(tok, i["text"])))
    sources = [i["text"] for i in emails[:N_TEXTS]]
    return {n: [cap_text(tok, t, "head", head=n) for t in sources] for n in SIZES}


def run_size(
    adapter, texts: list[str], labels: list[str], reps: int, batch_reps: int
) -> dict:
    tok = adapter.tokenizer()
    adapter.scores(texts[:1], labels)  # warm-up: first-call allocations
    adapter.scores(texts, labels)
    one = timed(lambda i: adapter.scores([texts[i % len(texts)]], labels), reps)
    eight = timed(lambda i: adapter.scores(texts, labels), batch_reps)
    return {
        "mean_tokens": round(
            statistics.fmean(len(token_offsets(tok, t)) for t in texts), 1
        ),
        "batch_1": summarise(one, 1),
        "batch_8": summarise(eight, N_TEXTS),
    }


def peak_child(args) -> None:
    """One fresh process: load, score --peak-batch texts of 512 tokens 3 times."""
    set_threads(args.threads)
    adapter, _, _ = load_adapter(args.model)
    hwm_load = proc_status_kb("VmHWM")
    labels = [e["en"] for e in load_labelsets()["email"]["labels"][:N_LABELS]]
    pool = bench_texts(adapter.tokenizer())[512]
    texts = [pool[i % len(pool)] for i in range(args.peak_batch)]
    for _ in range(3):
        adapter.scores(texts, labels)
    hwm = proc_status_kb("VmHWM")
    print(
        json.dumps(
            {
                "batch": args.peak_batch,
                "vmhwm_after_load_mb": round(hwm_load / 1024, 1),
                "peak_rss_mb": round(hwm / 1024, 1),
            }
        )
    )


def memory_sweep(args) -> None:
    rows = []
    for n in (int(x) for x in args.memory_sweep.split(",")):
        cmd = [sys.executable, os.path.abspath(__file__), "--model", args.model]
        cmd += ["--threads", str(args.threads), "--peak-batch", str(n)]
        done = subprocess.run(cmd, capture_output=True, text=True, check=True)
        rows.append(json.loads(done.stdout.strip().splitlines()[-1]))
        print(f"{args.model} batch {n}: peak RSS {rows[-1]['peak_rss_mb']} MB")
    out = {
        "model": args.model,
        "env": env_info(),
        "tokens": 512,
        "labels": N_LABELS,
        "by_batch": rows,
    }
    write_json(args.out or os.path.join(RESULTS, f"{args.model}.memory.json"), out)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--model",
        required=True,
        choices=["gliclass", "gliclass-edge", "gliner2", "nli"],
    )
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--reps", type=int, default=30)
    ap.add_argument("--batch-reps", type=int, default=10)
    ap.add_argument("--out", default=None)
    ap.add_argument("--memory-sweep", default=None, help="e.g. 1,2,4,8")
    ap.add_argument("--peak-batch", type=int, default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.peak_batch:
        peak_child(args)
    elif args.memory_sweep:
        memory_sweep(args)
    else:
        bench(args)


def bench(args) -> None:
    set_threads(args.threads)
    hwm_before = proc_status_kb("VmHWM")
    adapter, info, load_s = load_adapter(args.model)
    hwm_load = proc_status_kb("VmHWM")
    rss_load = proc_status_kb("VmRSS")

    labels = [e["en"] for e in load_labelsets()["email"]["labels"][:N_LABELS]]
    texts = bench_texts(adapter.tokenizer())
    sizes = {
        str(n): run_size(adapter, texts[n], labels, args.reps, args.batch_reps)
        for n in SIZES
    }
    hwm_after = proc_status_kb("VmHWM")

    at512 = sizes["512"]
    peak_mb = round(max(hwm_load, hwm_after) / 1024, 1)
    out = {
        "model": args.model,
        "provenance": info,
        "env": env_info(),
        "labels": labels,
        "load_seconds": load_s,
        "memory_mb": {
            "vmhwm_before_load": round(hwm_before / 1024, 1),
            "vmhwm_after_load": round(hwm_load / 1024, 1),
            "vmrss_after_load": round(rss_load / 1024, 1),
            "vmhwm_after_batches": round(hwm_after / 1024, 1),
            "peak_rss": peak_mb,
        },
        "sizes": sizes,
        "gates": {
            "p50_512_batch1_s": at512["batch_1"]["p50_s"],
            "p95_512_batch1_s": at512["batch_1"]["p95_s"],
            "texts_per_s_512_batch8": at512["batch_8"]["texts_per_s"],
            "peak_rss_mb": peak_mb,
        },
    }
    path = args.out or os.path.join(RESULTS, f"{args.model}.bench.json")
    write_json(path, out)
    g = out["gates"]
    print(
        f"{args.model} bench: load {load_s}s | 512 tok b1 p50 {g['p50_512_batch1_s']}s p95 {g['p95_512_batch1_s']}s"
        f" | b8 {g['texts_per_s_512_batch8']} texts/s | peak RSS {peak_mb} MB -> {path}"
    )


if __name__ == "__main__":
    main()
