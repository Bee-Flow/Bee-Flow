"""Germany: Steuer-IdNr and USt-IdNr, the Rentenversicherungsnummer, the
Krankenversicherungsnummer, the Finanzamt's Steuernummer, Handelsregister
entries and plates, with the ISO 7064, VKVV and GKV checksums.
"""

from __future__ import annotations

import re

from .anchors import (
    _ANCHOR_GAP,
    _HEALTH_INS_ANCHOR_WORDS,
    _NATID_ANCHOR_WORDS,
    _PLATE_ANCHOR_WORDS,
)

# Steuer-IdNr (personal tax ID) and USt-IdNr (VAT).
_DE_TAXID_SPACED_RE = re.compile(r"\b\d{2}\s\d{3}\s\d{3}\s\d{3}\b")
_DE_TAXID_BARE_RE = re.compile(r"\b\d{11}\b")
_DE_NATID_ANCHOR_RE = re.compile(
    r"\b(?:steuer[\-\s]?identifikationsnummer|steuer[\-\s]?id(?:nr)?|"
    r"steuernummer|IdNr|TIN|" + _NATID_ANCHOR_WORDS + r")" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_DE_VAT_RE = re.compile(r"\bDE\s?\d{9}\b")

# Rentenversicherungsnummer (RVNR / Sozialversicherungsnummer), § 147 SGB VI.
#
# This pattern used to be `\b\d{2}[A-Z]\d{6}[A-Z]\d{3}\b` — two letters, in the
# wrong places. A real RVNR has ONE letter, at position 9: two-digit regional
# office, birth day, birth month, birth year, surname initial, serial, check
# digit. The old shape cannot match any real German social-security number, so
# it was dead weight that could only ever produce false positives. Corrected
# against Presidio's DeSocialSecurityRecognizer (MIT).
#
# The day range allows 51-81: the +50 Ergänzungsmerkmal disambiguates two
# people who would otherwise be issued the same number. Encoding the date
# structure in the pattern is what earns this one an unanchored spec — the
# checksum alone is a mod-10 and admits one match in ten.
_DE_RVNR_RE = re.compile(
    r"\b\d{2}(?:0[1-9]|[12]\d|3[01]|5[1-9]|[67]\d|8[01])(?:0[1-9]|1[0-2])"
    r"\d{2}[A-Z]\d{3}\b"
)

# Krankenversicherungsnummer (KVNR), § 290 SGB V — the number on the eGK.
# Health data, so DSGVO Art. 9 special category.
#
# `[A-Z]\d{9}` is a broad shape (product codes, order references) and the GKV
# check is a mod-10 admitting ~9.6% of random matches. Broad shape plus weak
# check means ANCHOR REQUIRED, which in turn means it can never be `complete` —
# and that is correct twice over, because the KVNR only covers STATUTORY
# insurance (GKV). Privately insured people have entirely different formats, so
# suppressing GLiNER for HealthInsuranceNumber in Germany would lose them.
_DE_KVNR_RE = re.compile(r"\b[A-Z]\d{9}\b")
_DE_KVNR_ANCHOR_RE = re.compile(
    r"\b(?:krankenversicherungs?nummer|krankenversichertennummer|"
    r"versichertennummer|KVNR|krankenkasse|gesundheitskarte|eGK|GKV|"
    r"gesetzliche\s+krankenversicherung|versichertenkarte|"
    + _HEALTH_INS_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Steuernummer (§ 139a AO) — the Finanzamt's number, which is NOT the Steuer-IdNr
# above: it changes when you move district. Two written forms.
#
# The ELSTER form is thirteen bare digits with no check digit at all, so it is
# anchor-required — thirteen digits is an invoice number far more often than it
# is a tax number. The slashed forms carry their own structure and go without.
_DE_STEUERNUMMER_ELSTER_RE = re.compile(r"\b(?:0[1-9]|1[0-6])\d{11}\b")
_DE_STEUERNUMMER_SLASHED_RE = re.compile(r"(?<!\w)\d{2,3}/\d{3,4}/\d{4,5}(?!\w)")
_DE_STEUERNUMMER_ANCHOR_RE = re.compile(
    r"\b(?:steuernummer|steuer[\-\s]?nr\.?|st\.?[\-\s]?nr\.?|finanzamt|"
    r"umsatzsteuer|einkommensteuer|k[öo]rperschaftsteuer|gewerbesteuer|"
    r"steuerbescheid|steuerveranlagung|"
    # Same rule as everywhere else here: the anchor language is the PRODUCT's,
    # not the identifier's. A Dutch bookkeeper writes "btw-nummer" about a
    # German Steuernummer, and anchoring on German alone left 28 of them to
    # nothing at all.
    r"btw[\-\s]?nummer|btw|fiscaal[\-\s]?nummer|belastingnummer|"
    r"tax[\-\s]?(?:number|id|reference)|VAT[\-\s]?(?:number|id)?)" + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Handelsregisternummer, §§ 9/14 HGB. HRA covers sole traders and partnerships,
# so an HRA entry identifies a NATURAL PERSON — which is why this is in scope at
# all and not merely company metadata. The prefix makes the shape self-evident.
_DE_HRB_RE = re.compile(r"\bHR[AB]\s?\d{1,6}\b")
_DE_PLATE_RE = re.compile(r"\b[A-ZÄÖÜ]{1,3}-[A-Z]{1,2}\s?\d{2,4}\s?[EH]?\b")
_DE_PLATE_ANCHOR_RE = re.compile(
    r"\b(?:kennzeichen|kfz|nummernschild|autonummer|"
    + _PLATE_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)


def _is_valid_iso7064_mod11_10(digits: str) -> bool:
    """ISO/IEC 7064 MOD 11,10 — German Steuer-IdNr / USt-IdNr."""
    d = "".join(c for c in digits if c.isdigit())
    if not (len(d) == 11 and d[0] != "0"):
        return False
    product = 10
    for ch in d[:-1]:
        total = (int(ch) + product) % 10
        if total == 0:
            total = 10
        product = (2 * total) % 11
    return (11 - product) % 10 == int(d[-1])


def _is_valid_de_rvnr(candidate: str) -> bool:
    """German Rentenversicherungsnummer — VKVV § 4 weighted cross-sum mod 10."""
    s = candidate.upper().strip().replace(" ", "")
    if len(s) != 12 or not (s[:8].isdigit() and s[8].isalpha() and s[9:].isdigit()):
        return False
    day, month = int(s[2:4]), int(s[4:6])
    if not (1 <= day <= 31 or 51 <= day <= 81) or not 1 <= month <= 12:
        return False
    effective = s[:8] + str(ord(s[8]) - ord("A") + 1).zfill(2) + s[9:11]
    total = 0
    for ch, w in zip(effective, (2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1)):
        product = int(ch) * w
        total += product // 10 + product % 10
    return total % 10 == int(s[11])


def _is_valid_de_kvnr(candidate: str) -> bool:
    """German Krankenversicherungsnummer — GKV-Spitzenverband, § 290 SGB V."""
    s = candidate.upper().strip().replace(" ", "").replace("-", "")
    if len(s) != 10 or not s[0].isalpha() or not s[1:].isdigit():
        return False
    effective = str(ord(s[0]) - ord("A") + 1).zfill(2) + s[1:9]
    total = 0
    for ch, w in zip(effective, (1, 2) * 5):
        product = int(ch) * w
        total += product - 9 if product >= 10 else product
    return total % 10 == int(s[9])
