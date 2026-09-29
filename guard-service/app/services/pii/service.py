"""The ``PiiService`` singleton itself: construction, readiness, accessor.

Everything the service DOES lives in the mixins this class composes — loading,
inference serialisation, detection, overlap resolution and the cached async
entry point. What stays here is what only exists once: the ``__new__``-based
singleton and the instance state it seeds, the three readiness properties the
health endpoints read, and the module-level instance every caller shares.
"""

from __future__ import annotations

import threading
from typing import Optional

from .cache import _CacheAware
from .chunking import _FALLBACK_MAX_LEN
from .detection import _Detection
from .inference import _Inference
from .model_loading import _ModelLoading
from .overlaps import _OverlapResolution
from .probe import _Probe


class PiiService(
    _ModelLoading, _Inference, _Detection, _OverlapResolution, _CacheAware, _Probe
):
    """
    Singleton GLiNER pipeline for CPU-based PII detection.

    Two independent locks, for two independent reasons:
      * ``_lock`` (class-level) — singleton construction and load()/reload.
      * ``_inference_lock`` (instance) — every touch of the model or tokenizer.
        The underlying Rust tokenizer is not thread-safe and the request path
        is multi-threaded. See _locked_predict.
    """

    _instance: Optional["PiiService"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "PiiService":
        with cls._lock:
            if cls._instance is None:
                obj = super().__new__(cls)
                obj._model = None
                obj._model_id = None
                obj._ready = False
                # Surfaced via /health and /ready so a failed load is never
                # silent (BFSF-269: the GLiNER tier was silently regex-only).
                obj._load_error = None
                obj._backend = None
                # Serialises every touch of the model / tokenizer. See
                # _locked_predict for why this is not optional.
                obj._inference_lock = threading.Lock()
                # Set by load(): "tokenizer" (per-thread tokenizer, concurrent
                # forward passes) or "global" (the historical pod-wide lock).
                obj._lock_mode = "global"
                obj._predict_workers = 1
                # PERSISTENT pool, deliberately. A per-scan ThreadPoolExecutor
                # destroys its threads on exit, so every scan met fresh threads
                # and every fresh thread built its own tokenizer INSIDE the first
                # timed forward pass. Measured cost of that mistake: a 2,000-char
                # scan went 4.6s -> 30.6s, with predict_ms_max=27,164 for a pass
                # whose steady-state cost is ~380ms. Threads are created once and
                # their tokenizers primed at load.
                obj._predict_pool = None
                # Token-aware chunking limits, computed once at load().
                obj._tokenizer = None
                obj._max_len = _FALLBACK_MAX_LEN
                obj._text_token_budget = None
                obj._overlap_tokens = None
                # Widest shipped label prompt incl. framing tokens (load()).
                obj._label_prompt_tokens_max = None
                cls._instance = obj
        return cls._instance

    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    @property
    def backend(self) -> Optional[str]:
        return self._backend


# Module-level singleton helper
_service = PiiService()


def get_pii_service() -> PiiService:
    """FastAPI dependency / direct accessor."""
    return _service
