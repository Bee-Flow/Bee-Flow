"""Thread sizing from the container's CPU quota, not the node's core count.

A Kubernetes CPU limit is a CFS quota. ``os.cpu_count()`` and
``os.sched_getaffinity()`` both ignore it, so a pod limited to 2 cores on an
8-core node would start 8 BLAS/OpenMP threads and be throttled for it. Same
approach as guard-service/app/cpu.py; each Python image has its own build
context, so the helper is restated here rather than imported.
"""

from __future__ import annotations

import os

_CGROUP_V2 = "/sys/fs/cgroup/cpu.max"
_CGROUP_V1 = (
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
    "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
)
# Read once, at first import, by numpy / torch; so they must be set first.
_THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
)


def _cores(quota: int, period: int) -> int | None:
    return max(1, round(quota / period)) if quota > 0 and period > 0 else None


def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read().strip()


def cgroup_quota_cores() -> int | None:
    """Whole cores the CFS quota allows (cgroup v2, then v1), or None if unlimited."""
    try:
        quota_s, period_s = _read(_CGROUP_V2).split()
        if quota_s != "max":
            return _cores(int(quota_s), int(period_s))
    except (OSError, ValueError):
        pass
    try:
        return _cores(int(_read(_CGROUP_V1[0])), int(_read(_CGROUP_V1[1])))
    except (OSError, ValueError):
        return None


def available_cpus() -> int:
    """``min(node cores, cgroup quota)``."""
    node = os.cpu_count() or 1
    quota = cgroup_quota_cores()
    return min(node, quota) if quota else node


def apply_thread_env() -> int:
    """Pin the BLAS/OpenMP env vars to the quota (an explicit value wins)."""
    n = available_cpus()
    for var in _THREAD_ENV_VARS:
        os.environ.setdefault(var, str(n))
    return n
