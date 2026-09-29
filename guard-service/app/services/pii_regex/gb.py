"""The United Kingdom: NINO, the NHS number with its mod-11 check, current
vehicle registrations, the DVLA licence and the passport shape.

Ported from Presidio 2.2.364 (MIT) — patterns, context words and the NHS
checksum. See guard-service/tools/presidio_upstream.json for the exact
upstream blobs and `python -m tools.check_presidio_drift` to detect changes.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _HEALTH_INS_ANCHOR_WORDS

# GB was the largest measured gap: recall 0.397 with no GB pattern at all, on a
# corpus that already contains NINO- and plate-shaped values.
#
# NINO. Two letters, six digits, a final A-D. The letter alphabets are
# position-specific (no D/F/I/Q/U/V first, additionally no O second) and seven
# prefixes are never issued, which together make the shape distinctive enough to
# stand without an anchor. There is no check digit — a NINO simply has none —
# so it does NOT claim the category: GLiNER keeps running for GB national IDs.
_GB_NINO_RE = re.compile(
    r"\b(?!BG|GB|NK|KN|NT|TN|ZZ)"
    r"[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?"
    r"\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b"
)

# NHS number. Ten digits with a mod-11 check — but ten digits is also an order
# number, a phone number and a Dutch bank account, and the checksum admits 9.2%
# of random runs (measured). Broad shape + weak check = anchor required; see
# _ANCHOR_GAP and the precision-budget test.
_GB_NHS_RE = re.compile(r"\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b")
_GB_NHS_ANCHOR_RE = re.compile(
    r"\b(?:" + _HEALTH_INS_ANCHOR_WORDS + r")" + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Vehicle registration, CURRENT (2001+) format only: two area letters, a
# two-digit age identifier, three random letters. Upstream also ships the prefix
# (1983-2001) and suffix (1963-1983) formats at confidence 0.2 and 0.15 — those
# are "letter, up to three digits, three letters", which matches far too much
# ordinary text to carry at our precision bar, so they are deliberately not
# ported. The age identifier is restricted to the ranges actually issued
# (02-29 March, 51-79 September), folded into the pattern rather than kept as a
# separate validator — same effect, one less place to drift.
_GB_PLATE_RE = re.compile(
    r"\b[A-HJ-PR-Y]{2}(?:0[2-9]|[12]\d|5[1-9]|[67]\d)\s?[A-HJ-PR-Z]{3}\b"
)

# DVLA driving licence: 16 characters encoding surname, date of birth and
# initials. The embedded date structure (month 01-12 or 51-62 for female, day
# 01-31) is what makes it self-describing enough to go unanchored. The DVLA
# check-digit algorithm is not public, so there is no checksum to apply — only
# the surname-shape rejection upstream implements as invalidate_result.
_GB_DL_RE = re.compile(
    r"\b[A-Z9]{5}\d(?:0[1-9]|1[0-2]|5[1-9]|6[0-2])(?:0[1-9]|[12]\d|3[01])"
    r"\d[A-Z9]{2}[A-Z0-9][A-Z]{2}\b"
)
_GB_DL_SURNAME_RE = re.compile(r"^[A-Z]+9*$")

# UK passport: two letters then seven DIGITS (2015+). Narrower than the Dutch
# shape, which allows alphanumerics, but still an anchor case — the same nine
# characters are a product code often enough.
_GB_PASSPORT_RE = re.compile(r"\b[A-Z]{2}\d{7}\b")

# NOT PORTED: UK_POSTCODE. Upstream ships it at confidence 0.1, and the reason
# is the same one that keeps DE_PLZ out: a postcode is not a standalone
# identifier, and the only category it could map to here is Address — which is a
# fuzzy GLiNER category whose spans are whole address blocks. Emitting "SW1A 1AA"
# as an Address would make the span extent lie about what was found.


def _is_valid_uk_nhs(candidate: str) -> bool:
    """UK NHS number — ten digits, weighted mod-11 (weights 10..1)."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 10:
        return False
    return sum(int(x) * w for x, w in zip(d, range(10, 0, -1))) % 11 == 0


def _is_valid_uk_driving_licence(candidate: str) -> bool:
    """Reject a DVLA licence whose surname field is malformed.

    Not a checksum — the DVLA algorithm is not public. Positions 1-5 hold the
    surname padded with TRAILING 9s, so "9" anywhere but the tail (and an
    all-9s field) means the match is a coincidence rather than a licence.
    """
    return bool(_GB_DL_SURNAME_RE.match(candidate[:5])) and candidate[:5] != "99999"
