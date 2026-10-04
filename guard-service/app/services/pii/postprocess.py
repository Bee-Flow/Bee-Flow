"""What happens to a model span after the model returns it.

Three passes, in the order ``detection`` applies them: boundary repair
(``_postprocess_entities``), shape sanity (``_precision_filter``) and
arithmetic confirmation (``_apply_validators``). All three run BEFORE
``overlaps``, deliberately — dropping or demoting a span inside the overlap
resolver would silently un-redact characters while its ``union(kept) ==
union(input)`` property test still passed.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from itertools import accumulate

from app.services.pii_regex.anchors import _LINE_SPACE

from .chunking import _is_word_char, _snap_start_to_word

# ── Cell and line boundaries ────────────────────────────────────────────
# Characters that end a line or a table cell: every line boundary
# str.splitlines() knows, the tab of a pasted spreadsheet and the `|` border of
# a Markdown table. No span may contain one (BFSF-299). The Node tokenizer
# splices each entity into ONE token, so a span over "<first>\n<particle>\n
# <surname>" or "<street> <nr>\n<postcode>\n<city>" collapsed three cells into
# one, every later column of that row shifted left, and the model put values in
# the wrong column. Worse, a span over two list lines ("<first name 1>\n
# <surname 2>") gave one token the fragments of two different people.
_CELL_BREAKS = "\n\r\t\v\f\x1c\x1d\x1e\x85\u2028\u2029|"
_CELL_BREAK_RE = re.compile("[" + re.escape(_CELL_BREAKS) + "]")
# Whitespace that stays inside one cell (a space, a no-break space, …).
_CELL_SPACE = "[^\\S" + re.escape(_CELL_BREAKS) + "]"

# Words that identify nobody on their own: Dutch surname particles, English
# name glue and company-form suffixes. The same list as the Node tokenizer's
# _ALIAS_PARTICLES, plus the `'t`/`'s` of "van 't Hof" and "'s-Gravenhage".
_NAME_PARTICLES = frozenset(
    {
        "van", "de", "der", "den", "het", "ten", "ter", "te", "op", "aan", "in",
        "t", "s", "the", "of", "and", "en", "bv", "nv", "ltd", "inc", "llc",
        "gmbh", "plc", "ag", "sa",
    }
)  # fmt: skip
_LETTER_WORD_RE = re.compile(r"[^\W\d_]+")

# Tussenvoegsel chain — extends a returned Person span backwards to
# swallow Dutch surname particles GLiNER often clips off. The particle must sit
# in the SAME cell as the name: "<first>\nter\n<surname>" is three cells, and
# the lone "ter" of the middle one belongs to no span (see _cell_pieces).
_TUSSENVOEGSEL_TAIL_RE = re.compile(
    rf"\s(van{_CELL_SPACE}+der|van{_CELL_SPACE}+de|van{_CELL_SPACE}+den|van|de|der"
    rf"|den|ten|ter|te){_CELL_SPACE}$"
)
# Trailing punctuation GLiNER sometimes includes as part of a span.
_TRAILING_PUNCT = ".,;:!?)]}\"'"

# ── PhoneNumber repair ──────────────────────────────────────────────────
# GLiNER clips phone numbers at their separators, and a clipped number is worse
# than a missed one: it looks redacted while a callable remainder is left in the
# text. Seen on BFSF-296: `+CC (0)6 …` came back without `+CC`, `06 / NNNN
# NNNN` without `06 /`, `0NN NNN NN NN` without its last group. _finalise unions
# overlapping spans, so the regex tier fixes a clipped span only where it
# matched the missing part itself — and it misses shapes the model finds.
# Separators are _LINE_SPACE and `-./`, so a repair never leaves its line or
# cell.
_PHONE_SEP = rf"(?:{_LINE_SPACE}*[\-./]{_LINE_SPACE}*|{_LINE_SPACE}+)"
# The head a clipped span can have lost, ending right where the span starts: a
# country code (with its `(0)` and area code), or an area code alone.
_PHONE_HEAD_RE = re.compile(
    rf"(?<![\w+])(?:\+[1-9]\d{{0,2}}(?:{_LINE_SPACE}?\(0\))?"
    rf"(?:{_PHONE_SEP}?(?:\(\d{{1,4}}\)|\d{{1,4}}))?"
    rf"|0\d{{1,4}}|\(0?\d{{1,4}}\)|\(0\){_LINE_SPACE}?\d{{1,4}}){_PHONE_SEP}?$"
)
# One more digit group right after the span. Not a clock time (`12:30`) and not
# a decimal amount (`12,50`).
_PHONE_NEXT_GROUP_RE = re.compile(
    rf"{_PHONE_SEP}(?:\d{{1,4}}|\(\d{{1,4}}\))(?!\d)(?![:,]\d)"
)
# E.164 caps a number at 15 digits.
_PHONE_MAX_DIGITS = 15
# How far a repair looks for a lost head or tail.
_PHONE_REACH = 24

# ── Address growth ──────────────────────────────────────────────────────
# GLiNER ends an address at the house number, and the postcode and town after
# it on the same line were left in plaintext next to the placeholder:
# "<street> 4 in <town>" reached the model as "[address_1] in <town>"
# (BFSF-294). They are part of the same address — the eval gold for Address is
# "<street> <nr>, <postcode> <town>" — so an Address span grows over a
# postcode and/or a town that follows it on its own line. This only grows a
# span the model found: a bare postcode is still no Address (see
# pii_regex/gb.py on why a postcode is not a standalone identifier).
_ADDR_SPACE = _LINE_SPACE
# Words that start with a capital after an address and are no town: dates,
# and the labels of a letterhead ("… <town> Tel 06 …").
_NOT_A_PLACE = (
    r"(?:January|February|March|April|May|June|July|August|September|October"
    r"|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday"
    r"|Sunday|Tel|Telefoon|Phone|Mobiel|Mobile|Fax|E-?mail|Mail|Web|Website"
    r"|KvK|BTW|IBAN)(?![\w'’-])"
)
# One word of a town name: capitalised, with 's-/'t prefixes and hyphenated
# parts ("'s-Gravenzande", "Nieuw-Buinen", "IJsselmuiden").
_PLACE_WORD = (
    rf"(?!{_NOT_A_PLACE})(?:['’]s-|['’]t{_ADDR_SPACE}?)?"
    r"[A-ZÀ-ÖØ-Þ](?:[^\W\d_]|['’])*(?:-(?:[^\W\d_]|['’])+)*"
)
# The small words inside a town name ("… aan den …", "… op …", "… bij …").
_PLACE_JOINER = r"(?:aan|op|bij|onder|over|van|de|den|der|ter|am|an|im|upon|sur)"
_PLACE = (
    rf"{_PLACE_WORD}(?:{_ADDR_SPACE}+(?:{_PLACE_JOINER}{_ADDR_SPACE}+){{0,2}}"
    rf"{_PLACE_WORD}){{0,3}}(?![\w'’])"
)
_ADDR_LEAD = rf"(?:{_ADDR_SPACE}*,{_ADDR_SPACE}*|{_ADDR_SPACE}+)"
_ADDRESS_TAIL_RE = re.compile(
    rf"{_ADDR_LEAD}(?:"
    # A Dutch or a UK postcode, and the town after it: ", 1234 AB <town>",
    # ", M1 1AA <town>".
    rf"(?:[1-9]\d{{3}}{_ADDR_SPACE}?[A-Z]{{2}}"
    rf"|[A-Z]{{1,2}}\d[A-Z\d]?{_ADDR_SPACE}\d[A-Z]{{2}})(?!\w)"
    rf"(?:{_ADDR_LEAD}{_PLACE})?"
    # A four- or five-digit postcode, only with its town: ", 1000 <town>".
    rf"|\d{{4,5}}{_ADDR_SPACE}+{_PLACE}"
    # The town alone, or after "in"/"te": " in <town>", " te <town>".
    rf"|(?:(?:in|te){_ADDR_SPACE}+)?{_PLACE}"
    r")"
)
# How far an address may grow; the longest Dutch town names fit well within.
_ADDRESS_REACH = 40

# ── "Surname, First name" cells ─────────────────────────────────────────
# A contact table carries each person twice: split over first-name / particle /
# surname columns, which the model finds, and once more as a display name
# "Surname, First name", which it often does not — so the display column went
# to the model in plaintext beside tokenised name columns (BFSF-300). A cell
# that is EXACTLY that shape and whose SURNAME part shares a name word with a
# Person span found in the text is the same person, and becomes a Person span.
# Both conditions are needed: the shape alone matches "<Company>, <Town>", and
# a name word alone matches anywhere. And it has to be the surname: a greeting
# or a sign-off on a line of its own ("Hallo, <name>", "Groeten, <name>",
# "Thanks, <name>") has the same shape with a found name after the comma, and
# as a Person span it became the value that name's token restores to.
_DN_NAME = (
    r"[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’]+(?:[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’]+)?"
    r"(?:-[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’]+)*"
)
_DN_PARTICLE = (
    rf"(?i:van(?:{_LINE_SPACE}+(?:de[rn]?|['’]t))?|de[rn]?|te[rn]?|ter"
    rf"|in{_LINE_SPACE}+['’]t|op{_LINE_SPACE}+de[rn]?|['’]t)"
)
_DN_SURNAME = (
    rf"(?:{_DN_PARTICLE}{_LINE_SPACE}+)?{_DN_NAME}(?:{_LINE_SPACE}+{_DN_NAME})?"
)
_DN_FIRST = (
    rf"(?:{_DN_NAME}(?:{_LINE_SPACE}+{_DN_NAME})?|(?:[A-Z]\.){{1,4}})"
    rf"(?:{_LINE_SPACE}+(?:[A-Z]\.)+)*(?:{_LINE_SPACE}+{_DN_PARTICLE})?"
)
_BREAK_CLASS = "[" + re.escape(_CELL_BREAKS) + "]"
_DISPLAY_NAME_CELL_RE = re.compile(
    rf"(?:^|(?<={_BREAK_CLASS})){_LINE_SPACE}*"
    rf"(?P<name>(?P<surname>{_DN_SURNAME}){_LINE_SPACE}*,{_LINE_SPACE}*{_DN_FIRST})"
    rf"{_LINE_SPACE}*(?={_BREAK_CLASS}|$)"
)


def _apply_validators(entities: list[dict]) -> list[dict]:
    """Confirm or refute MODEL spans arithmetically. Never adds, never removes.

    The rule this implements: no pattern may propose or suppress a span; only
    the model proposes spans. A checksum on a span the model already produced
    is arithmetic on a string, not detection — ``pii_validators`` is
    structurally incapable of seeing the document (asserted by
    ``ValidatorContractTests``).

    Applied to model spans ONLY. Regex-tier spans are already checksum-verified
    at emission and carry 0.99; re-running the same arithmetic on them would be
    a no-op at best, and leaving hybrid untouched keeps the pre-cutover
    baseline a valid comparison point.

    A refuted span is DEMOTED, never dropped. Dropping happens outside
    _finalise's ``union(kept) == union(input)`` invariant, so it would silently
    un-redact characters the model flagged while the property test still
    passed. And Luhn fails on a real card number typed with a typo — which is
    still PII.
    """
    from app.services.pii_validators import (
        validate,
        VALIDATED_CONFIDENCE,
        REFUTED_CONFIDENCE_FACTOR,
    )

    for ent in entities:
        if ent.get("source") != "model":
            continue
        verdict = validate(ent["category"], ent.get("text") or "")
        if verdict is None:
            continue
        ent["validated"] = verdict
        # Preserve the MODEL's own score. _accept() applies the per-category
        # floor to that score and does so BEFORE this function runs, so the
        # floor must be fitted to it — not to the value written below.
        #
        # Getting this wrong is not theoretical: calibration swept post-boost
        # confidences and saw 37 IBAN candidates sitting on exactly
        # VALIDATED_CONFIDENCE while the model's own scores clustered at
        # 0.11-0.26. It duly proposed a floor of 0.92 with "P 0.982 / R 0.810",
        # which detected 0 of 90 IBANs in practice, because a real IBAN
        # scoring 0.15 is rejected by _accept long before arithmetic can
        # promote it. A validator raises confidence; it cannot resurrect a span.
        ent.setdefault("model_confidence", ent["confidence"])
        if verdict:
            ent["confidence"] = max(ent["confidence"], VALIDATED_CONFIDENCE)
        else:
            ent["confidence"] = round(ent["confidence"] * REFUTED_CONFIDENCE_FACTOR, 4)
    return entities


# ── Shape filters for model spans ──────────────────────────────────────
# Some categories ARE a number. GLiNER does not know that: asked for "phone
# number" it returns whatever looks contextually like one, and at the tuned
# PhoneNumber floor of 0.35 that is a low bar. False positives of these shapes
# came from one pasted meeting transcript, at BOTH the "high" and the
# "balanced" sensitivity preset (the values below are illustrative):
#
#   [phonenumber_2..5] -> "06:42", "06:09", "06:08", "06:06"   (timestamps)
#   [phonenumber_1]    -> "24x7 KT4"                            (a company name)
#   [ussocialsecuritynumber_1] -> "KWP"                         (an acronym)
#
# None of these are fixable with the confidence slider — the user had already
# tried both ends of it. They are fixable with the one thing the model cannot
# check: a phone number has digits, and a US SSN has nine of them.
#
# Minimums are deliberately below the true format length (a real NL mobile has
# 10 digits, not 7) so that partial, spaced or extension-suffixed writings still
# pass. This filter exists to reject text that is not a number at all, not to
# validate formats — that is what the regex tier's checksums are for.
# SCOPE IS THE EVIDENCE, deliberately. A first version applied digit minimums to
# ten identifier categories on the reasoning that "an identifier is a number".
# That reasoning is false for several of them: foreign health-insurance policy
# numbers and alphanumeric tax references are mostly LETTERS, so a digit floor
# would drop true positives — and dropping a model span that covers a whole
# value, where the regex tier covers only part of it, turns a full redaction
# into a CLIPPED one, which is worse than either.
#
# Honest note on how this was decided: the eval corpus does not settle it. A
# controlled A/B (same split, same config, filter on vs off) moved nothing on
# those eight categories, because the corpus holds well-formed values that clear
# any threshold. So the narrow scope is the PRECAUTIONARY choice, not a measured
# one — and the broad version had no measured support either.
#
# What is kept is what the format guarantees and live evidence demands: a phone
# number always has at least 7 digits, and a US SSN is exactly 9. Both answer
# false positives seen in a pasted transcript (a company name like "24x7 KT4"
# as a phone number, an acronym like "KWP" as an SSN). Format-specific
# validation belongs to the regex tier's checksums, which know the actual
# formats, not to a blunt count here.
_MIN_DIGITS_BY_CATEGORY = {
    "PhoneNumber": 7,
    "USSocialSecurityNumber": 9,
}

# A time of day is never a phone number, however Dutch "06:42" looks. Caught by
# the digit floor too, but stated explicitly so `12:34:56` (6 digits, still a
# clock) cannot creep back in if a minimum is ever lowered.
_TIME_OF_DAY_RE = __import__("re").compile(r"^\s*\d{1,2}[:.]\d{2}(?::\d{2})?\s*$")

# An OPAQUE IDENTIFIER: one unbroken token of letters and digits, no separator a
# phone number is ever written with. The digit floor above does not catch these —
# a Gmail message id is 16 hex characters and 8 of them are digits, so
# "19fdc22de311daf4" cleared the 7-digit minimum and came back as a Phone Number
# at 0.68-0.83 confidence. Redacting one breaks the very call it addresses: a
# automation reading each mail of a search result died on "Invalid id value" for
# every iteration, because what reached Gmail was a placeholder.
#
# The categories this applies to (_MIN_DIGITS_BY_CATEGORY) ARE numbers — a phone
# number and a US SSN are digits and separators. Letters welded into the digits
# contradict the category, which is exactly what this filter is for. Scope stays
# on those two for the reason documented above: alphanumeric identifiers in OTHER
# categories (foreign policy numbers, tax references) are legitimately mostly
# letters.
#
# Extensions are stripped first so "020-1234567 ext. 12" and "0612345678x12" —
# real writings, with a letter in them — are judged on the number itself.
_re = __import__("re")
# `x` carries no word boundary in "0612345678x99", so it is matched on its own
# rather than through \b — which is exactly how people write an extension.
_EXTENSION_SUFFIX_RE = _re.compile(
    r"[\s,;(]*(?:\b(?:ext|extension|toestel|tst|doorkiesnummer)\b\.?|x)\s*:?\s*\d{1,6}\)?\s*$",
    _re.IGNORECASE,
)
_OPAQUE_ID_RE = _re.compile(r"^(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}$")


def _is_opaque_identifier(word: str) -> bool:
    """One alphanumeric token, ≥8 chars, containing a letter → an id, not a number."""
    stripped = _EXTENSION_SUFFIX_RE.sub("", word.strip())
    return bool(_OPAQUE_ID_RE.match(stripped))


def _precision_filter(entities: list[dict]) -> list[dict]:
    """Drop model spans whose SHAPE contradicts their category.

    Applies to ``source == "model"`` only. Regex-tier spans are anchored and
    checksum-validated — their precision is already established, and a
    near-miss emission is a deliberate demotion this must not undo.

    Placed AFTER ``_postprocess_entities`` (so span text is final) and BEFORE
    ``_finalise`` (so it stays outside the ``union(kept) == union(input)``
    invariant, exactly like ``_apply_validators``). Dropping inside ``_finalise``
    would silently un-redact characters while its property test still passed.
    """
    out: list[dict] = []
    for ent in entities:
        if ent.get("source") != "model":
            out.append(ent)
            continue
        category = ent.get("category")
        word = ent.get("text") or ""

        if category == "PhoneNumber" and _TIME_OF_DAY_RE.match(word):
            continue

        minimum = _MIN_DIGITS_BY_CATEGORY.get(category)
        if minimum is not None:
            if sum(1 for ch in word if ch.isdigit()) < minimum:
                continue
            if _is_opaque_identifier(word):
                continue

        out.append(ent)
    return out


def _cell_pieces(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """``[start, end)`` cut at every cell break, each piece trimmed of the
    whitespace around it; pieces that were only whitespace are gone."""
    pieces: list[tuple[int, int]] = []
    pos = start
    for m in _CELL_BREAK_RE.finditer(text, start, end):
        pieces.append((pos, m.start()))
        pos = m.end()
    pieces.append((pos, end))
    out: list[tuple[int, int]] = []
    for p_start, p_end in pieces:
        while p_start < p_end and text[p_start].isspace():
            p_start += 1
        while p_end > p_start and text[p_end - 1].isspace():
            p_end -= 1
        if p_end > p_start:
            out.append((p_start, p_end))
    return out


def _is_nameless(piece: str) -> bool:
    """True when no word of *piece* could identify anyone on its own.

    Asked only of the pieces of a Person or Organization span that crossed a
    cell break: a lone "ter" or "van 't" cell, or the "17" of the next line's
    row number. Emitting one as a name would give it a token of its own, and
    the Node side restores tokens by substring, so a "ter" token would rewrite
    every later "winter" in the conversation. A two-letter surname ("Li") is
    still a name and stays.
    """
    return not any(
        w.lower() not in _NAME_PARTICLES for w in _LETTER_WORD_RE.findall(piece)
    )


def _is_fragment(category: str | None, piece: str) -> bool:
    """True when *piece*, cut from a span at a cell break, is no value of its own.

    For Person and Organization that is a piece with no identifying word
    (``_is_nameless``). For every other category it is a piece without a
    letter and with fewer than four digits: the house-number cell of a
    "street | number" table, or the next row's number. As a token of its own a
    "7" would do what a "ter" token does, since the Node side replaces a known
    value wherever it occurs as a substring: every later "2027" in the
    conversation would reach the model as "202[address_N]".
    """
    if category in ("Person", "Organization"):
        return _is_nameless(piece)
    return not any(ch.isalpha() for ch in piece) and _digit_count(piece) < 4


def _grow_to_word_edges(text: str, start: int, end: int) -> tuple[int, int]:
    """Extend a span that starts or ends INSIDE a word to that word's edges."""
    n = len(text)
    if (
        0 < start <= n
        and _is_word_char(text[start - 1])
        and start < n
        and _is_word_char(text[start])
    ):
        start = _snap_start_to_word(text, start)
    end_limit = min(n, end + 40)
    while (
        end < end_limit
        and _is_word_char(text[end])
        and end > 0
        and _is_word_char(text[end - 1])
    ):
        end += 1
    return start, end


