"""The United States: SSN range checks, ITIN, EIN, ABA routing numbers, the
Medicare Beneficiary Identifier, driver's licences, passports and NANP phone
numbers. The routing checksum is the 3-7-1 weighted mod-10.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _LINE_SPACE, _LINE_SPACE_CHARS

_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")

# ITIN: always 9xx-7x/8x-xxxx, a range the SSA never issues, so the shape alone
# is decisive.
_US_ITIN_RE = re.compile(r"\b9\d{2}-(?:7\d|8[0-8])-\d{4}\b")
# EIN: two digits, dash, seven. Same shape as plenty of order numbers, so anchor.
_US_EIN_RE = re.compile(r"\b\d{2}-\d{7}\b")
_US_EIN_ANCHOR_RE = re.compile(
    r"\b(?:EIN|employer\s+identification|federal\s+tax\s+id|FEIN|TIN)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_US_ROUTING_RE = re.compile(r"\b\d{9}\b")
_US_ROUTING_ANCHOR_RE = re.compile(
    r"\b(?:routing(?:\s+number)?|ABA(?:\s+number)?|RTN)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
# Medicare Beneficiary Identifier — the alphabet excludes S, L, O, I, B and Z to
# avoid character confusion, which is what makes the shape recognisable.
_US_MBI_RE = re.compile(
    r"\b[1-9][ACDEFGHJKMNPQRTUVWXY][A-Z0-9]\d"
    r"[\-\s]?[A-Z][A-Z0-9]\d"
    r"[\-\s]?[A-Z]{2}\d{2}\b"
)
_US_MBI_ANCHOR_RE = re.compile(
    r"\b(?:medicare|MBI|beneficiary\s+identifier|HICN)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
# Driver's licence formats differ per state and several are indistinguishable
# from ordinary strings, so this is anchor-only by design.
_US_DL_RE = re.compile(r"\b[A-Z]{0,2}\d{5,13}\b")
_US_DL_ANCHOR_RE = re.compile(
    r"\b(?:driver'?s?\s+licen[cs]e|DL\s?(?:number|#)?|licen[cs]e\s+number|"
    r"state\s+id)" + _ANCHOR_GAP,
    re.IGNORECASE,
)
_US_PASSPORT_RE = re.compile(r"\b[A-Z]?\d{8,9}\b")
_US_PASSPORT_ANCHOR_RE = re.compile(
    r"\b(?:passport(?:\s+(?:number|no\.?|#))?)" + _ANCHOR_GAP,
    re.IGNORECASE,
)

# National phone numbers.
#
# Only three countries besides this one need a pattern (fr, es, it, pl), which
# is worth stating because the obvious move — a pattern per country —
# measurably made things worse. _PHONE_RE's second branch already matches any
# trunk-`0` number followed by a separator, so DE, AT, BE and SE were fully
# covered before those existed; adding duplicates for them bought no recall
# and cost precision through overlap noise.
#
# The ones that ARE uncovered do not use a trunk zero: Spanish numbers start
# 6-9, Italian mobiles start 3, Polish numbers are nine bare digits, and US NANP
# has no leading 0 either.
#
# SEPARATORS ARE MANDATORY here, and that is the whole design. With separators
# optional, the Spanish pattern reduced to "any nine digits starting 6-9" — which
# is also the shape of a Dutch BSN, a French SIREN and a US routing number. It
# fired on all of them: measured PhoneNumber precision 0.927 -> 0.692 and, worse,
# NationalIdentificationNumber recall 0.615 -> 0.385, because the phone span won
# overlap resolution against the BSN it had swallowed. A phone pattern that eats
# national IDs is a detector that hides personal data while appearing to add
# coverage.
#
# NANP: the area code and the central-office code both start 2-9 — 0 and 1 are
# reserved as trunk prefixes and are never the first digit of either. Without
# that constraint this pattern is "any 3-3-4 grouped ten digits", which is also
# a UK NHS number, the tail of a spaced IBAN and an invoice reference. Measured
# on the corpus, EVERY false positive it produced began with a 0 or a 1: 35 NHS
# numbers written `176 164 1360`, plus spaced-IBAN fragments like `06 4746 87`.
# The real-world rule and the precision fix are the same edit.
#
# The word boundary sits INSIDE the alternation, not before it. `\b(?:\(…`
# requires a WORD character immediately before the `(` — `\b` between a space
# and a `(` never matches, so the parenthesised branch was dead in all
# realistic text: 53/53 corpus misses on `(415) 555-0132`-style numbers, found
# by the completeness check, not by review.
#
# Separators never include a newline or a tab (BFSF-299).
_US_PHONE_RE = re.compile(
    rf"(?:\([2-9]\d{{2}}\){_LINE_SPACE}?|\b[2-9]\d{{2}}[{_LINE_SPACE_CHARS}.\-])"
    rf"[2-9]\d{{2}}[{_LINE_SPACE_CHARS}.\-]\d{{4}}\b"
)


def _is_valid_aba_routing(candidate: str) -> bool:
    """US ABA routing number — 3-7-1 weighted mod-10."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 9:
        return False
    weights = (3, 7, 1, 3, 7, 1, 3, 7, 1)
    return sum(w * int(x) for w, x in zip(weights, d)) % 10 == 0


def _is_valid_ssn(candidate: str) -> bool:
    """Reject well-known invalid SSN ranges."""
    area = candidate[:3]
    if area in ("000", "666"):
        return False
    if area.startswith("9"):
        return False
    group = candidate[4:6]
    serial = candidate[7:11]
    return group != "00" and serial != "0000"
