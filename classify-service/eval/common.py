"""Shared by run_eval.py and bench.py: adapters, corpus, truncation, provenance."""

from __future__ import annotations

import datetime as dt
import importlib
import json
import os
import platform
import time
from importlib import metadata

from adapters import ADAPTERS

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
RESULTS = os.path.join(HERE, "results")

HEAD_TOKENS = 512  # the headline cap: the first 512 tokens of the text
TAIL_TOKENS = 128  # head+tail keeps 384 from the start and 128 from the end
GAP = "\n…\n"


def set_threads(n: int) -> None:
    import torch

    torch.set_num_threads(n)


def load_adapter(name: str):
    """Import and load one adapter. Returns (module, provenance, load seconds)."""
    module_name, opts = ADAPTERS[name]
    module = importlib.import_module(module_name)
    t0 = time.perf_counter()
    info = module.load(**opts)
    return module, info, round(time.perf_counter() - t0, 2)


def load_corpus(split: str) -> list[dict]:
    with open(os.path.join(CORPUS, f"items.{split}.jsonl"), encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_labelsets() -> dict:
    with open(os.path.join(CORPUS, "labelsets.json"), encoding="utf-8") as fh:
        raw = json.load(fh)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def token_offsets(tok, text: str) -> list[tuple[int, int]]:
    return tok(text, add_special_tokens=False, return_offsets_mapping=True)[
        "offset_mapping"
    ]


def cap_text(
    tok, text: str, mode: str, head: int = HEAD_TOKENS, tail: int = TAIL_TOKENS
) -> str:
    """Cut `text` to a token budget of the model's own tokenizer, at token edges.

    head       the first `head` tokens
    head_tail  the first `head - tail` tokens, a gap marker, the last `tail`
    full       unchanged (the model's own limit applies)
    """
    if mode == "full":
        return text
    offsets = token_offsets(tok, text)
    if len(offsets) <= head:
        return text
    if mode == "head":
        return text[: offsets[head - 1][1]]
    if mode == "head_tail":
        return (
            text[: offsets[head - tail - 1][1]]
            + GAP
            + text[offsets[len(offsets) - tail][0] :]
        )
    raise ValueError(f"unknown truncation mode {mode!r}")


def proc_status_kb(field: str) -> int | None:
    """A field of /proc/self/status in kB: VmHWM is the peak resident set."""
    try:
        with open("/proc/self/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith(field + ":"):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def _cpu_model() -> str | None:
    try:
        with open("/proc/cpuinfo", encoding="ascii", errors="replace") as fh:
            for line in fh:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None


def _cgroup_cpu_quota() -> str | None:
    """`cpu.max` of the container: "300000 100000" is --cpus 3."""
    try:
        with open("/sys/fs/cgroup/cpu.max", encoding="ascii") as fh:
            return fh.read().strip()
    except OSError:
        return None


def _cgroup_memory_max() -> str | None:
    try:
        with open("/sys/fs/cgroup/memory.max", encoding="ascii") as fh:
            return fh.read().strip()
    except OSError:
        return None


PACKAGES = (
    "torch",
    "transformers",
    "tokenizers",
    "huggingface_hub",
    "numpy",
    "gliclass",
    "gliner2",
    "protobuf",
)


def env_info() -> dict:
    import torch

    versions = {}
    for pkg in PACKAGES:
        try:
            versions[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            continue
    return {
        "date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "python": platform.python_version(),
        "packages": versions,
        "cpu_model": _cpu_model(),
        "os_cpu_count": os.cpu_count(),
        "affinity_cpus": len(os.sched_getaffinity(0)),
        "cgroup_cpu_max": _cgroup_cpu_quota(),
        "cgroup_memory_max": _cgroup_memory_max(),
        "torch_threads": torch.get_num_threads(),
        "cuda_available": torch.cuda.is_available(),
    }


def write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
