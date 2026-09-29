"""The tokenizer, and splitting a document into model-sized pieces.

GLiNER truncates in TOKEN space and prepends the label prompt, so a chunk's
real text budget is a property of the loaded tokenizer rather than a character
count. This module owns that tokenizer access (including the per-thread proxy
that makes concurrent passes safe), the budget arithmetic, and both chunkers —
the token-aware production path and the conservative character fallback.
"""

from __future__ import annotations

import threading
from typing import NamedTuple

# ── Chunking ───────────────────────────────────────────────────────────
# GLiNER (mDeBERTa) truncates inputs to config.max_len TOKENS (~384) and
# PREPENDS the label prompt, so a chunk's real TEXT budget is ~300-330 tokens.
# Chunking on CHARACTERS silently dropped the tail of every long chunk (1500
# Dutch chars ≈ 450+ tokens; number-dense text far more): entities past the
# token limit were never presented to the model, and the char-space overlap
# didn't help because truncation happens in TOKEN space. We now chunk on the
# model's own tokenizer (_chunk_text with the loaded tokenizer +
# _text_token_budget) and only fall back to this conservative CHAR limit when
# the tokenizer can't produce offset mappings. Overlap is sized ≥ the longest
# expected entity so a span straddling a boundary is fully contained in at
# least one chunk.
_CHUNK_CHAR_LIMIT = 900  # fallback only (used when tokenizer unavailable)
_CHUNK_OVERLAP = 100  # fallback char overlap
_FALLBACK_MAX_LEN = 384  # GLiNER mDeBERTa default when config.max_len is absent
_TOKEN_BUDGET_SAFETY = 16  # headroom below max_len for framing/special tokens
_MIN_TEXT_TOKEN_BUDGET = 64  # never size a token budget smaller than this
# Pre-trim margin for chunking oversize input (see _detect_raw). Sized far
# above any single chunk's char length (~349 tokens x a generous chars/token),
# so every chunk that can START before the scan budget is bit-identical whether
# the tokenizer saw the trimmed prefix or the whole document.
_PRETRIM_MARGIN_CHARS = 16_384
# Char fallback for a CUSTOM label group (see _ChunkBudget). Up to six
# admin-written prompts of 60 characters can be several times wider than the
# widest shipped group, and without a tokenizer there is no measuring it, so
# the fallback simply leaves a third more room than the shipped one does.
_CUSTOM_CHUNK_CHAR_LIMIT = _CHUNK_CHAR_LIMIT * 2 // 3


class _ChunkBudget(NamedTuple):
    """An override of the load-time chunking limits, for ONE label group.

    ``tokens``/``overlap`` drive the token chunker; ``tokens=None`` means the
    char fallback at ``char_limit``, which also applies whenever the token
    chunker itself falls back.
    """

    tokens: int | None
    overlap: int | None
    char_limit: int


class _ThreadLocalTokenizer:
    """One HF fast-tokenizer per thread, behind a single object identity.

    Why not a lock: ``transformers._set_truncation_and_padding`` MUTATES the
    Rust backend (``enable_truncation`` / ``enable_padding``) on every
    ``__call__`` that passes ``padding=``/``truncation=`` — and gliner's
    ``BaseProcessor.tokenize_inputs`` passes both. Two threads inside it raise
    ``RuntimeError("Already borrowed")``; upstream has not fixed it
    (huggingface/tokenizers#537, transformers#12658). Per-thread instances
    remove the sharing rather than serialising the entire model behind it.

    That distinction is the whole point: the borrow error was a TOKENIZER
    problem that we solved with a lock around INFERENCE. ORT's
    ``InferenceSession.Run()`` is documented thread-safe on the CPU EP and
    gliner's ORT wrapper holds only immutable session handles, so the lock was
    costing every forward pass for a hazard it did not sit on.

    Delegation is total on purpose. gliner calls ``len(tokenizer)`` and reads a
    dozen attributes; a partial proxy would fail at load time (loud, fine) or —
    far worse — silently return a different chunk boundary.
    """

    def __init__(self, factory):
        self._factory = factory
        self._local = threading.local()
        # Built eagerly so attribute reads on the loading thread work before any
        # worker exists, and so a broken factory fails at load, not mid-scan.
        self._prototype = factory()
        self._local.tok = self._prototype
        self._instances = 1

    @property
    def _tok(self):
        tok = getattr(self._local, "tok", None)
        if tok is None:
            tok = self._factory()
            self._local.tok = tok
            self._instances += 1
        return tok

    def __call__(self, *args, **kwargs):
        return self._tok(*args, **kwargs)

    def __len__(self):
        return len(self._prototype)

    def __contains__(self, item):
        return item in self._prototype

    def __getattr__(self, name):
        # Only reached for attributes this proxy does not define itself.
        return getattr(self._tok, name)


