"""The GLiClass model behind POST /classify.

torch, transformers and gliclass are imported inside ``load()``, never at
module import, so the router, the contract and the tests run without them.

What the adapter is written against (gliclass 0.1.20, ``gliclass/pipeline.py``,
``BaseZeroShotClassificationPipeline.__call__`` and ``_postprocess_logits``)::

    pipeline(texts: list[str], labels: list[str], threshold=t,
             classification_type="multi-label")
    -> [[{"label": str, "score": float}, ...], ...]    # one list per text, in order

In multi-label mode each score is ``sigmoid(logit)`` for that label on its own,
and a label is listed only when its score is ``>= t``. Called with ``t=0`` every
label is listed, in label order. The pipeline builds the model input as
``<<LABEL>>a<<LABEL>>b<<SEP>>text`` (the model's ``prompt_first``). ``cap()``
cuts every text to ``max_tokens`` tokens (its start and its end) before that,
and ``max_length`` leaves room for the labels on top, so the model never cuts.

PRIVACY: nothing in this module logs a text, a label or a score. Load errors
are logged in full; they happen before any text has arrived.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.cpu import available_cpus
from app.models import RESERVED_MARKERS

logger = logging.getLogger("classify.model")

BACKEND = "torch-cpu"
# Texts per forward pass inside the pipeline (padding is to the longest text
# in a batch, so a bigger batch pays for its longest member more often).
# 4, not 8: at 8 long texts peaked at 2,636 MB, at 4 at 2,212 MB, and the
# container limit (3 GB) is sized for 4 (eval/MODEL-DECISIONS.md, owner
# decision 2026-09-26).
_BATCH_SIZE = 4
# Long texts keep their start and their end: the last _TAIL_TOKENS tokens,
# after a visible gap, so a cancellation in the closing line still counts.
_TAIL_TOKENS = 128
_GAP = "\n…\n"
# A tiny classification right after load, so the first real request does not
# pay the allocator's first growth. Our own words, never a caller's.
_WARM_TEXT = "NASA launched a new rover to Mars."
_WARM_LABELS = ["space", "sports"]


@dataclass(frozen=True)
class Scored:
    """One text's answer: every label's score, and whether the model saw it all."""

    scores: dict[str, float]
    truncated: bool


def scrub(text: str) -> str:
    """Remove the prompt markers from a text so it cannot add or end labels."""
    for marker in RESERVED_MARKERS:
        text = text.replace(marker, " ")
    return text


def scores_from(row: list[dict[str, Any]], labels: list[str]) -> dict[str, float]:
    """One pipeline row -> {label: score} in request order.

    A label with no score is an error, not a zero: a sigmoid that came out NaN
    fails the pipeline's ``>= 0`` test and drops out of the row, and reporting
    it as 0.0 would send the item down "otherwise" with a made-up number.
    """
    by_label = {str(item["label"]): float(item["score"]) for item in row}
    missing = sum(1 for label in labels if label not in by_label)
    if missing:
        raise ValueError(f"pipeline returned no score for {missing} label(s)")
    return {label: by_label[label] for label in labels}


def read_baked(cfg: Settings) -> tuple[str, str]:
    """(model id, revision) from BAKED.json, else the configured values."""
    try:
        data = json.loads((Path(cfg.model_dir) / "BAKED.json").read_text())
        return str(data["model"]), str(data["revision"])
    except (OSError, ValueError, KeyError, TypeError):
        return cfg.model, cfg.model_revision


def engine_fingerprint(svc: Any, cfg: Settings) -> str:
    """Short identity of everything that decides a score.

    Readable part: model, revision, gliclass version. The digest covers the
    knobs that change scores without changing the model: label mode, the
    three length limits, dtype and the image build. A caller that caches scores
    keys on this string, so a flip of any of them must change it.
    """
    knobs = [
        cfg.label_mode,
        cfg.max_chars,
        cfg.max_tokens,
        cfg.max_length,
        cfg.dtype,
        cfg.build_id,
    ]
    digest = hashlib.sha256(json.dumps(knobs).encode()).hexdigest()[:8]
    name = str(svc.model_id).rsplit("/", 1)[-1]
    return f"{name}@{str(svc.revision)[:12]}/gliclass-{svc.package_version}/{digest}"


class ClassifierService:
    """Loads once, then scores. One model instance, used by one thread at a time."""

    def __init__(self, cfg: Settings) -> None:
        self.ready = False
        self.load_error: str | None = None
        self.model_id = cfg.model
        self.revision = cfg.model_revision
        self.package_version = "unknown"
        self._pipeline: Any = None
        self._tokenizer: Any = None
        self._max_tokens = cfg.max_tokens
        # Serialises every model and tokenizer touch. The admission gate
        # bounds how many requests are in flight, but a request whose client
        # went away releases its slot while its thread still runs; this lock
        # keeps the next one from sharing the Rust tokenizer with it, which
        # raises "Already borrowed" (guard-service found that the hard way).
        self._lock = threading.Lock()

    def load(self, cfg: Settings) -> bool:
        """Load the baked model. Records the error instead of raising."""
        if self.ready:
            return True
        try:
            self._load(cfg)
        except Exception as exc:  # surfaced via /health and /ready
            self.load_error = f"{type(exc).__name__}: {exc}"
            logger.error("[classify] model load failed: %s", self.load_error)
            return False
        self.load_error = None
        self.ready = True
        logger.info(
            "[classify] model ready: %s@%s gliclass=%s dtype=%s max_tokens=%d",
            self.model_id,
            self.revision,
            self.package_version,
            cfg.dtype,
            cfg.max_tokens,
        )
        return True

    def _load(self, cfg: Settings) -> None:
        import gliclass
        import torch
        from gliclass import GLiClassModel, ZeroShotClassificationPipeline
        from transformers import AutoTokenizer

        torch.set_num_threads(available_cpus())
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:  # settable once per process; a retried load lands here
            pass

        model_id, revision = read_baked(cfg)
        model = GLiClassModel.from_pretrained(
            cfg.model_dir, dtype=getattr(torch, cfg.dtype)
        )
        tokenizer = AutoTokenizer.from_pretrained(cfg.model_dir)
        pipeline = ZeroShotClassificationPipeline(
            model,
            tokenizer,
            # The whole sequence: label prompt + a text already cut to
            # max_tokens (cap()), so the model never cuts the text itself.
            max_length=cfg.max_length,
            classification_type="multi-label",
            device="cpu",
            progress_bar=False,
        )
        self._pipeline, self._tokenizer, self._max_tokens = (
            pipeline,
            tokenizer,
            cfg.max_tokens,
        )
        self._run([_WARM_TEXT], _WARM_LABELS)
        self.model_id, self.revision = model_id, revision
        self.package_version = getattr(gliclass, "__version__", "unknown")

    def classify(
        self, texts: list[str], labels: list[str], label_mode: str
    ) -> list[Scored]:
        """Score every text against every label. Blocking; call it off the event loop."""
        if not self.ready or self._pipeline is None:
            raise RuntimeError("model is not loaded")
        with self._lock:
            capped = [self.cap(scrub(text)) for text in texts]
            clean = [text for text, _ in capped]
            cut = [was_cut for _, was_cut in capped]
            if label_mode == "independent":
                return self._independent(clean, labels, cut)
            rows = self._run(clean, labels)
            return [Scored(row, c) for row, c in zip(rows, cut, strict=True)]

    def _independent(
        self, texts: list[str], labels: list[str], cut: list[bool]
    ) -> list[Scored]:
        # One pass per label, so a label's score cannot move with its company.
        columns = [self._run(texts, [label]) for label in labels]
        return [
            Scored(
                {label: columns[j][i][label] for j, label in enumerate(labels)},
                cut[i],
            )
            for i in range(len(texts))
        ]

    def _run(self, texts: list[str], labels: list[str]) -> list[dict[str, float]]:
        rows = self._pipeline(
            texts,
            labels,
            threshold=0.0,
            batch_size=_BATCH_SIZE,
            classification_type="multi-label",
        )
        if len(rows) != len(texts):
            raise ValueError(
                f"pipeline returned {len(rows)} rows for {len(texts)} texts"
            )
        return [scores_from(row, labels) for row in rows]

    def cap(self, text: str) -> tuple[str, bool]:
        """Cut a text to max_tokens tokens of the model's own tokenizer.

        Keeps the first ``max_tokens - _TAIL_TOKENS`` and the last
        ``_TAIL_TOKENS`` tokens with a gap marker between them, cut at token
        edges (eval/common.py ``cap_text``, mode ``head_tail``, which is what
        the thresholds were measured with). Returns (text, was_cut).
        """
        offsets = self._tokenizer(
            text, add_special_tokens=False, return_offsets_mapping=True
        )["offset_mapping"]
        if len(offsets) <= self._max_tokens:
            return text, False
        head = self._max_tokens - _TAIL_TOKENS
        return (
            text[: offsets[head - 1][1]] + _GAP + text[offsets[-_TAIL_TOKENS][0] :],
            True,
        )


_service: Any = None


def get_classifier() -> Any:
    """The process-wide classifier (a FakeClassifier under test)."""
    global _service
    if _service is None:
        from app.config import settings

        _service = ClassifierService(settings)
    return _service


def set_classifier(service: Any) -> None:
    """Swap the process-wide classifier. Tests only."""
    global _service
    _service = service
