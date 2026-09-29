"""Poland: PESEL and NIP with their weighted checks, VAT, plates and the
national phone shape. PESEL and NIP are bare digit runs and stay anchored,
which is why they never suppress the model.
"""

from __future__ import annotations

import re

from .anchors import (
    _ANCHOR_GAP,
    _LINE_SPACE_CHARS,
    _NATID_ANCHOR_WORDS,
    _PLATE_ANCHOR_WORDS,
)

# PESEL and NIP are both bare digit runs with mod-10/mod-11 checks.
_PL_PESEL_RE = re.compile(r"\b\d{11}\b")
_PL_PESEL_ANCHOR_RE = re.compile(
    r"\b(?:PESEL|numer\s+PESEL|" + _NATID_ANCHOR_WORDS + r")" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_PL_NIP_RE = re.compile(
    r"\b\d{3}-\d{3}-\d{2}-\d{2}\b|\b\d{3}-\d{2}-\d{2}-\d{3}\b|\b\d{10}\b"
)
_PL_NIP_ANCHOR_RE = re.compile(r"\b(?:NIP|REGON)" + _ANCHOR_GAP, re.IGNORECASE)
_PL_VAT_RE = re.compile(r"\bPL\s?\d{10}\b")
_PL_PLATE_RE = re.compile(r"\b[A-Z]{2,3}\s?[A-Z0-9]{4,5}\b")
_PL_PLATE_ANCHOR_RE = re.compile(
    r"\b(?:numer\s+rejestracyjny|tablica\s+rejestracyjna|rejestracja|"
    + _PLATE_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Separators are mandatory in every national phone pattern — see us.py for
# the measurement behind that rule. Never a newline or a tab (BFSF-299).
_PL_PHONE_RE = re.compile(
    rf"\b\d{{3}}[{_LINE_SPACE_CHARS}.\-]\d{{3}}[{_LINE_SPACE_CHARS}.\-]\d{{3}}\b"
)


def _is_valid_pl_pesel(candidate: str) -> bool:
    """Polish PESEL — weighted mod-10."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 11:
        return False
    weights = (1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
    total = sum(w * int(x) for w, x in zip(weights, d))
    return (10 - total % 10) % 10 == int(d[10])


def _is_valid_pl_nip(candidate: str) -> bool:
    """Polish NIP — weighted mod-11."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 10:
        return False
    weights = (6, 5, 7, 2, 3, 4, 5, 6, 7)
    total = sum(w * int(x) for w, x in zip(weights, d)) % 11
    return total != 10 and total == int(d[9])