def _model_limits(model) -> tuple[object | None, int]:
    """Return ``(tokenizer, max_len)`` for a loaded GLiNER model.

    Robust to gliner version drift: reads ``config.max_len`` (falls back to
    384) and locates the underlying HF tokenizer via the known attribute
    paths. Returns ``tokenizer=None`` when none is found (→ char fallback).
    """
    max_len = _FALLBACK_MAX_LEN
    try:
        ml = getattr(getattr(model, "config", None), "max_len", None)
        if isinstance(ml, int) and ml > 0:
            max_len = ml
    except Exception:
        pass

    tokenizer = None
    for path in (("data_processor", "transformer_tokenizer"), ("tokenizer",)):
        obj = model
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None:
            tokenizer = obj
            break
    return tokenizer, max_len


def _supports_offsets(tokenizer) -> bool:
    """True when the tokenizer is a fast one that returns char offset mappings."""
    try:
        enc = tokenizer(
            "probe tekst", add_special_tokens=False, return_offsets_mapping=True
        )
        return bool(enc.get("offset_mapping"))
    except Exception:
        return False


def _overlap_tokens_for(budget: int) -> int:
    """Chunk overlap for a text budget: ~15%, at least 48, at most half."""
    return min(budget // 2, max(48, budget * 15 // 100))


def _label_prompt_width(tokenizer, labels: list[str]) -> int:
    """Tokens a label set puts in front of EVERY chunk it is asked about.

    The prompts themselves plus GLiNER's framing: one ``<<ENT>>`` marker per
    label and one ``<<SEP>>``. Unlike _label_prompt_tokens this counts the
    framing, so two label sets of different sizes compare honestly. Raises
    whatever the tokenizer raises; the callers decide the fallback.
    """
    ids = tokenizer(" ".join(labels), add_special_tokens=False)["input_ids"]
    return len(ids) + len(labels) + 1


def _label_prompt_width_max(tokenizer, label_groups: list[list[str]]) -> int:
    """The widest _label_prompt_width over the shipped groups. Same coarse
    guess as _label_prompt_tokens where the tokenizer cannot answer."""
    worst = 0
    for group in label_groups:
        try:
            width = _label_prompt_width(tokenizer, group)
        except Exception:
            width = len(group) * 4 + len(group) + 1
        worst = max(worst, width)
    return worst


def _label_prompt_tokens(tokenizer, label_groups: list[list[str]]) -> int:
    """Token length of the LARGEST label-group prompt (prepended to the text)."""
    worst = 0
    for group in label_groups:
        try:
            ids = tokenizer(" ".join(group), add_special_tokens=False)["input_ids"]
            worst = max(worst, len(ids))
        except Exception:
            worst = max(worst, len(group) * 4)  # coarse guess
    return worst


def _snap_boundary(text: str, start: int, end: int, min_end: int | None = None) -> int:
    """Move *end* back to a nearby sentence/whitespace boundary.

    Uses rfind so the cut lands as close to *end* as possible (minimal coverage
    loss). Never moves before *start*. Returns *end* unchanged if none found.

    ``min_end`` bounds how far back a snap may retreat, and it exists because
    the separator PRIORITY used to override PROXIMITY: the separators are
    tried best-first (". " over "\\n" over " "), each searched across the
    whole window — so one ". " early in a window otherwise made of short
    "Speaker (12:34): text.\\n" lines snapped the cut back near the window
    START. The next chunk then advanced by less than the overlap, and a
    52-minute meeting transcript exploded an 8,000-char window into 78 chunks
    (measured in production logs: ms=60931, chunks=78). With ``min_end`` set,
    a separator class that only matches unacceptably far back is skipped in
    favour of a nearer, humbler one — a newline five chars from the end beats
    a sentence break a thousand chars back.
    """
    floor = start + 1 if min_end is None else max(min_end, start + 1)
    for sep in (". ", "\n", " "):
        idx = text.rfind(sep, floor, end)
        if idx != -1:
            return idx + len(sep)
    return end


def _is_word_char(ch: str) -> bool:
    """Characters that may not be split through when extending to a word edge.

    Alphanumerics ONLY. A first version also counted `-` and `'`, on the theory
    that "Verbeek-Valk" is one name. It is, but the rule then also glues
    "Zeewolde" to "-Zuid" and every other hyphen-joined pair, widening spans
    for no detection benefit. It buys nothing either: subword splits — the thing
    this repairs — never land on a hyphen, because a SentencePiece tokenizer
    breaks INSIDE a word (e.g. "Theo|dorus") and hyphens are their own tokens.
    """
    return ch.isalnum()


def _snap_start_to_word(text: str, start: int, max_back: int = 40) -> int:
    """Move *start* back to the start of the word it lands inside.

    A chunk begins at a TOKEN index, and on a SentencePiece tokenizer that is a
    subword: a name such as "Theodorus" can split as Theo|dorus, so a chunk can
    open at "dorus" and the model — which only ever sees its own chunk — returns
    "dorus van der Brug" as a Person. Clipped names of that shape reached
    production (names here are illustrative), and nothing downstream could
    tell, because the span is internally consistent.

    Retreating is free: chunks already overlap, so a few extra leading
    characters add context and cannot lose coverage. Bounded so a pathological
    run of word characters (a base64 blob) cannot walk far.
    """
    limit = max(0, start - max_back)
    while start > limit and _is_word_char(text[start - 1]):
        start -= 1
    return start


def _token_index_at_char(offsets: list, char_pos: int) -> int:
    """First token index whose char-start is >= char_pos (binary search)."""
    lo, hi = 0, len(offsets)
    while lo < hi:
        mid = (lo + hi) // 2
        if offsets[mid][0] < char_pos:
            lo = mid + 1
        else:
            hi = mid
    return lo


def _chunk_text_chars(text: str, limit: int | None = None) -> list[tuple[int, str]]:
    """Conservative CHAR-based chunker — fallback when no tokenizer offsets.

    ``limit`` defaults to _CHUNK_CHAR_LIMIT, read at call time; a custom label
    group passes its narrower _CUSTOM_CHUNK_CHAR_LIMIT.
    """
    if limit is None:
        limit = _CHUNK_CHAR_LIMIT
    if len(text) <= limit:
        return [(0, text)]
    chunks: list[tuple[int, str]] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + limit, n)
        if end < n:
            # Same bounded snap as the token chunker — see _snap_boundary.
            end = _snap_boundary(
                text,
                start + _CHUNK_OVERLAP,
                end,
                min_end=end - limit * 15 // 100,
            )
        chunks.append((start, text[start:end]))
        if end >= n:
            break
        start = _snap_start_to_word(text, max(end - _CHUNK_OVERLAP, start + 1))
    return chunks


