"""France: the NIR with its mod-97 key, VAT, SIREN/SIRET, plates and the
national phone shape. SIREN/SIRET are bare digit runs and stay anchored.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _LINE_SPACE_CHARS

# NIR (social security). 15 digits with the conventional grouping, or a bare
# run; the mod-97 key admits only ~1% of noise, so bare is acceptable here.
_FR_NIR_RE = re.compile(
    r"\b[12][\s.]?\d{2}[\s.]?\d{2}[\s.]?(?:\d{2}|2[AB])[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{2}\b"
)
_FR_VAT_RE = re.compile(r"\bFR\s?\d{2}\s?\d{9}\b")
# SIREN (9) / SIRET (14) — bare digit runs, so anchor-required.
_FR_SIREN_RE = re.compile(r"\b\d{9}(?:\d{5})?\b")
_FR_SIREN_ANCHOR_RE = re.compile(
    r"\b(?:SIREN|SIRET|num[ée]ro\s+d[e']\s?entreprise)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_FR_PLATE_RE = re.compile(r"\b[A-Z]{2}-\d{3}-[A-Z]{2}\b")

# Separators are mandatory in every national phone pattern — see us.py for
# the measurement behind that rule. Never a newline or a tab (BFSF-299).
_FR_PHONE_RE = re.compile(rf"\b0[1-9](?:[{_LINE_SPACE_CHARS}.\-]\d{{2}}){{4}}\b")


def _is_valid_fr_nir(candidate: str) -> bool:
    """French NIR — 13 digits plus a 2-digit mod-97 key (Corsica: 2A/2B)."""
    s = "".join(c for c in candidate.upper() if c.isalnum())
    if len(s) != 15:
        return False
    body, key = s[:13], s[13:]
    if not key.isdigit():
        return False
    body = body.replace("2A", "19").replace("2B", "18")
    if not body.isdigit():
        return False
    return int(key) == 97 - int(body) % 97
