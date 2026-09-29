"""Getting the GLiNER model onto this CPU, and warm enough to serve.

Backend selection (baked fp32 ONNX graph, else fp32 PyTorch), thread-pool
sizing against the cgroup quota rather than the node's core count, the
concurrency mode that decides whether a pod-wide inference lock is needed, the
token-aware chunking limits, and the warm-inference priming that keeps the
first real scan off the cold path. ``_ready`` flips last, after priming.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .chunking import (
    _CHUNK_CHAR_LIMIT,
    _FALLBACK_MAX_LEN,
    _MIN_TEXT_TOKEN_BUDGET,
    _ThreadLocalTokenizer,
    _TOKEN_BUDGET_SAFETY,
    _label_prompt_tokens,
    _label_prompt_width_max,
    _model_limits,
    _overlap_tokens_for,
    _supports_offsets,
)
from .inference import _MODEL_BATCH_SIZE
from .label_groups import label_groups

logger = logging.getLogger("guard.pii")

# Ceiling on the derived worker count. Every worker thread builds its own
# tokenizer at startup (see _prime_workers), and a 251k-piece SentencePiece
# model is not cheap: 8 workers measured 26s of priming. The per-pass return is
# already flattening by then — measured ms/pass at 1/2/4/8 workers: 395 / 339 /
# 311 / 294 — so the last four workers buy ~6% and cost half a minute of cold
# start, which on a fail-closed deployment is half a minute of blocked chat.
# Override with GUARD_PII_PREDICT_WORKERS when a box has cores to burn.
_DEFAULT_MAX_PREDICT_WORKERS = 4


class _ModelLoading:
    """``PiiService``'s load/reload and warm-up half. Mixed into the service."""

    def load(self, model_id: str) -> None:  # noqa: C901, PLR0912, PLR0915
        """Load (or reload) the model. Call once at startup.

        Loads the fp32 ONNX graph baked at ``settings.pii_onnx_dir`` by
        default (``GUARD_PII_USE_ONNX=true``): ONNX-runtime CPU speed with
        full fp32 recall. Falls back to the fp32 PyTorch weights in the same
        dir (or a Hugging Face download) when ONNX is disabled or absent. We
        deliberately do NOT INT8-quantize — that collapsed person-name recall
        (BFSF-269).

        ONNX path is tuned for CPU: all available cores feed a single
        graph (intra-op parallelism), graph optimisations on, and BLAS
        env vars pinned to the same core count to avoid oversubscription.

        Never pass ``low_cpu_mem_usage`` on the ONNX path. It only ever
        applied to building the PyTorch module (a no-op here under 0.2.28),
        and since gliner 0.2.29 combining it with an external runtime raises
        ValueError, which leaves the pod permanently not-ready.
        """
        with self._lock:
            if self._ready and self._model_id == model_id:
                return

            import os
            from app.config import settings
            from gliner import GLiNER

            onnx_path = os.path.join(settings.pii_onnx_dir, settings.pii_onnx_file)
            use_onnx = settings.pii_use_onnx and os.path.isfile(onnx_path)
            # Prefer the fp32 weights baked into the image dir over a fresh
            # Hugging Face download — save_pretrained() wrote them alongside
            # the ONNX graph at build time, so no network is needed.
            local_fp32 = os.path.isdir(settings.pii_onnx_dir) and any(
                f.endswith((".safetensors", ".bin"))
                for f in os.listdir(settings.pii_onnx_dir)
            )

            # Size every thread pool to the cgroup CPU quota, NOT the node's
            # core count. Under our k8s limit (3 cores on an 8-core PRO2-S
            # node) os.cpu_count() returns 8, so ONNX/OpenMP would spawn 8
            # threads inside a 3-core quota → CFS throttling + context-switch
            # thrash. apply_thread_env() (called at process start) already
            # pinned the BLAS env vars; this re-asserts in case the model is
            # loaded outside the app lifespan (e.g. tests).
            from app.cpu import apply_thread_env, available_cpus

            apply_thread_env()
            cpu_count = available_cpus()
            # GUARD_PII_ORT_INTRA_OP_THREADS overrides the cgroup-derived count.
            # available_cpus() reads the cgroup QUOTA (limits.cpu) and cannot
            # see requests.cpu, so on a Burstable pod it sizes the pool for
            # cores the scheduler never guaranteed. This is the escape hatch for
            # that case, tunable without a rebuild.
            _ort_override = int(getattr(settings, "pii_ort_intra_op_threads", 0) or 0)
            if _ort_override > 0:
                logger.info(
                    "[PiiService] ORT intra-op threads overridden: %d (cgroup-derived was %d)",
                    _ort_override,
                    cpu_count,
                )
                cpu_count = _ort_override

            try:
                if use_onnx:
                    import onnxruntime as ort

                    session_options = ort.SessionOptions()
                    session_options.graph_optimization_level = (
                        ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                    )
                    session_options.intra_op_num_threads = cpu_count
                    session_options.inter_op_num_threads = 1
                    session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

                    logger.info(
                        "[PiiService] Loading GLiNER from fp32 ONNX %s on CPU (%d threads) …",
                        onnx_path,
                        cpu_count,
                    )
                    # runtime= / runtime_model_file= / runtime_options= are the
                    # gliner 0.2.29 spelling; load_onnx_model= and
                    # onnx_model_file= are its legacy aliases. local_files_only:
                    # the graph, config and tokenizer are all baked into this
                    # dir, and pods have no egress, so nothing may reach for
                    # the Hub (0.2.29 propagates the flag to every load).
                    self._model = GLiNER.from_pretrained(
                        settings.pii_onnx_dir,
                        runtime="onnxruntime",
                        runtime_model_file=settings.pii_onnx_file,
                        runtime_options={
                            "session_options": session_options,
                            "providers": ["CPUExecutionProvider"],
                        },
                        load_tokenizer=True,
                        local_files_only=True,
                    )
                else:
                    try:
                        import torch

                        torch.set_num_threads(cpu_count)
                        torch.set_num_interop_threads(1)
                    except Exception:
                        pass
                    source = settings.pii_onnx_dir if local_fp32 else model_id
                    logger.info(
                        "[PiiService] Loading PyTorch GLiNER fp32 from %s on CPU (%d threads) …",
                        source,
                        cpu_count,
                    )
                    # low_cpu_mem_usage: meta-device init, ~2x faster cold start
                    # (gliner 0.2.27+). Cold start is user-visible on
                    # fail-closed deployments — chat is blocked until /ready.
                    # Offline only for the baked dir; a Hub id must download.
                    self._model = GLiNER.from_pretrained(
                        source,
                        runtime="torch",
                        low_cpu_mem_usage=True,
                        local_files_only=local_fp32,
                    )

                self._model_id = model_id
                self._backend = "onnx-fp32" if use_onnx else "pytorch-fp32"
                self._load_error = None

                # ── Concurrency mode ──────────────────────────────────────
                # Install the per-thread tokenizer BEFORE _model_limits, so
                # self._tokenizer ends up being the proxy too and the chunker
                # inherits thread-locality without a second mechanism.
                self._lock_mode = (
                    str(
                        getattr(settings, "pii_inference_lock", "tokenizer")
                        or "tokenizer"
                    )
                    .strip()
                    .lower()
                )
                if self._lock_mode not in ("tokenizer", "global"):
                    logger.warning(
                        "[PiiService] unknown pii_inference_lock=%r — falling back to 'global'",
                        self._lock_mode,
                    )
                    self._lock_mode = "global"
                if self._lock_mode == "tokenizer":
                    try:
                        from transformers import AutoTokenizer

                        src = (
                            settings.pii_onnx_dir
                            if use_onnx
                            else (settings.pii_onnx_dir if local_fp32 else model_id)
                        )
                        self._model.data_processor.transformer_tokenizer = (
                            _ThreadLocalTokenizer(
                                lambda: AutoTokenizer.from_pretrained(src)
                            )
                        )
                    except Exception as exc:
                        # A tokenizer we cannot clone per thread means we cannot
                        # drop the lock — fail back to the safe mode rather than
                        # run concurrent passes over a shared Rust tokenizer.
                        logger.error(
                            "[PiiService] thread-local tokenizer unavailable (%s) — "
                            "keeping the global inference lock",
                            exc,
                        )
                        self._lock_mode = "global"

                _workers = int(getattr(settings, "pii_predict_workers", 0) or 0)
                if _workers <= 0:
                    _workers = min(cpu_count, _DEFAULT_MAX_PREDICT_WORKERS)
                # One worker in global-lock mode: fan-out there would only queue
                # on the lock while paying thread-handoff for nothing.
                self._predict_workers = (
                    _workers if self._lock_mode == "tokenizer" else 1
                )

                # Replace the pool (a reload must not leak the old threads).
                _old_pool, self._predict_pool = self._predict_pool, None
                if _old_pool is not None:
                    _old_pool.shutdown(wait=False)
                if self._predict_workers > 1:
                    self._predict_pool = ThreadPoolExecutor(
                        max_workers=self._predict_workers,
                        thread_name_prefix="pii-predict",
                    )

                logger.info(
                    "[PiiService] Model loaded (backend=%s, threads=%d, lock=%s, "
                    "predict_workers=%d) — priming …",
                    self._backend,
                    cpu_count,
                    self._lock_mode,
                    self._predict_workers,
                )

                # ── Token-aware chunking limits (computed once) ───────────
                # A failure here only downgrades to char chunking — never
                # flips _ready off, so detection still works.
                try:
                    tok, max_len = _model_limits(self._model)
                    self._max_len = max_len
                    if tok is not None and _supports_offsets(tok):
                        prompt = _label_prompt_tokens(tok, label_groups())
                        budget = max(
                            _MIN_TEXT_TOKEN_BUDGET,
                            max_len - prompt - _TOKEN_BUDGET_SAFETY,
                        )
                        self._tokenizer = tok
                        self._text_token_budget = budget
                        self._overlap_tokens = _overlap_tokens_for(budget)
                        # The widest shipped label set INCLUDING its framing
                        # tokens: the width `budget` was cut for. A request's
                        # custom label group that is wider gets its own chunk
                        # list, narrowed by exactly the difference (see
                        # detection._custom_budget).
                        self._label_prompt_tokens_max = _label_prompt_width_max(
                            tok, label_groups()
                        )
                        logger.info(
                            "[PiiService] token-aware chunking: max_len=%d label_prompt=%d "
                            "text_budget=%d overlap=%d prompt_width_max=%d",
                            max_len,
                            prompt,
                            budget,
                            self._overlap_tokens,
                            self._label_prompt_tokens_max,
                        )
                    else:
                        self._tokenizer = None
                        self._text_token_budget = None
                        self._label_prompt_tokens_max = None
                        logger.warning(
                            "[PiiService] tokenizer has no offset mapping — using "
                            "conservative char chunking (limit=%d)",
                            _CHUNK_CHAR_LIMIT,
                        )
                except Exception as exc:
                    self._tokenizer = None
                    self._text_token_budget = None
                    self._label_prompt_tokens_max = None
                    logger.warning(
                        "[PiiService] chunk-limit setup failed (%s) — char fallback",
                        exc,
                    )

                # ── Warm-inference priming ────────────────────────────────
                # Pay ONNX graph-finalisation + ORT arena growth NOW (on the
                # warm-load thread) instead of on the user's first large scan.
                # Priming failure must never flip _ready off.
                if getattr(settings, "pii_warm_inference", True):
                    try:
                        self._prime()
                    except Exception as exc:
                        logger.warning(
                            "[PiiService] warm-inference priming failed: %s", exc
                        )

                # _ready flips LAST, after priming. It used to flip before
                # _prime(), and _prime() runs inference on the warm-load thread
                # while load() holds only the singleton lock — which the request
                # path never takes. So /ready went green and request threads
                # could enter inference while priming was still in
                # it, giving a third concurrent user of the one tokenizer. The
                # lock below would serialise them now, but advertising readiness
                # before the pod can actually serve is wrong on its own.
                self._ready = True
                logger.info("[PiiService] Model ready ✓ (backend=%s)", self._backend)
            except Exception as exc:
                # Do NOT swallow silently — record the error so /health and
                # /ready can surface it and the warm-load thread can retry.
                logger.error(
                    "[PiiService] Failed to load model %s: %s",
                    model_id,
                    exc,
                    exc_info=True,
                )
                self._model = None
                self._ready = False
                self._load_error = f"{type(exc).__name__}: {exc}"

    def _prime(self) -> None:
        """Run representative inferences to warm the graph + ORT memory arena.

        Backend-agnostic (same predict API for ONNX and PyTorch). Runs both the
        single-text and batch paths so the first real request — often a large
        multi-chunk scan — doesn't pay arena-growth + first-call latency.
        """
        if self._model is None:
            return
        sample = (
            "Jan de Vries woont in Amsterdam, IBAN NL91ABNA0417164300, "
            "tel 06-12345678, geboren op 03-04-1980."
        )
        # Prime with the WIDEST label group, at the LONGEST shape we will serve.
        # The ORT arena is sized by (batch x sequence length), so priming on a
        # short sample leaves it undersized and the first full-length chunk pays
        # the growth anyway — the exact cost this function exists to avoid.
        # `_text_token_budget` is the real per-chunk ceiling, so repeat the
        # sample up to roughly that many tokens.
        widest = max(label_groups(), key=len)
        budget = self._text_token_budget or _FALLBACK_MAX_LEN
        # ~1 token per 3.5 Dutch chars; overshoot is harmless (it is truncated).
        reps = max(1, int(budget * 3.5 / len(sample)) + 1)
        long_sample = (sample + " ") * reps

        with self._inference_lock:
            self._model.predict_entities(sample, widest, threshold=0.5)
            self._model.inference(
                [long_sample] * _MODEL_BATCH_SIZE,
                widest,
                threshold=0.5,
                flat_ner=True,
                batch_size=_MODEL_BATCH_SIZE,
            )
        logger.info("[PiiService] warm-inference priming complete")
        self._prime_workers(sample)

    def _prime_workers(self, sample: str) -> None:
        """Build every worker thread's tokenizer NOW, not inside a user's scan.

        Each pool thread gets its own tokenizer on first use (see
        _ThreadLocalTokenizer). Parsing a 251k-piece SentencePiece model is not
        free, and eight threads doing it at once inside a CPU quota is very much
        not free: before this existed, a 2,000-char scan measured 30.6s with
        predict_ms_max=27,164 against a ~380ms steady state, because the pool was
        rebuilt per scan and every thread paid construction inside its first
        timed pass.

        A Barrier is what makes this correct rather than approximate: without it
        the executor happily runs all N tasks on the FIRST thread that becomes
        free, and the other N-1 threads are never created — priming that primes
        nothing. Every task waits until all N have arrived, which forces N
        distinct threads to exist.
        """
        pool = getattr(self, "_predict_pool", None)
        n = int(getattr(self, "_predict_workers", 1) or 1)
        if pool is None or n <= 1:
            return
        barrier = threading.Barrier(n, timeout=60)

        def _warm(_):
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass  # fewer threads than expected — still prime this one
            self._model.predict_entities(sample, label_groups()[0], threshold=0.5)

        try:
            t0 = time.perf_counter()
            list(pool.map(_warm, range(n)))
            logger.info(
                "[PiiService] primed %d predict worker(s) in %.0fms "
                "(tokenizer instances: %s)",
                n,
                (time.perf_counter() - t0) * 1000,
                getattr(self._tokenizer, "_instances", "n/a"),
            )
        except Exception as exc:
            # Priming is an optimisation. A failure here costs latency on the
            # first scan; it must never keep the service from becoming ready.
            logger.warning("[PiiService] worker priming failed (%s) — continuing", exc)
