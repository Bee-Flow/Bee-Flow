"""Issuing forward passes, and chunking, under the right serialisation.

Both entry points exist because ``self._tokenizer`` IS the model's own
tokenizer: inference and chunking touch the same Rust object, so in
``global`` lock mode both must hold the pod-wide lock, and in ``tokenizer``
mode neither needs to. Keeping the two together is what stops one of them
quietly losing its lock.
"""

from __future__ import annotations

import contextlib
import logging
import time

from .chunking import _ChunkBudget, _chunk_text, _chunk_text_chars, _label_prompt_width

logger = logging.getLogger("guard.pii")

# Chunks per model call. GLiNER has NO internal sub-batching — it collates the
# whole input list into ONE PADDED forward pass, so every chunk in a batch pays
# the width of the longest one.
#
# This was 8, on the reasoning that batching amortises per-call overhead while
# bounding activation memory. Measured, that reasoning is wrong on this pod:
# with 3 cores a single ~373-token sequence already saturates the intra-op
# thread pool, so widening the batch adds no parallelism — only padding and
# cache pressure. End-to-end detect() on an 8,040-char document:
#
#     tier=on    9,975 ms -> 8,218 ms   (-18%)
#     tier=off  18,299 ms -> 13,910 ms  (-24%)
#
# Output is bit-identical: same entities, offsets, lengths, categories AND
# confidences. Short chat messages are one chunk either way and unaffected.
#
# The memory argument inverts too — batch=1 is the *smallest* possible
# activation footprint, so the OOM concern that motivated the slicing is
# better served by this value than by 8.
#
# RE-MEASURED 2026-07-31 at an 8-core quota (scripts/bench_passes.py, one
# ~366-token chunk, intra_op=8), because the note above says this is a function
# of core count and should be revisited. It does not change the answer:
#
#     rows/call   1      2      3      4
#     ms/row   1697   1591   1501   1547        (per-row speedup 1.00 / 1.07 / 1.13 / 1.10)
#
# ~10% at best, and non-monotonic past 3. One sequence still saturates the
# quota, so widening the batch buys padding, not parallelism. The same session
# established what DOES pay: issuing passes CONCURRENTLY against one session
# (see pii_predict_workers) — 395 -> 294 ms/pass at 8 workers.
#
# Per-item label sets (inference's List[List[str]] form) are CORRECT since
# gliner 0.2.29, which fixed the two traps 0.2.28 had. Re-checked 2026-09-26
# against the shipped model, bit-identical to sequential calls at 4 decimals:
#   1. Ragged label COUNTS in one batch: a (3,5) batch raised KeyError: 4 in
#      0.2.28 (the graph scored zero-padded prompt slots); now it matches.
#   2. batch_size < len(texts): 0.2.28's collate_fn indexed the FULL label
#      list with a mini-batch-local index, so row 9 silently got row 1's
#      labels; _entity_types_for_chunk now slices per mini-batch.
# So label-group bucketing is possible. It is still not FASTER (above), and
# _predict still passes batch_size=len(texts) so each call stays one pass.
_MODEL_BATCH_SIZE = 1


