"""Italy: the codice fiscale, VAT, plates and the mobile phone shape.

The codice fiscale's fixed letter/digit alternation is distinctive without a
checksum; the CIN check character is deliberately not implemented — see
eval/validators.py on why an unverified checksum is worse than none.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _LINE_SPACE_CHARS, _PLATE_ANCHOR_WORDS

_IT_CF_RE = re.compile(r"\b[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b")
_IT_VAT_RE = re.compile(r"\bIT\s?\d{11}\b")
_IT_PLATE_RE = re.compile(r"\b[A-Z]{2}\s?\d{3}\s?[A-Z]{2}\b")
_IT_PLATE_ANCHOR_RE = re.compile(
    r"\b(?:targa|targhe|numero\s+di\s+targa|"
    + _PLATE_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Separators are mandatory in every national phone pattern — see us.py for
# the measurement behind that rule. Never a newline or a tab (BFSF-299).
_IT_PHONE_RE = re.compile(rf"\b3\d{{2}}[{_LINE_SPACE_CHARS}.\-]\d{{6,7}}\b")
