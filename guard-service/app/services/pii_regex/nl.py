"""The Netherlands: BSN with the elfproef, RSIN, BTW, KVK, plates, the
passport shape, the zorgverzekering polisnummer and title-prefixed persons.
The elfproef here is the same arithmetic the BSN carve-out in pii_bsn uses.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _LINE_SPACE

_BSN_CANDIDATE_RE = re.compile(r"\b\d{9}\b")
# The words that name a nine-digit run as a citizen's BSN. A SOFT anchor (see
# PatternSpec.context_anchor): it never gates the BSN spec, it only tells the
# ranking that the text itself says "BSN" when a model reads the digits as an
# RSIN / tax number — the two share the elfproef, so only words separate them.
_BSN_ANCHOR_RE = re.compile(
    r"\b(?:BSN|burger[\s\-]?service[\s\-]?nummer|sofi[\s\-]?nummer|citizen[\s\-]service[\s\-]number)"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Six standard NL sidecodes — see RDW.
_NL_PLATE_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b\d{2}-[A-Z]{2}-\d{2}\b"),
    re.compile(r"\b[A-Z]{2}-\d{2}-[A-Z]{2}\b"),
    re.compile(r"\b\d{2}-[A-Z]{3}-\d\b"),
    re.compile(r"\b\d-[A-Z]{3}-\d{2}\b"),
    re.compile(r"\b[A-Z]{2}-\d{3}-[A-Z]\b"),
    re.compile(r"\b[A-Z]-\d{3}-[A-Z]{2}\b"),
)

# Dutch BTW VAT number — NL + 9 digits + B + 2 digits. Pattern itself
# is precise enough that we don't bother with the validator algorithm.
_BTW_RE = re.compile(r"\bNL\d{9}B\d{2}\b")

# KVK number — Dutch Chamber of Commerce, 8 digits. Anchored on context
# because bare 8-digit numbers are too common (order IDs, dates, etc.).
_KVK_RE = re.compile(r"\b\d{8}\b")
_KVK_ANCHOR_RE = re.compile(
    r"\b(?:KVK|K\.v\.K\.|kamer van koophandel|kvk[\s\-]?nummer|handelsregister)"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# RSIN — Dutch corporate ID, 9 digits, validated with the same elfproef
# as BSN. Context-anchored to disambiguate from a personal BSN.
_RSIN_RE = re.compile(r"\b\d{9}\b")
_RSIN_ANCHOR_RE = re.compile(
    r"\b(?:RSIN|Rechtspersonen[\s\-]?Samenwerkingsverbanden|fiscaal[\s\-]?nummer)"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Dutch passport — two uppercase letters followed by seven alphanumerics.
# Anchored on context to avoid eating product codes / order numbers.
_DUTCH_PASSPORT_RE = re.compile(r"\b[A-Z]{2}[A-Z0-9]{7}\b")
_DUTCH_PASSPORT_ANCHOR_RE = re.compile(
    r"\b(?:paspoort|passport|paspoortnummer|passport[\s\-]?number|reisdocument)"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)

# Dutch title-prefixed persons. The title is required so we don't try
# to identify random capitalised words as names — that's GLiNER's job.
#
# Name body: one or more capitalised words, possibly with multi-letter
# initials like "M.C." (no space between the letter and the dot, but a
# space *between* dotted groups is allowed). Optional Dutch tussenvoegsel
# (van, de, der, …) followed by another capitalised surname. The words are
# joined by _LINE_SPACE, never `\s`: "Mr. <name>\n<name>" is two
# lines, and one span over both would merge two people into one token.
_DUTCH_TITLES = r"(?:Mw\.|Mevr\.|Mevrouw|Dhr\.|Dhr|Heer|Mr\.|Prof\.|Drs\.|Ir\.|Ing\.)"
_DUTCH_NAME_TOKEN = r"(?:[A-Z][a-zA-Z\-]+|[A-Z](?:\.[A-Z])*\.)"
_DUTCH_TUSSENVOEGSEL = r"(?:van|de|der|den|ten|ter|te|van der|van de|van den)"
_DUTCH_TITLED_PERSON_RE = re.compile(
    rf"\b{_DUTCH_TITLES}{_LINE_SPACE}+{_DUTCH_NAME_TOKEN}"
    rf"(?:{_LINE_SPACE}+{_DUTCH_NAME_TOKEN})*"
    rf"(?:{_LINE_SPACE}+{_DUTCH_TUSSENVOEGSEL}{_LINE_SPACE}+{_DUTCH_NAME_TOKEN}"
    rf"(?:{_LINE_SPACE}+{_DUTCH_NAME_TOKEN})*)?"
)

# Dutch zorgverzekering polisnummer: 8-10 alphanumerics, uppercase as insurers
# print them, digit-only formats included (CZ and Zilveren Kruis issue bare
# nine digits). No checksum exists, so the spec is anchor-required on the same
# health-insurance word list as the GB NHS spec.
_NL_POLIS_RE = re.compile(r"\b[A-Z0-9]{8,10}\b")


def _is_valid_bsn(digits: str) -> bool:
    """Dutch BSN elfproef. Port of isValidBsn() from
    server/core/emailTextUtils.js.
    """
    if not (len(digits) == 9 and digits.isdigit()):
        return False
    weights = (9, 8, 7, 6, 5, 4, 3, 2, -1)
    total = sum(w * int(d) for w, d in zip(weights, digits))
    return total != 0 and total % 11 == 0