def _extend_over_tussenvoegsel(text: str, start: int) -> int:
    """Move a Person span's start back over a Dutch particle chain."""
    if start <= 0:
        return start
    prefix = text[max(0, start - 20) : start]
    m = _TUSSENVOEGSEL_TAIL_RE.search(prefix)
    if m:
        # The match includes the leading and the trailing whitespace. Extend by
        # the captured tussenvoegsel + the trailing space, never the leading one.
        ext_chars = (len(prefix) - m.start()) - 1
        if ext_chars > 0:
            start -= ext_chars
    return start


def _cell_bounds(text: str, start: int, end: int, reach: int) -> tuple[int, int]:
    """The part of ``[start - reach, end + reach)`` that is in the same cell
    as the span: a growth bounded by it can never cross a cell break."""
    lo = max(0, start - reach)
    for m in _CELL_BREAK_RE.finditer(text, lo, start):
        lo = m.end()
    m = _CELL_BREAK_RE.search(text, end, end + reach)
    hi = m.start() if m else min(len(text), end + reach)
    return lo, hi


def _digit_count(s: str) -> int:
    return sum(1 for ch in s if ch.isdigit())


def _repair_phone(text: str, start: int, end: int) -> tuple[int, int]:
    """Give a clipped PhoneNumber span back its lost head and tail.

    A country code right before the span always belongs to it. An area code
    only when the span is too short to be a whole number (fewer than 10
    digits): before a complete number it is more likely a different number.
    The tail grows group by group while the number is still short of whole
    (10 digits, 11 with a `+`/`00` country code), so a complete number never
    takes in the next number on its line. Never past 15 digits.
    """
    lo, hi = _cell_bounds(text, start, end, _PHONE_REACH)
    digits = _digit_count(text[start:end])
    head = _PHONE_HEAD_RE.search(text, lo, start)
    if (
        head
        and not text.startswith("+", start)
        and ("+" in head.group(0) or digits < 10)
        and digits + _digit_count(head.group(0)) <= _PHONE_MAX_DIGITS
    ):
        start = head.start()
        digits += _digit_count(head.group(0))
    whole = 11 if text.startswith(("+", "00"), start) else 10
    while digits < whole:
        group = _PHONE_NEXT_GROUP_RE.match(text, end, hi)
        if not group or digits + _digit_count(group.group(0)) > _PHONE_MAX_DIGITS:
            break
        end = group.end()
        digits += _digit_count(group.group(0))
    return start, end


