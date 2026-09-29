"""
Structured logging and p95 latency tracking.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from typing import Generator
from urllib.parse import urlsplit

from app.config import settings

# ── Logger setup ─────────────────────────────────────────────────────


def setup_logging() -> None:
    """Configure structured logging for the entire application."""
    log_format = "%(asctime)s | %(levelname)-8s | %(name)-25s | %(message)s"
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format=log_format,
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    # Reduce noise from third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


logger = logging.getLogger("search")


def query_digest(text: str) -> str:
    """A short, stable stand-in for a query in a log line. The text itself is
    the user's — it never goes to the log; the digest still lets two lines
    about the same query be matched up."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def url_label(url: str) -> str:
    """Host plus a digest of the full URL: enough to see which site a fetch
    line is about without writing the page a person asked for into the log."""
    try:
        host = urlsplit(url).hostname or "?"
    except ValueError:
        host = "?"
    return f"{host} #{query_digest(url)}"


def redact_url(url: str) -> str:
    """A connection URL without its credentials — scheme, host, port, path."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<unparseable url>"
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port is not None else ""
    return f"{parts.scheme}://{host}{port}{parts.path}"


# ── Latency tracker ─────────────────────────────────────────────────


class LatencyTracker:
    """Collects per-stage latencies and computes p95."""

    _window_size = 1000  # rolling window per stage

    def __init__(self) -> None:
        self._samples: dict[str, deque[float]] = defaultdict(
            lambda: deque(maxlen=self._window_size)
        )

    @contextmanager
    def track(self, stage: str) -> Generator[None, None, None]:
        """Context manager that records elapsed time for *stage*."""
        t0 = time.perf_counter()
        try:
            yield
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            self._samples[stage].append(elapsed_ms)
            if elapsed_ms > 500:
                logger.warning("slow | stage=%s elapsed_ms=%.1f", stage, elapsed_ms)

    def p95(self, stage: str) -> float | None:
        """Return p95 latency in ms for the given stage, or None if no data."""
        samples = self._samples.get(stage)
        if not samples or len(samples) < 2:
            return None
        sorted_vals = sorted(samples)
        idx = int(len(sorted_vals) * 0.95)
        return sorted_vals[min(idx, len(sorted_vals) - 1)]

    def summary(self) -> dict[str, dict]:
        """Return p95 and count for all tracked stages."""
        result = {}
        for stage, samples in self._samples.items():
            p95 = self.p95(stage)
            result[stage] = {
                "count": len(samples),
                "p95_ms": round(p95, 2) if p95 is not None else None,
            }
        return result


# Singleton
latency = LatencyTracker()
