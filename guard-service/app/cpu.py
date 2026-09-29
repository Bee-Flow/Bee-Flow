"""CPU/thread sizing that respects the container's cgroup CPU quota.

``os.cpu_count()`` reports the *node's* logical cores and ignores the
Kubernetes CPU limit. A k8s CPU limit is a CFS quota, not a cpuset, so
``os.sched_getaffinity()`` misses it too. On our Scaleway PRO2-S nodes
(8 cores) the guard pod is capped at 3 cores
(``limits.cpu: "3000m"`` in deploy/scaleway-kapsule — 06-guard-service),
so sizing ONNX Runtime / OpenMP / BLAS pools from ``os.cpu_count()`` spawns
8 threads inside a 3-core quota. The kernel then CFS-throttles the pod and
the surplus threads just thrash on context switches, hurting latency.

We size every thread pool to the quota instead. Outside a quota (local
dev, docker-compose without ``cpus:``) we fall back to the node count, so
behaviour is unchanged there.
"""

from __future__ import annotations

import os


def cgroup_quota_cores() -> int | None:
    """Whole-core CPU quota for this container, or None when unlimited.

    Reads the CFS quota the kubelet writes for the pod's CPU *limit*.
    Supports cgroup v2 (containerd on current Kapsule) and v1.
    """
    # cgroup v2 — "<quota> <period>" or "max <period>".
    try:
        with open("/sys/fs/cgroup/cpu.max") as fh:
            quota_s, period_s = fh.read().split()
        if quota_s != "max":
            quota, period = int(quota_s), int(period_s)
            if quota > 0 and period > 0:
                return max(1, round(quota / period))
    except (OSError, ValueError):
        pass

    # cgroup v1 fallback.
    try:
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as fh:
            quota = int(fh.read())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as fh:
            period = int(fh.read())
        if quota > 0 and period > 0:
            return max(1, round(quota / period))
    except (OSError, ValueError):
        pass

    return None


def available_cpus() -> int:
    """Cores this process may actually use: ``min(node cores, cgroup quota)``."""
    node = os.cpu_count() or 1
    quota = cgroup_quota_cores()
    return min(node, quota) if quota else node


# Env vars several numerical libraries read *once* at import time. Setting
# them before numpy / torch / onnxruntime are first imported is the only
# reliable way to size their BLAS pools — hence ``apply_thread_env()`` is
# called at the very top of app.main before anything heavy is imported.
_THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
)


def apply_thread_env() -> int:
    """Pin BLAS/OpenMP env vars to the cgroup quota. Returns the core count.

    Uses ``setdefault`` so an explicit value from the deployment manifest
    always wins. Call as early as possible in process start-up.
    """
    n = available_cpus()
    for var in _THREAD_ENV_VARS:
        os.environ.setdefault(var, str(n))
    return n