def _chunk_text_tokens(
    text: str,
    tokenizer,
    budget_tokens: int,
    overlap_tokens: int,
    char_limit: int | None = None,
) -> list[tuple[int, str]]:
    """Token-aware chunker: size to the model's real token budget.

    Tokenises the WHOLE text once (Rust-fast) with offset mapping, walks tokens
    into ``budget_tokens`` windows with ``overlap_tokens`` overlap, snaps the
    char boundary to a nearby separator, and slices VERBATIM so the returned
    char offset stays exact for the Node tokeniser. ``char_limit`` is the
    fallback's limit if the tokenizer fails (default: _CHUNK_CHAR_LIMIT).
    """
    try:
        enc = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
        offsets = enc["offset_mapping"]
    except Exception:
        return _chunk_text_chars(text, char_limit)

    n = len(offsets)
    if n <= budget_tokens:
        return [(0, text)]

    chunks: list[tuple[int, str]] = []
    # A snap may sacrifice at most ~15% of the window; a chunk must advance by
    # at least half the net step. Both bounds close the same measured failure
    # (see _snap_boundary): pathological snapping shrank the effective step to
    # ~30 tokens and a transcript window ballooned to 78 chunks / 61 seconds.
    min_advance = max(1, (budget_tokens - overlap_tokens) // 2)
    i = 0
    while i < n:
        j = min(i + budget_tokens, n)
        # Open on a WORD boundary, not a subword one — see _snap_start_to_word.
        char_start = _snap_start_to_word(text, offsets[i][0])
        char_end = offsets[j - 1][1]
        if j < n:
            span = char_end - char_start
            char_end = _snap_boundary(
                text,
                char_start,
                char_end,
                min_end=char_start + span - span * 15 // 100,
            )
        # Verbatim slice → offset arithmetic stays exact downstream.
        chunks.append((char_start, text[char_start:char_end]))
        if j >= n:
            break
        next_i = _token_index_at_char(offsets, char_end)
        i = max(next_i - overlap_tokens, i + min_advance)
    return chunks


def _chunk_text(
    text: str,
    tokenizer=None,
    budget_tokens: int | None = None,
    overlap_tokens: int | None = None,
    char_limit: int | None = None,
) -> list[tuple[int, str]]:
    """Split *text* into (char_offset, verbatim_chunk) tuples.

    Token-aware when a tokenizer + budget are supplied (the production path);
    otherwise a conservative char fallback (tests / degraded tokenizer) at
    ``char_limit`` (default: _CHUNK_CHAR_LIMIT).
    """
    if tokenizer is not None and budget_tokens:
        return _chunk_text_tokens(
            text,
            tokenizer,
            budget_tokens,
            overlap_tokens or max(48, budget_tokens // 6),
            char_limit,
        )
    return _chunk_text_chars(text, char_limit)