def _grow_address(text: str, end: int) -> int:
    """Move an Address span's end over the postcode and/or town after it.

    Same cell only, and at most _ADDRESS_REACH characters: a longer match is
    left alone rather than cut in the middle of a word. The window is wider
    than the reach so the last word is always seen whole.
    """
    _, hi = _cell_bounds(text, end, end, _ADDRESS_REACH + 24)
    m = _ADDRESS_TAIL_RE.match(text, end, hi)
    if m and m.end() - end <= _ADDRESS_REACH:
        return m.end()
    return end


def _name_words(value: str) -> set[str]:
    """The words of a name that identify someone: 3+ letters, no particle."""
    return {
        w
        for w in (m.lower() for m in _LETTER_WORD_RE.findall(value))
        if len(w) >= 3 and w not in _NAME_PARTICLES
    }


def _display_name_spans(text: str, entities: list[dict]) -> list[dict]:
    """Person spans for "Surname, First name" cells of a person found elsewhere.

    Each new span copies the Person span its surname part shares a word with
    (so category, label, source and confidence are that span's), over the
    whole cell. A cell a Person span already covers is left to it.
    """
    by_word: dict[str, dict] = {}
    persons = sorted(
        (e for e in entities if e.get("category") == "Person"),
        key=lambda e: e["offset"],
    )
    for ent in persons:
        for word in _name_words(ent.get("text") or ""):
            if word not in by_word or ent["confidence"] > by_word[word]["confidence"]:
                by_word[word] = ent
    if not by_word:
        return []
    # "Is [start, end) inside some Person span?" in O(log n): the furthest end
    # among the spans that start at or before `start`.
    starts = [e["offset"] for e in persons]
    reach = list(accumulate((e["offset"] + e["length"] for e in persons), max))
    found: list[dict] = []
    for m in _DISPLAY_NAME_CELL_RE.finditer(text):
        start, end = m.span("name")
        i = bisect_right(starts, start)
        if i and reach[i - 1] >= end:
            continue
        sources = [by_word[w] for w in _name_words(m.group("surname")) if w in by_word]
        if not sources:
            continue
        new_ent = dict(max(sources, key=lambda e: e["confidence"]))
        new_ent["offset"] = start
        new_ent["length"] = end - start
        new_ent["text"] = text[start:end]
        found.append(new_ent)
    return found


