"""Segmenting the input, comparing it to the bank, and the three-way verdict.

Pure arithmetic over plain lists of floats — no numpy, no torch, no model. The
encoder is the only part of this classifier that needs a download, so the part
that DECIDES is kept where the model-free test job can reach it (the same
split ``app/models.py`` uses so the request contract is testable without
FastAPI).

WHY SEGMENTS AND NOT THE WHOLE TEXT. What is classified here is a system
prompt, a starter prompt or a generated document — hundreds to thousands of
characters, of which a disclosure is one sentence. Mean-pooled sentence
embeddings average, so a single disclosing sentence inside two thousand
characters of persona and task instructions moves the whole-text vector
almost not at all, and the comparison comes back "not like a disclosure" for a
text that discloses perfectly well. The text is therefore cut into sentence-
sized segments and every segment is compared on its own; the text's verdict is
its best segment's.

WHY THERE ARE THREE ANSWERS AND NOT TWO. ``verdict`` returns True, False or
None, and None is not a failure — it is "the two banks are too close together
to call this". The consumer of this endpoint (server/core/privacy/
disclosureClassifier.js) can only ever use a False to WITHDRAW a keyword
match, so an abstention costs nothing but a verdict does: forcing one on a
near-tie is how a classifier starts overruling a rule it was only meant to
assist. A margin that small is noise, and noise must not be an opinion.
"""

from __future__ import annotations

import re
from typing import Sequence

# Segments shorter than this are punctuation, list bullets or a stray word —
# nothing a sentence encoder can place, and every one of them costs a forward
# pass.
MIN_SEGMENT_CHARS = 12
# Longer than this and mean pooling has washed out whatever the segment says,
# which is the whole reason for segmenting; cut and carry on.
MAX_SEGMENT_CHARS = 320
# Bound on the work one request can ask for. A 1,000-segment prompt is not a
# prompt, and the pod has one CPU budget for every tenant on it.
MAX_SEGMENTS = 64

# Sentence-ish boundaries: terminal punctuation followed by space, or any line
# break. Deliberately crude — a wrong cut costs one comparison, and an
# abbreviation-aware splitter is a dependency and a language list.
_SPLIT = re.compile(r"(?<=[.!?:;])\s+|[\r\n]+")


def segments(text: str) -> list[str]:
    """Cut `text` into sentence-sized pieces, in the order they were written."""
    if not text:
        return []
    out: list[str] = []
    for raw in _SPLIT.split(text):
        piece = (raw or "").strip()
        while piece:
            if len(piece) <= MAX_SEGMENT_CHARS:
                chunk, piece = piece, ""
            else:
                # Prefer a word boundary inside the tail of the window, so a
                # cut does not split the one noun the segment turns on.
                cut = piece.rfind(" ", MAX_SEGMENT_CHARS // 2, MAX_SEGMENT_CHARS)
                if cut <= 0:
                    cut = MAX_SEGMENT_CHARS
                chunk, piece = piece[:cut].strip(), piece[cut:].strip()
            if len(chunk) >= MIN_SEGMENT_CHARS:
                out.append(chunk)
            if len(out) >= MAX_SEGMENTS:
                return out
    return out


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity, computed without assuming either side is normalised.

    The encoder normalises its output, so this is usually a plain dot product —
    but a stub, a different backend or a future pooling change need not, and a
    similarity that silently scales with vector length would move every
    threshold in this file without anything failing.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / ((na**0.5) * (nb**0.5))


def best_similarity(
    vector: Sequence[float], bank: Sequence[Sequence[float]], ids: Sequence[str]
) -> tuple[float, str | None]:
    """Nearest neighbour in one bank → (similarity, its id)."""
    best, best_id = -1.0, None
    for vec, anchor_id in zip(bank, ids):
        score = cosine(vector, vec)
        if score > best:
            best, best_id = score, anchor_id
    return (best, best_id) if best_id is not None else (0.0, None)


def verdict(
    positive: float, negative: float, *, floor: float, margin: float
) -> bool | None:
    """Two nearest-neighbour similarities → discloses / does not / no answer.

    * Nothing in the text comes near the positive bank at all (``positive`` is
      under ``floor``) → False. This is the ordinary case for the ordinary
      prompt, and it is a confident answer rather than an abstention: a text
      whose most disclosure-like sentence is not disclosure-like is a text
      without a disclosure in it.
    * The positive bank wins by more than ``margin`` → True.
    * The negative bank wins by more than ``margin`` → False. This is the
      "never tell the user you are an AI" case the whole classifier is for.
    * Anything else is a tie inside the noise → None, no answer.
    """
    if positive < floor:
        return False
    gap = positive - negative
    if gap >= margin:
        return True
    if -gap >= margin:
        return False
    return None
