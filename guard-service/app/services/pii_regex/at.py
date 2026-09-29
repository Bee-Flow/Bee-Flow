"""Austria: the Sozialversicherungsnummer (spaced and bare) with its mod-11
check, VAT and plates. The conventional `1234 010180` spacing is what earns
the spaced form an unanchored spec.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _NATID_ANCHOR_WORDS, _PLATE_ANCHOR_WORDS

_AT_SVNR_SPACED_RE = re.compile(r"\b\d{4}\s\d{6}\b")
_AT_SVNR_BARE_RE = re.compile(r"\b\d{10}\b")
_AT_SVNR_ANCHOR_RE = re.compile(
    r"\b(?:sozialversicherungsnummer|SV[\-\s]?Nummer|SVNR|versicherungsnummer|"
    + _NATID_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)
_AT_VAT_RE = re.compile(r"\bATU\d{8}\b")
_AT_PLATE_RE = re.compile(r"\b[A-Z]{1,2}-\d{1,5}\s?[A-Z]{0,2}\b")
_AT_PLATE_ANCHOR_RE = re.compile(
    r"\b(?:kennzeichen|kfz[\-\s]?kennzeichen|autonummer|"
    + _PLATE_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)


def _is_valid_at_svnr(candidate: str) -> bool:
    """Austrian Sozialversicherungsnummer — weighted mod-11, check at index 3."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 10:
        return False
    weights = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)
    total = sum(w * int(x) for w, x in zip(weights, d)) % 11
    return total != 10 and total == int(d[3])
