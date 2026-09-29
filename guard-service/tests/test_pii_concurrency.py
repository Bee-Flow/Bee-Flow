"""Concurrency contract for PiiService.

The bug these tests exist for was user-visible in production: intermittent
"Privacy protection is temporarily unavailable, so your message was not sent",
22 times in 48h, all on a single pod, correlated with bulk paste/upload.

Root cause: ``self._tokenizer`` IS ``model.data_processor.transformer_tokenizer``,
so the chunker and ``GLiNER.inference`` share one Rust ``tokenizers``
object. That binding is not thread-safe (huggingface/tokenizers#537). Meanwhile
``detect_async`` admits ``pii_max_concurrency`` requests and runs each in its own
``asyncio.to_thread`` worker against the singleton — so the semaphore was not the
protection, it was the mechanism. At 2, two threads entered the tokenizer and it
raised "Already borrowed"; every label group of the losing request failed, the
response came back ``degraded``, and a fail-closed org blocked the message.

Two failure shapes are covered, because only one of them is loud:

  * in ``GLiNER.inference`` the error propagates to the per-slice
    ``except``, fails the group, and degrades the response — visible;
  * in the chunker it is swallowed into the char-based fallback
    (``_chunk_text_tokens``), which silently produces different chunk
    boundaries and therefore different spans, with no log line at all.

So the assertions are "zero borrow violations" AND "not degraded" — the first
catches the silent shape, the second the loud one.

Stdlib only; no model download. The fake below emulates the Rust borrow
semantics rather than the model's predictions.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import re
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

import app.services.pii as pii_mod
from app.services.pii import PiiService, get_pii_service


class SharedBorrowState:
    """The one "Rust object" that the tokenizer and the model both hand out.

    ``borrow()`` raises RuntimeError("Already borrowed") when a second thread
    enters while the first is inside — exactly what the Rust binding does — and
    counts the violation even when the caller swallows the exception.
    """

    def __init__(self, hold_s: float = 0.01):
        self._guard = threading.Lock()
        self._holder: str | None = None
        self.hold_s = hold_s
        self.violations = 0

    @contextlib.contextmanager
    def borrow(self, who: str):
        with self._guard:
            if self._holder is not None:
                self.violations += 1
                raise RuntimeError("Already borrowed")
            self._holder = who
        try:
            # Widen the window so overlap does not depend on scheduler luck.
            time.sleep(self.hold_s)
            yield
        finally:
            with self._guard:
                self._holder = None


class BorrowCheckingTokenizer:
    """FakeTokenizer + borrow semantics. Same offset-mapping contract."""

    def __init__(self, state: SharedBorrowState):
        self.state = state

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):
        with self.state.borrow("tokenizer"):
            toks = list(re.finditer(r"\S+", text))
            out = {"input_ids": [1] * len(toks)}
            if return_offsets_mapping:
                out["offset_mapping"] = [(m.start(), m.end()) for m in toks]
            return out


class BorrowCheckingGliner:
    """Model stand-in that borrows the SAME state as the tokenizer."""

    def __init__(self, state: SharedBorrowState):
        self.state = state

    def predict_entities(self, text, labels, threshold=0.0):
        with self.state.borrow("model"):
            return []

    def inference(self, texts, labels, threshold=0.0, **kwargs):
        with self.state.borrow("model"):
            return [[] for _ in texts]


# Long enough to chunk several times at the tiny token budget below, so the
# per-call lock is exercised repeatedly within one request.
_TEXT = " ".join(f"regel{i} met wat tekst erin" for i in range(24))


class SharedTokenizerConcurrencyTests(unittest.TestCase):
    """Concurrent scans must not corrupt the one shared tokenizer."""

    def setUp(self):
        from app.config import settings

        self.settings = settings
        self._saved = (
            settings.pii_max_concurrency,
            settings.pii_regex_tier,
        )
        # Admit several at once — that is the production configuration this
        # bug appeared under, and at 1 the test proves nothing.
        settings.pii_max_concurrency = 8
        # Keep the regex tier out of it; it is pure and not what is under test.
        settings.pii_regex_tier = "off"
        pii_mod.reset_inference_semaphore()

        self.state = SharedBorrowState()
        svc = get_pii_service()
        self._saved_svc = (
            svc._model,
            svc._ready,
            svc._backend,
            svc._load_error,
            svc._tokenizer,
            svc._text_token_budget,
            svc._overlap_tokens,
            getattr(svc, "_lock_mode", "global"),
            getattr(svc, "_predict_workers", 1),
        )
        svc._model = BorrowCheckingGliner(self.state)
        svc._tokenizer = BorrowCheckingTokenizer(self.state)
        svc._text_token_budget = 8  # → many chunks from _TEXT
        svc._overlap_tokens = 2
        # Explicit: this fixture models ONE shared Rust object behind both the
        # tokenizer and the model, which is the pre-fix world the global lock
        # exists for. The "tokenizer" mode is covered by
        # ThreadLocalTokenizerTests with a fixture that matches its premises.
        svc._lock_mode = "global"
        svc._predict_workers = 1
        svc._ready = True
        svc._load_error = None
        svc._backend = "fake"
        self.svc = svc

    def tearDown(self):
        self.settings.pii_max_concurrency, self.settings.pii_regex_tier = self._saved
        pii_mod.reset_inference_semaphore()
        (
            self.svc._model,
            self.svc._ready,
            self.svc._backend,
            self.svc._load_error,
            self.svc._tokenizer,
            self.svc._text_token_budget,
            self.svc._overlap_tokens,
            self.svc._lock_mode,
            self.svc._predict_workers,
        ) = self._saved_svc

    def _gather(self, n):
        async def run():
            # Distinct texts so a cache — if one is reachable — cannot collapse
            # the requests into a single scan.
            return await asyncio.gather(
                *[
                    self.svc.detect_async(
                        text=f"verzoek {i}: {_TEXT}",
                        confidence_threshold=0.7,
                        enabled_categories=["Person"],
                    )
                    for i in range(n)
                ]
            )

        return asyncio.run(run())

    def test_concurrent_scans_never_borrow_the_tokenizer_twice(self):
        results = self._gather(8)
        self.assertEqual(
            self.state.violations,
            0,
            f"{self.state.violations} concurrent borrows of the shared tokenizer",
        )
        degraded = [r for r in results if r.get("degraded")]
        self.assertEqual(
            degraded,
            [],
            "a concurrent scan degraded — this is the response that makes the "
            "user see 'Privacy protection is temporarily unavailable'",
        )

    def test_a_single_scan_still_works(self):
        """Guards against 'fixed' by deadlocking: the lock must be released."""
        (result,) = self._gather(1)
        self.assertFalse(result.get("degraded"))
        self.assertEqual(self.state.violations, 0)


class PerInstanceBorrowTokenizer:
    """A tokenizer whose borrow state is its OWN, not shared.

    That is precisely what a per-thread instance buys: the Rust ``RefCell`` that
    ``enable_truncation``/``enable_padding`` mutate belongs to one tokenizer, so
    two threads holding two tokenizers can never collide. Every instance created
    is recorded so a test can prove both facts at once — N threads produced N
    instances, and the total violation count is zero.
    """

    created: list["PerInstanceBorrowTokenizer"] = []

    def __init__(self, hold_s: float = 0.005):
        self.state = SharedBorrowState(hold_s=hold_s)
        PerInstanceBorrowTokenizer.created.append(self)

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):
        with self.state.borrow("tokenizer"):
            toks = list(re.finditer(r"\S+", text))
            out = {"input_ids": [1] * len(toks)}
            if return_offsets_mapping:
                out["offset_mapping"] = [(m.start(), m.end()) for m in toks]
            return out


class ConcurrencyRecordingGliner:
    """Thread-safe model stand-in that records peak concurrency.

    Deliberately does NOT borrow a shared state: ORT's InferenceSession.Run() is
    documented thread-safe on the CPU EP, so a fake that raised on concurrent
    entry would be asserting a hazard that does not exist and would hide the one
    that does (the tokenizer).
    """

    def __init__(self, hold_s: float = 0.02):
        self._lock = threading.Lock()
        self.inside = 0
        self.max_inside = 0
        self.calls = 0
        self.hold_s = hold_s

    def _enter(self):
        with self._lock:
            self.inside += 1
            self.calls += 1
            self.max_inside = max(self.max_inside, self.inside)

    def _exit(self):
        with self._lock:
            self.inside -= 1

    def inference(self, texts, labels, threshold=0.0, **kwargs):
        self._enter()
        try:
            time.sleep(self.hold_s)
            return [[] for _ in texts]
        finally:
            self._exit()


class ThreadLocalTokenizerTests(unittest.TestCase):
    """The lock narrowing: per-thread tokenizers, concurrent forward passes.

    The original incident was a TOKENIZER problem fixed with a lock around
    INFERENCE, so every forward pass paid for a hazard it did not sit on. These
    tests pin both halves of the replacement — the hazard stays closed, and the
    passes actually run concurrently.
    """

    def setUp(self):
        from app.config import settings

        self.settings = settings
        self._saved = (settings.pii_max_concurrency, settings.pii_regex_tier)
        settings.pii_max_concurrency = 8
        settings.pii_regex_tier = "off"
        pii_mod.reset_inference_semaphore()

        PerInstanceBorrowTokenizer.created = []
        svc = get_pii_service()
        self._saved_svc = (
            svc._model,
            svc._ready,
            svc._backend,
            svc._load_error,
            svc._tokenizer,
            svc._text_token_budget,
            svc._overlap_tokens,
            getattr(svc, "_lock_mode", "global"),
            getattr(svc, "_predict_workers", 1),
            getattr(svc, "_predict_pool", None),
        )
        # The pool is PERSISTENT in production (load() builds it once), because a
        # per-scan executor made every scan build fresh tokenizers inside its
        # first timed pass. Model that here, or the fan-out silently does not
        # happen and the test would be asserting nothing.
        self._pool = ThreadPoolExecutor(
            max_workers=8, thread_name_prefix="test-predict"
        )
        svc._predict_pool = self._pool
        self.model = ConcurrencyRecordingGliner()
        svc._model = self.model
        svc._tokenizer = pii_mod._ThreadLocalTokenizer(PerInstanceBorrowTokenizer)
        svc._text_token_budget = 8
        svc._overlap_tokens = 2
        svc._ready = True
        svc._load_error = None
        svc._backend = "fake"
        self.svc = svc

    def tearDown(self):
        self.settings.pii_max_concurrency, self.settings.pii_regex_tier = self._saved
        pii_mod.reset_inference_semaphore()
        self._pool.shutdown(wait=False)
        (
            self.svc._model,
            self.svc._ready,
            self.svc._backend,
            self.svc._load_error,
            self.svc._tokenizer,
            self.svc._text_token_budget,
            self.svc._overlap_tokens,
            self.svc._lock_mode,
            self.svc._predict_workers,
            self.svc._predict_pool,
        ) = self._saved_svc

    def _scan(self):
        return asyncio.run(
            self.svc.detect_async(
                text=_TEXT,
                confidence_threshold=0.7,
                enabled_categories=["Person"],
            )
        )

    def test_passes_run_concurrently_and_nothing_degrades(self):
        self.svc._lock_mode = "tokenizer"
        self.svc._predict_workers = 8
        result = self._scan()
        self.assertGreater(self.model.calls, 1, "the fixture produced only one pass")
        self.assertGreater(
            self.model.max_inside,
            1,
            "passes were still serialised — the fan-out did not happen",
        )
        self.assertFalse(result.get("degraded"), result.get("degraded_reason"))
        violations = sum(t.state.violations for t in PerInstanceBorrowTokenizer.created)
        self.assertEqual(violations, 0, f"{violations} concurrent tokenizer borrows")

    def test_the_kill_switch_restores_full_serialisation(self):
        self.svc._lock_mode = "global"
        self.svc._predict_workers = 8  # ignored in global mode
        result = self._scan()
        self.assertEqual(
            self.model.max_inside,
            1,
            "GUARD_PII_INFERENCE_LOCK=global must serialise every forward pass",
        )
        self.assertFalse(result.get("degraded"))

    def test_scan_stats_report_the_pass_count(self):
        self.svc._lock_mode = "tokenizer"
        self.svc._predict_workers = 4
        self._scan()
        # detect_async strips internals from the wire, so read the raw path.
        _ents, meta = self.svc._detect_raw(
            _TEXT,
            confidence_threshold=0.7,
            enabled_categories=["Person"],
        )
        stats = meta["scan_stats"]
        self.assertEqual(stats["passes"], stats["chunks"] * stats["groups"])
        self.assertGreaterEqual(stats["predict_ms"], 0)

    def test_a_thread_gets_its_own_tokenizer_instance(self):
        proxy = pii_mod._ThreadLocalTokenizer(PerInstanceBorrowTokenizer)
        seen = []

        def use():
            proxy("een twee drie", return_offsets_mapping=True)
            seen.append(id(proxy._tok))

        threads = [threading.Thread(target=use) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(set(seen)), 4, "threads shared a tokenizer instance")

    def test_the_proxy_delegates_len_and_attributes(self):
        # gliner calls len(tokenizer) in set_class_indices; a partial proxy
        # would surface as a wrong chunk boundary rather than an error.
        class Sized(PerInstanceBorrowTokenizer):
            def __len__(self):
                return 7

            model_max_length = 384

        proxy = pii_mod._ThreadLocalTokenizer(Sized)
        self.assertEqual(len(proxy), 7)
        self.assertEqual(proxy.model_max_length, 384)


class ChunkingSerialisationTests(unittest.TestCase):
    """Chunking holds the SAME lock as inference, in global-lock mode.

    Easy to get wrong by locking only ``GLiNER.inference``: the chunker
    calls the tokenizer directly, and that call is the silent half of the bug.
    In "tokenizer" mode the per-thread instance is the protection instead —
    covered by ThreadLocalTokenizerTests above.
    """

    def setUp(self):
        self.svc = get_pii_service()
        self._saved = (
            self.svc._tokenizer,
            self.svc._text_token_budget,
            self.svc._overlap_tokens,
            getattr(self.svc, "_lock_mode", "global"),
        )
        self.svc._lock_mode = "global"

    def tearDown(self):
        (
            self.svc._tokenizer,
            self.svc._text_token_budget,
            self.svc._overlap_tokens,
            self.svc._lock_mode,
        ) = self._saved

    def test_the_tokenizer_is_called_with_the_inference_lock_held(self):
        seen = []
        svc = self.svc

        class Probe:
            def __call__(
                self, text, add_special_tokens=False, return_offsets_mapping=False
            ):
                seen.append(svc._inference_lock.locked())
                toks = list(re.finditer(r"\S+", text))
                out = {"input_ids": [1] * len(toks)}
                if return_offsets_mapping:
                    out["offset_mapping"] = [(m.start(), m.end()) for m in toks]
                return out

        self.svc._tokenizer = Probe()
        self.svc._text_token_budget = 8
        self.svc._overlap_tokens = 2

        chunks = self.svc._locked_chunk(_TEXT)
        self.assertTrue(chunks)
        self.assertTrue(seen, "the tokenizer was never called")
        self.assertTrue(all(seen), "chunking ran without the inference lock")
        # And the lock is handed back.
        self.assertFalse(self.svc._inference_lock.locked())

    def test_a_broken_tokenizer_never_escapes_as_an_exception(self):
        """/pii has no exception handler, so a raise here would be a 500."""

        class Exploding:
            def __call__(self, *a, **kw):
                raise RuntimeError("Already borrowed")

        self.svc._tokenizer = Exploding()
        self.svc._text_token_budget = 8
        self.svc._overlap_tokens = 2
        chunks = self.svc._locked_chunk(_TEXT)
        self.assertTrue(chunks)
        self.assertEqual(chunks[0][0], 0)


class ReadinessOrderingTests(unittest.TestCase):
    """_ready must flip AFTER priming, not before.

    _prime() runs inference on the warm-load thread while load() holds only the
    singleton lock — which the request path never takes. Flipping _ready first
    therefore opened /ready while priming was still inside the tokenizer, giving
    a third concurrent user of it. Source-level because the alternative is
    loading a 2.5GB model in a unit test.
    """

    def test_ready_is_set_after_prime_in_load(self):
        src = inspect.getsource(PiiService.load)
        self.assertIn("self._prime()", src)
        self.assertIn("self._ready = True", src)
        self.assertLess(
            src.index("self._prime()"),
            src.index("self._ready = True"),
            "load() advertises readiness before warm-inference priming finishes",
        )


if __name__ == "__main__":
    unittest.main()
