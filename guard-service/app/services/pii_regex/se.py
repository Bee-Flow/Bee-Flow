"""Sweden: the personnummer and organisationsnummer (both Luhn over ten
digits), VAT and plates. A personnummer is always written with a separator,
which is what lets it go unanchored.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _PLATE_ANCHOR_WORDS

_SE_PERSONNUMMER_RE = re.compile(r"\b(?:\d{2})?\d{6}[-+]\d{4}\b")
_SE_ORGNR_RE = re.compile(r"\b\d{6}-\d{4}\b")
_SE_ORGNR_ANCHOR_RE = re.compile(
    r"\b(?:organisationsnummer|org\.?\s?nr|orgnr)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_SE_VAT_RE = re.compile(r"\bSE\s?\d{12}\b")
_SE_PLATE_RE = re.compile(r"\b[A-Z]{3}\s?\d{2}[A-Z0-9]\b")
_SE_PLATE_ANCHOR_RE = re.compile(
    r"\b(?:registreringsnummer|reg\.?\s?nr|nummerplåt|"
    + _PLATE_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)


def _is_valid_se_personnummer(candidate: str) -> bool:
    """Swedish personnummer / organisationsnummer — Luhn over ten digits."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) == 12:
        d = d[2:]
    if len(d) != 10:
        return False
    total = 0
    for i, ch in enumerate(d):
        x = int(ch)
        if i % 2 == 0:
            x *= 2
            if x > 9:
                x -= 9
        total += x
    return total % 10 == 0
