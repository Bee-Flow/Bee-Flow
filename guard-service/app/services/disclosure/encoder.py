"""The sentence encoder, and the fact that this image does not ship one.

READ THIS BEFORE WIRING ANYTHING TO IT. The default guard image contains no
disclosure encoder. ``load()`` looks for a model directory baked at
``GUARD_DISCLOSURE_MODEL_DIR`` and, finding nothing, records why and stays
un-ready — every classification then answers "no opinion" rather than
"no disclosure". That is not a degraded corner of this feature, it is its
default state, and the Node side is written for it: with no opinion coming
back, the Art. 50 check is exactly the regex it has always been.

The reason it is opt-in is size. This sidecar exists to run one CPU model, and
a multilingual sentence encoder is another ~470 MB in an image every
self-hosting customer pulls, for a classifier that assists a single compliance
check. So the encoder is baked by an operator who asks for it
(``scripts/export_disclosure_encoder.py``, the ``GUARD_DISCLOSURE_MODEL``
build arg in the Dockerfile) and the default build is unchanged.

NO NEW DEPENDENCY, deliberately. ``torch`` and ``transformers`` are already in
this image for GLiNER's fp32 fallback path, so the encoder is an
``AutoModel`` + mean pooling rather than a sentence-transformers install. The
imports are inside ``load()`` so a service without an encoder never pays them.

DETERMINISM IS A REQUIREMENT HERE, not a nicety — a compliance verdict that
moves between runs is worse than no verdict. ``eval()`` plus ``no_grad()``
plus a fixed anchor bank gives the same vector for the same sentence on every
call; nothing in this file samples, and there is no generation anywhere near
it.

THE GLINER MODEL IS NOT REUSED, and it was the first thing tried. It is loaded
as an ONNX graph whose inputs are (text x label prompt) and whose outputs are
span logits — there is no encoder output to pool. Reaching for the PyTorch
weights beside it instead would mean a second ~1.2 GB model resident in a pod
that is already the memory ceiling of the stack, to borrow an encoder that was
fine-tuned for span extraction rather than sentence similarity. An absent
optional encoder is a better trade than that.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger("guard.disclosure")


class SentenceEncoder:
    """A mean-pooled transformer encoder over a locally-baked model directory.

    ``ready`` is False until :meth:`load` succeeds; ``load_error`` says why,
    in the same shape ``PiiService`` uses so /health can surface both the same
    way.
    """

    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._torch = None
        self._ready = False
        self._load_error: str | None = None
        self._model_dir: str | None = None
        self._max_tokens = 128
        # One encoder instance, several request threads, and a Rust tokenizer
        # that raises "Already borrowed" when two of them are inside it — the
        # same trap app/services/pii/model_loading.py documents. This path is
        # low-volume (a compliance sweep, not chat), so it takes the simple
        # side of that trade: one lock, no per-thread tokenizers.
        self._lock = threading.Lock()

    # ── state ────────────────────────────────────────────────────────────
    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def model_dir(self) -> str | None:
        return self._model_dir

    def load(self, model_dir: str, max_tokens: int = 128) -> None:
        """Load the encoder from `model_dir`. Never raises — records instead.

        A missing directory is the expected case (see the module docstring),
        so it is an INFO with a reason, not an error: an operator who never
        asked for this feature must not find a stack trace in their logs.
        """
        with self._lock:
            if self._ready and self._model_dir == model_dir:
                return
            self._model_dir = model_dir
            self._max_tokens = max(16, int(max_tokens or 128))
            if not model_dir or not os.path.isdir(model_dir):
                self._model = self._tokenizer = None
                self._ready = False
                self._load_error = f"no encoder at {model_dir!r}"
                logger.info(
                    "[Disclosure] no encoder baked at %s — /disclosure will "
                    "answer 'no opinion' and the Art. 50 keyword rule stands "
                    "alone (this is the default image)",
                    model_dir,
                )
                return
            try:
                import torch
                from transformers import AutoModel, AutoTokenizer

                from app.cpu import apply_thread_env, available_cpus

                # Same cgroup-quota discipline as the PII model: os.cpu_count()
                # reports the node, not this pod's slice, and a thread pool
                # sized for the node thrashes inside the quota.
                apply_thread_env()
                try:
                    torch.set_num_threads(available_cpus())
                except Exception:  # pragma: no cover - torch build dependent
                    pass

                self._tokenizer = AutoTokenizer.from_pretrained(model_dir)
                model = AutoModel.from_pretrained(model_dir)
                model.eval()
                self._model = model
                self._torch = torch
                self._ready = True
                self._load_error = None
                logger.info("[Disclosure] sentence encoder ready (%s)", model_dir)
            except Exception as exc:
                self._model = self._tokenizer = None
                self._ready = False
                self._load_error = f"{type(exc).__name__}: {exc}"
                logger.error(
                    "[Disclosure] encoder at %s failed to load: %s",
                    model_dir,
                    exc,
                    exc_info=True,
                )

    # ── inference ────────────────────────────────────────────────────────
    def encode(self, texts: list[str]) -> list[list[float]]:
        """Sentences → L2-normalised mean-pooled vectors, in order.

        Padding tokens are excluded from the mean by the attention mask. Mean-
        pooling over the padding instead is the classic version of this bug: it
        makes a short sentence's vector depend on the length of the longest
        sentence in the same batch, so the same sentence classified alone and
        classified beside a long one gets two different answers.
        """
        if not self._ready or not texts:
            return []
        torch = self._torch
        with self._lock:
            with torch.no_grad():
                batch = self._tokenizer(
                    texts,
                    padding=True,
                    truncation=True,
                    max_length=self._max_tokens,
                    return_tensors="pt",
                )
                out = self._model(**batch)
                hidden = out.last_hidden_state
                mask = batch["attention_mask"].unsqueeze(-1).to(hidden.dtype)
                summed = (hidden * mask).sum(dim=1)
                counts = mask.sum(dim=1).clamp(min=1e-9)
                pooled = summed / counts
                pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
                return [[float(v) for v in row] for row in pooled]
