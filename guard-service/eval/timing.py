"""Latency summaries for the eval runner (kept out of run_eval.py, which is at its line ceiling)."""

from __future__ import annotations

from collections.abc import Sequence

from .schema import Record


def timing_summary(times: list[float], records: Sequence[Record]) -> dict:
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


def merge_timing(parts: Sequence[dict]) -> dict:
    """Combine per-shard ``timing_summary`` dicts into one.

    Percentiles cannot be merged from summaries (the raw samples are gone), so
    they are left out rather than approximated; the shards ran concurrently,
    so ``total_ms`` is summed CPU-ish time, not wall clock. ``shards`` says
    the figure is a merge, so nobody compares it to a single run's p95.
    """
    parts = [p for p in parts if p]
    if not parts:
        return {}
    n = sum(p.get("n", 0) for p in parts)
    total_ms = sum(p.get("total_ms", 0.0) for p in parts)
    chars = sum(
        p.get("chars_per_sec", 0.0) * p.get("total_ms", 0.0) / 1000.0 for p in parts
    )
    return {
        "n": n,
        "max": max(p.get("max", 0.0) for p in parts),
        "mean": round(total_ms / n, 1) if n else 0.0,
        "total_ms": round(total_ms, 1),
        "chars_per_sec": round(chars / (total_ms / 1000.0), 1) if total_ms else 0.0,
        "suspected_cache_hits": sum(p.get("suspected_cache_hits", 0) for p in parts),
        "shards": len(parts),
    }


def print_timing(report: dict) -> None:
    t = report.get("meta", {}).get("timing_ms") or {}
    if not t:
        return
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