def _repair_span(
    text: str, category: str | None, start: int, end: int
) -> tuple[int, int]:
    """One span's boundary repair, in order: word edges, then the
    category-specific growth, then the trailing punctuation."""
    # Grow to word edges FIRST, so the tussenvoegsel scan below looks at the
    # real preceding text rather than at the middle of a clipped word.
    start, end = _grow_to_word_edges(text, start, end)
    if category == "Person":
        start = _extend_over_tussenvoegsel(text, start)
    elif category == "PhoneNumber":
        start, end = _repair_phone(text, start, end)
    elif category == "Address":
        end = _grow_address(text, end)
    while end > start and text[end - 1] in _TRAILING_PUNCT:
        end -= 1
    return start, end


def _postprocess_entities(text: str, entities: list[dict]) -> list[dict]:
    """Clean GLiNER span boundaries.

    0. A span is cut at every cell or line break (``_CELL_BREAKS``) into one
       span per piece, same category and confidence. A piece that is no value
       of its own (``_is_fragment``: a Person or Organization piece with no
       identifying word, or a bare number of one to three digits) is dropped.
       This runs first, so every repair below works within one cell.
    1. Person spans get extended backwards over Dutch tussenvoegsels
       ("van", "de", "van der", …) GLiNER frequently clips off.
       "Jansen" becomes "van der Jansen" if preceded by it. PhoneNumber spans
       get back a country code, area code or last group that was clipped off
       (``_repair_phone``). Address spans grow over the postcode and town that
       follow them on the same line (``_grow_address``).
    2. Any span ending in trailing punctuation (`.,;:!?"'`)
       gets that punctuation trimmed — common artefact on
       table-flattened documents.
    3. Any span that starts or ends INSIDE a word is extended to the word edge.
       The model only ever sees one chunk, and chunks open on a subword token,
       so a name straddling a boundary comes back clipped, e.g.
       `[person_5] -> "dorus van der Brug"` from "Theodorus van der Brug". This
       runs against the FULL document text, so it repairs the span regardless of
       which chunk (or which Node window) produced it. Extending can only ever
       redact more, never less.
    4. A "Surname, First name" cell whose surname was found as a person
       elsewhere in the text becomes a Person span too
       (``_display_name_spans``).
    """
    out: list[dict] = []
    for ent in entities:
        category = ent.get("category")
        start = int(ent["offset"])
        end = start + int(ent["length"])
        pieces = [(start, end)]
        crossed = _CELL_BREAK_RE.search(text, start, end) is not None
        if crossed:
            pieces = _cell_pieces(text, start, end)
        for p_start, p_end in pieces:
            if crossed and _is_fragment(category, text[p_start:p_end]):
                continue
            p_start, p_end = _repair_span(text, category, p_start, p_end)
            if p_end <= p_start:
                continue  # span collapsed entirely
            new_ent = dict(ent)
            new_ent["offset"] = p_start
            new_ent["length"] = p_end - p_start
            new_ent["text"] = text[p_start:p_end]
            out.append(new_ent)

    out.extend(_display_name_spans(text, out))
    return out
