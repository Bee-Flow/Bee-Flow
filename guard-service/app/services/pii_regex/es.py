"""Spain: DNI and NIE with their mod-23 check letter, VAT, post-2000 plates
and the national phone shape. The check letter is what makes the identifiers
safe to detect without an anchor.
"""

from __future__ import annotations

import re

from .anchors import _LINE_SPACE_CHARS

# DNI / NIE carry a check LETTER, which is what makes them safe unanchored.
_ES_DNI_RE = re.compile(r"\b\d{8}[A-Z]\b")
_ES_NIE_RE = re.compile(r"\b[XYZ]\d{7}[A-Z]\b")
_ES_VAT_RE = re.compile(r"\bES\s?[A-Z0-9]\d{7}[A-Z0-9]\b")
# Post-2000 series: four digits then three consonants (vowels are excluded to
# avoid spelling words, which is also what keeps this pattern from matching them).
_ES_PLATE_RE = re.compile(r"\b\d{4}\s?[BCDFGHJKLMNPRSTVWXYZ]{3}\b")

# Separators are mandatory in every national phone pattern — see us.py for
# the measurement behind that rule. Never a newline or a tab (BFSF-299).
_ES_PHONE_RE = re.compile(
    rf"\b[6-9]\d{{2}}[{_LINE_SPACE_CHARS}.\-]\d{{3}}[{_LINE_SPACE_CHARS}.\-]\d{{3}}\b"
)


def _is_valid_es_dni(candidate: str) -> bool:
    """Spanish DNI / NIE — mod-23 letter."""
    s = candidate.upper().replace("-", "").replace(" ", "")
    if len(s) != 9:
        return False
    head, letter = s[:8], s[8]
    if head[0] in "XYZ":
        head = str("XYZ".index(head[0])) + head[1:]
    if not head.isdigit() or not letter.isalpha():
        return False
    return letter == "TRWAGMYFPDXBNJZSQVHLCKE"[int(head) % 23]
