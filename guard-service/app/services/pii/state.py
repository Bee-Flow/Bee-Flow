"""The instance state and cross-mixin calls the ``PiiService`` mixins share.

``PiiService`` is composed from mixins (loading, inference, detection, overlap
resolution, cache, probe) that read and write one set of attributes, which
``PiiService.__new__`` seeds. Each mixin used to rely on that implicitly, so a
type checker saw attribute reads on a class that never defines them. This base
declares them once, with types. It holds annotations only: nothing here exists
at runtime beyond the empty class, and the methods that one mixin calls on
another are declared for the type checker alone (``TYPE_CHECKING``), so a real
implementation always wins.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, ClassVar


class _PiiState:
    _lock: ClassVar[threading.Lock]
    _model: Any
    _model_id: str | None
    _ready: bool
    _load_error: str | None
    _backend: str | None
    _inference_lock: threading.Lock
    _lock_mode: str
    _predict_workers: int
    _predict_pool: ThreadPoolExecutor | None
    _tokenizer: Any
    _max_len: int
    _text_token_budget: int | None
    _overlap_tokens: int | None
    _label_prompt_tokens_max: int | None

    if TYPE_CHECKING:

        def _finalise(self, *args: Any, **kwargs: Any) -> Any: ...
        def _locked_prompt_width(self, labels: list[str]) -> int | None: ...
        def _locked_chunk(self, *args: Any, **kwargs: Any) -> Any: ...
        def _locked_predict(self, *args: Any, **kwargs: Any) -> Any: ...
        def _custom_chunks(self, *args: Any, **kwargs: Any) -> Any: ...
        def _run_scan_units(self, *args: Any, **kwargs: Any) -> Any: ...
        def detect_request(self, req: Any) -> dict[str, Any]: ...
