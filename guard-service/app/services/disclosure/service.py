"""The ``DisclosureService`` singleton — anchors in, a three-way verdict out.

WHAT THIS ANSWERS, precisely: does this text TELL ITS READER that AI was
involved in producing it. Not "does it mention AI", not "is it about AI", and
emphatically not "should it disclose" — that last one is a legal question and
it is answered by the compliance check that consults this, never here.

WHAT LEAVES THIS SERVICE. A verdict, a similarity, and the id of one of OUR
OWN anchor sentences. No fragment of the submitted text is echoed back and
none of it is logged: the log line carries a length, a segment count and a
verdict, the way ``routers/pii.py`` carries counts and category names but
never a span. Text arrives, is compared, and is dropped.

READINESS IS NOT FATAL. ``load()`` failing — which, in the default image, is
what happens, because no encoder is baked (see ``encoder.py``) — leaves the
service un-ready and every ``classify`` answers ``disclosed=None`` with
``degraded=True``. The one thing it must never answer is ``disclosed=False``
on the grounds that it could not look, because that is the answer that makes a
caller believe a duty is open when nothing established it, and — read the
other way around by a caller that inverts it — the answer that closes one.
Nobody looked is its own state here, exactly as ``matched: null`` is its own
state in server/core/privacy/personalColumns.js.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from . import anchors as _anchors
from .encoder import SentenceEncoder
from .similarity import best_similarity, segments, verdict

logger = logging.getLogger("guard.disclosure")


class DisclosureService:
    """Singleton AI-disclosure classifier over a fixed anchor bank."""

    _instance: Optional["DisclosureService"] = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> "DisclosureService":
        with cls._singleton_lock:
            if cls._instance is None:
                obj = super().__new__(cls)
                obj._encoder = SentenceEncoder()
                obj._anchor_vectors: list[list[float]] = []
                obj._anchor_ids: list[str] = []
                obj._split = 0
                obj._ready = False
                obj._load_error = None
                obj._fingerprint = None
                cls._instance = obj
        return cls._instance

    # ── state ────────────────────────────────────────────────────────────
    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def fingerprint(self) -> str | None:
        """Identity of everything that decides a verdict, or None when nothing
        can decide one. The anchor bank is in it because the anchors ARE the
        classifier."""
        return self._fingerprint

    # ── loading ──────────────────────────────────────────────────────────
    def load(
        self,
        model_dir: str,
        *,
        max_tokens: int = 128,
        encoder: SentenceEncoder | None = None,
    ) -> None:
        """Load the encoder and embed the anchor bank once. Never raises.

        `encoder` is the test seam — the same shape ``tests/test_pii.py`` uses
        when it puts a ``FakeGliner`` where the model goes, so the decision
        logic is testable in the model-free CI job.
        """
        if encoder is not None:
            self._encoder = encoder
        else:
            self._encoder.load(model_dir, max_tokens=max_tokens)
        if not self._encoder.ready:
            self._ready = False
            self._load_error = self._encoder.load_error or "encoder unavailable"
            self._anchor_vectors, self._anchor_ids, self._split = [], [], 0
            self._fingerprint = None
            return
        try:
            texts = _anchors.anchor_texts()
            vectors = self._encoder.encode(texts)
            if len(vectors) != len(texts):
                raise ValueError(
                    f"encoder returned {len(vectors)} vectors for {len(texts)} anchors"
                )
            self._anchor_vectors = vectors
            self._anchor_ids = _anchors.anchor_ids()
            self._split = _anchors.positive_count()
            self._ready = True
            self._load_error = None
            self._fingerprint = _anchors.bank_digest(
                (self._encoder.model_dir or "", str(len(vectors[0]) if vectors else 0)),
            )
            logger.info(
                "[Disclosure] anchor bank embedded: %d positive, %d negative, dim=%d",
                self._split,
                len(texts) - self._split,
                len(vectors[0]) if vectors else 0,
            )
        except Exception as exc:
            # An encoder that loaded but cannot embed our own sixteen sentences
            # is not an encoder we will trust with a customer's prompt.
            self._ready = False
            self._load_error = f"{type(exc).__name__}: {exc}"
            self._anchor_vectors, self._anchor_ids, self._split = [], [], 0
            self._fingerprint = None
            logger.error(
                "[Disclosure] anchor bank failed to embed: %s", exc, exc_info=True
            )

    # ── classification ───────────────────────────────────────────────────
    def _no_opinion(self, reason: str, segment_count: int = 0) -> dict:
        return {
            "disclosed": None,
            "similarity": None,
            "margin": None,
            "matched_anchor": None,
            "segments": segment_count,
            "degraded": True,
            "degraded_reason": reason,
            "engine_fingerprint": self._fingerprint,
        }

    def classify(
        self, text: str, *, floor: float, margin: float, max_chars: int
    ) -> dict:
        """One text → the verdict envelope the router returns verbatim."""
        if not self._ready:
            return self._no_opinion(self._load_error or "classifier_unavailable")
        body = text or ""
        if len(body) > max_chars:
            # Truncating and answering anyway would hide a disclosure that sits
            # past the cut and report "no disclosure" for it — the one direction
            # this classifier may not be wrong in. Refuse instead.
            return self._no_opinion("input_too_large")
        pieces = segments(body)
        if not pieces:
            return self._no_opinion("no_scannable_text")
        try:
            vectors = self._encoder.encode(pieces)
        except Exception as exc:
            logger.warning("[Disclosure] encode failed: %s", exc)
            return self._no_opinion("encode_failed", len(pieces))
        if len(vectors) != len(pieces):
            return self._no_opinion("encode_incomplete", len(pieces))

        pos_vecs, pos_ids = (
            self._anchor_vectors[: self._split],
            self._anchor_ids[: self._split],
        )
        neg_vecs, neg_ids = (
            self._anchor_vectors[self._split :],
            self._anchor_ids[self._split :],
        )

        # The text's verdict is its BEST segment's — a disclosure is one
        # sentence in a page of instructions, so the page's average says
        # nothing about whether that sentence is in it.
        best = None
        for vec in vectors:
            pos, pos_id = best_similarity(vec, pos_vecs, pos_ids)
            neg, neg_id = best_similarity(vec, neg_vecs, neg_ids)
            gap = pos - neg
            if best is None or gap > best[0]:
                best = (gap, pos, neg, pos_id, neg_id)

        gap, pos, neg, pos_id, neg_id = best
        answer = verdict(pos, neg, floor=floor, margin=margin)
        return {
            "disclosed": answer,
            "similarity": round(pos, 4),
            "margin": round(gap, 4),
            # Which of OUR sentences decided it. The winning bank's anchor, so
            # "why did this pass" and "why was this withdrawn" are both
            # answerable from the response without quoting the input.
            "matched_anchor": pos_id if answer else neg_id,
            "segments": len(pieces),
            "degraded": False,
            "degraded_reason": None,
            "engine_fingerprint": self._fingerprint,
        }


_service = DisclosureService()


def get_disclosure_service() -> DisclosureService:
    """FastAPI dependency / direct accessor."""
    return _service