class _Inference:
    """``PiiService``'s model-call surface. Mixed into the service."""

    def _predict(self, sub_texts, group_labels, threshold):
        """The one forward-pass call, unlocked. Callers decide the locking.

        ``GLiNER.inference`` replaced ``batch_predict_entities`` (deprecated
        since gliner 0.2.28; it only forwards here). ``batch_size`` is
        explicit: the forwarder left it at inference's default of 8, and
        _MODEL_BATCH_SIZE promises every call is ONE padded pass.
        """
        return self._model.inference(
            sub_texts,
            group_labels,
            threshold=threshold,
            flat_ner=True,
            batch_size=max(1, len(sub_texts)),
        )

    # ── Inference serialisation ────────────────────────────────────────────
    # Everything that touches the model also touches ONE shared Rust
    # `tokenizers` instance: self._tokenizer IS
    # model.data_processor.transformer_tokenizer (see _model_limits), and
    # GLiNER.inference uses that same object internally. The Rust binding
    # is not thread-safe — two threads inside it raise "Already borrowed"
    # (huggingface/tokenizers#537, transformers#12658).
    #
    # In production that surfaced as: every label group of one request failing
    # inside 600ms, degraded=True with gliner_group_failed:<16 categories>, and
    # a fail-closed org blocking the user's message with "Privacy protection is
    # temporarily unavailable". 22 occurrences in 48h, all on a single pod.
    #
    # The asyncio semaphore (pii_max_concurrency) never prevented this — it
    # CAUSED it at any value above 1, because each admitted request runs
    # detect() in its own asyncio.to_thread worker against the singleton.
    #
    # Locked per CALL rather than per request, deliberately: a 60-chunk document
    # releases the lock between chunks, so a short request interleaves instead
    # of waiting out the whole document. That is the shape of the actual
    # complaint — the observed victim was a 765-char request that failed inside
    # a 10.7s scan's window, not the big scan itself.
    def _locked_predict(
        self,
        sub_texts,
        group_labels,
        threshold,
        lock_wait_ms: list[float] | None = None,
        predict_ms: list[float] | None = None,
    ):
        # Lock-wait is the signal that says "this pod is saturated" as opposed to
        # "this scan is slow" — the two look identical in a total duration, and
        # telling them apart from the outside was what made the original
        # incident a log-archaeology exercise. Production sends no OTEL, so it
        # goes in the ordinary applog. ``lock_wait_ms`` (a request-local
        # accumulator) additionally sums EVERY wait — the sub-second ones are
        # individually silent but collectively they are the queueing signal
        # the pii.scan line reports per request.
        # In "tokenizer" mode there is nothing to wait for: the tokenizer is
        # per-thread and ORT Run() is thread-safe on the CPU EP. Keep appending
        # a 0 so lock_wait_ms stays a per-pass series in both modes and the
        # pii.scan line means the same thing across a rollout.
        if self._lock_mode != "global":
            if lock_wait_ms is not None:
                lock_wait_ms.append(0.0)
            _p0 = time.perf_counter()
            try:
                return self._predict(sub_texts, group_labels, threshold)
            finally:
                if predict_ms is not None:
                    predict_ms.append((time.perf_counter() - _p0) * 1000)

        _t0 = time.perf_counter()
        with self._inference_lock:
            _waited_ms = (time.perf_counter() - _t0) * 1000
            if lock_wait_ms is not None:
                lock_wait_ms.append(_waited_ms)
            if _waited_ms > 1000:
                logger.info(
                    "[PiiService] waited %.0fms for the inference lock (%d chars)",
                    _waited_ms,
                    sum(len(t) for t in sub_texts),
                )
            _p0 = time.perf_counter()
            try:
                return self._predict(sub_texts, group_labels, threshold)
            finally:
                if predict_ms is not None:
                    predict_ms.append((time.perf_counter() - _p0) * 1000)

    def _locked_chunk(
        self, text: str, budget: _ChunkBudget | None = None
    ) -> list[tuple[int, str]]:
        """Chunk under the inference lock.

        _chunk_text_tokens calls the tokenizer directly, so it needs the same
        serialisation as inference. It already swallows a tokenizer error into
        the char-based fallback, which is why this failure mode was invisible:
        a concurrent chunking call did not error, it silently produced
        900-char chunks instead of token-budget ones — different chunk
        boundaries, different spans, no log line. The outer guard is
        belt-and-braces; the lock is the fix.

        ``budget`` overrides the load-time limits for one label group (a
        custom group with a wider prompt); None is the shipped behaviour.
        """
        if budget is None:
            tokens, overlap, char_limit = (
                self._text_token_budget,
                self._overlap_tokens,
                None,
            )
        else:
            tokens, overlap, char_limit = budget
        if self._lock_mode != "global":
            # The proxy IS the serialisation here — chunking only touches the
            # tokenizer, and that is now per-thread.
            try:
                return _chunk_text(text, self._tokenizer, tokens, overlap, char_limit)
            except Exception as exc:
                logger.error("[PiiService] chunking failed (%s) — char fallback", exc)
                return _chunk_text_chars(text, char_limit)

        with self._inference_lock:
            try:
                return _chunk_text(text, self._tokenizer, tokens, overlap, char_limit)
            except Exception as exc:
                logger.error("[PiiService] chunking failed (%s) — char fallback", exc)
                return _chunk_text_chars(text, char_limit)

    def _locked_prompt_width(self, labels: list[str]) -> int | None:
        """_label_prompt_width under the same serialisation as chunking.

        None when the tokenizer cannot answer; the caller then falls back to
        char chunking. The labels are admin-written prompts, so only the
        exception TYPE is logged.
        """
        guard = (
            self._inference_lock
            if self._lock_mode == "global"
            else contextlib.nullcontext()
        )
        with guard:
            try:
                return _label_prompt_width(self._tokenizer, labels)
            except Exception as exc:
                logger.error(
                    "[PiiService] custom prompt width unavailable (%s) — char fallback",
                    type(exc).__name__,
                )
                return None
