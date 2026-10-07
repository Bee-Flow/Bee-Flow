"""Patterns that are not country-specific: email, phone, IBAN, cards, IPs,
URLs and secrets, with the checksums that go with them (mod-97, Luhn, the
stdlib IP parsers). Every pattern here is compiled once at import.
"""

from __future__ import annotations

import ipaddress
import re

from .anchors import _ANCHOR_GAP, _LINE_SPACE

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

# NL + international phone numbers. Loose-then-validate: the digit count is
# checked afterwards (_phone_digits_ok). To avoid eating arbitrary digit runs
# (order numbers, BSN candidates, the tail of an IBAN), a match needs either a
# `+` or a separator: a bare `0612345678` stays the model's call.
#
# Rewritten for BFSF-296, where every one of these shapes leaked in part or in
# full: `+CC (0)6 NNNN NNNN` (the `+CC` stayed), `0NN NNN NN NN` (three groups
# after the area code were one too many, so the last stayed), `06 / NNNN NNNN`,
# `0NN/NNNNNNN` and `0NN - NNN NN NN` (`/` and a spaced dash were no
# separator), `(0NN) NNN NN NN` and `06 (NNNN) NNNN` (brackets only as `(0)`).
# And the separator was `\s`, so a match ran on over `\n` into the next row's
# number (BFSF-299).
#
#   * Separators are `-`, `.` or `/` with optional spaces around them, or
#     spaces alone — never a newline or a tab (_LINE_SPACE). A `/` or a spaced
#     `-` only right after the area code ("06 / …", "010 - …"): between two
#     numbers on one line ("020 - 123 45 67 / 06 - 12 34 56 78") they are the
#     separator of the LIST, and taking them inside the number made the first
#     match end in the second number's "06" and leave the rest of it outside.
#   * Up to four groups after the area code; a long block (5-8 digits) only
#     as the LAST group, so two numbers on one line ("06-12345678 /
#     06-87654321") are two matches instead of one 20-digit reject.
#   * Brackets around the area code or one subscriber group; `(0)` after a
#     country code.
#   * No match may start inside a number (`(?<![\w+])`) or right after a
#     digit-and-separator ("12-06-2026": the `06-2026` tail is no number).
#   * A national number never starts with a date ("01-12-2026", "12.03.2026")
#     or a clock time ("09.00 - 17.00"), and is never the 3-2-4 dashed shape
#     of a US SSN (the corpus writes those from `000-`), all of which the
#     looser grouping could otherwise read as a number.
_PHONE_SEP = rf"(?:{_LINE_SPACE}*[\-./]{_LINE_SPACE}*|{_LINE_SPACE}+)"
# Between two subscriber groups: spaces, or a bare `-` or `.`.
_PHONE_INNER_SEP = rf"(?:{_LINE_SPACE}+|[\-.])"
_PHONE_SHORT = r"(?:\d{2,4}|\(\d{1,4}\))"
# Between two groups: a separator, or nothing next to a bracket.
_PHONE_JOIN = rf"(?:{_PHONE_SEP}|(?<=\))|(?=\())"
_PHONE_INNER_JOIN = rf"(?:{_PHONE_INNER_SEP}|(?<=\))|(?=\())"
_PHONE_GROUPS = (
    rf"{_PHONE_JOIN}(?:{_PHONE_SHORT}{_PHONE_INNER_JOIN}){{0,3}}"
    rf"(?:{_PHONE_SHORT}|\d{{5,8}})"
)
_PHONE_AREA = r"(?:\(\d{1,4}\)|\d{1,4})"
_PHONE_TRUNK = rf"(?:{_LINE_SPACE}?\(0\))?"
_PHONE_RE = re.compile(
    r"(?<![\w+])(?<!\d[\-./])(?:"
    # +CC, an optional (0), then a bare subscriber number or area + groups.
    rf"\+[1-9]\d{{0,2}}{_PHONE_TRUNK}"
    rf"(?:{_PHONE_SEP}?\d{{7,12}}|{_PHONE_SEP}?{_PHONE_AREA}{_PHONE_GROUPS})"
    # 00CC: the same, always grouped (a bare 00-run is an order number).
    rf"|00[1-9]\d{{0,2}}{_PHONE_TRUNK}{_PHONE_SEP}?{_PHONE_AREA}{_PHONE_GROUPS}"
    # National: a trunk-0 area code, then the groups.
    r"|(?!\d{1,2}([\-./])\d{1,2}\1\d{2,4}(?!\d|\1\d))"
    r"(?!\d{1,2}[.:]\d{2}(?![\d.:]))"
    r"(?!\d{3}-\d{2}-\d{4}(?!\d|-\d))"
    rf"(?:0\d{{1,4}}|\(0\d{{1,4}}\)|\(0\){_LINE_SPACE}?\d{{1,4}}){_PHONE_GROUPS}"
    r")(?!\d)(?!:\d)"
)


def _phone_digits_ok(ent: dict) -> bool:
    """8-15 digits after a `+`, 9-15 otherwise.

    E.164 caps a number at 15 digits. The lower bound is one higher without a
    `+`: eight digits is exactly a dd-mm-yyyy date or an hh.mm-hh.mm opening
    time, both far more common in business text than the rare 8-digit national
    number (a short Swedish or Austrian landline), which the model still
    covers. A Dutch number has ten.
    """
    digits = sum(1 for c in ent["text"] if c.isdigit())
    low = 8 if ent["text"].startswith("+") else 9
    return low <= digits <= 15


# IBAN: 2-letter country, 2 check digits, then the national BBAN. The body is
# bounded 11..30 because ISO 13616 registers no IBAN shorter than 15 chars
# TOTAL (Norway), so a shorter token is never a real account — the old 4..30
# bound admitted every "AB123456"-style reference code and left mod-97 as the
# only defence (1-in-97 of those leaked through as false positives, and with
# near-miss emission 96-in-97 would have been flagged as typo'd IBANs).
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")

# The SPACED form, written in the conventional groups of four — which is how
# every bank prints an IBAN and how people paste them.
#
# This pattern did not exist, and its absence was not a small gap: the contiguous
# pattern above cannot match across a space, so `NL59 RABO 2654 2351 16` was not
# detected AT ALL. Not partially — nothing. Worse, the generic phone pattern
# happily matched fragments of it (`06 4746 87`), so a bank account left the
# guard unredacted while a piece of it was reported as a telephone number.
#
# Safe to add because mod-97 is the strongest check in this file: it admits one
# random candidate in 97, so the pattern can afford to be permissive about
# layout. The trailing group is bounded at 1-3 characters so the match cannot
# run past the end of the account into a following all-caps token.
_IBAN_SPACED_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:\s[A-Z0-9]{4})+(?:\s[A-Z0-9]{1,3})?\b")

# The same account typed the way people type in chat: lower or mixed case
# (`nl91abna0417164300`, `Nl91 Abna 0417 1643 00`) or grouped with dashes
# (`NL91-ABNA-0417-1643-00`). Both patterns above are upper-case only, and IBAN
# is regex-complete, so GLiNER was never asked: these forms were not detected
# at all, and the dashed or spaced ones were partly reported as a phone number.
#
# Two shapes, both validated with mod-97 and neither near-miss (a lower-case
# run that fails mod-97 is not a mistyped IBAN) nor `complete` (the upper-case
# specs keep that claim):
#   * groups of four with an optional space or dash between them, and
#   * the contiguous run. The grouped pattern's optional separators are greedy
#     and accept letters, so when the BBAN length is a multiple of four (BE,
#     ES, AT, PL, SE, LU, CZ, ...) a following word of four or more characters
#     is absorbed, mod-97 fails and the account is dropped; the contiguous twin
#     still finds `be68539007547034 voor de huur`.
# Known gap: a lower-case SPACED IBAN of those countries followed by such a
# word (`be68 5390 0754 7034 voor`) is still missed.
_IBAN_ANYCASE_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ \-]?[A-Za-z0-9]{4}){2,7}(?:[ \-]?[A-Za-z0-9]{1,3})?(?![A-Za-z0-9])"
)
_IBAN_CONTIG_ANYCASE_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}(?![A-Za-z0-9])"
)

# 13-19 digit candidate, separators allowed. Validated with Luhn.
_CC_RE = re.compile(r"\b(?:\d[\s\-]?){12,18}\d\b")

# The bare card run on its own. _CC_RE is greedy across separators, so a
# number just before the card joins the match (`klant 7 4111111111111111` is
# tried as `7 4111111111111111`); Luhn fails on the joined run, the whole match
# is dropped, and finditer resumes AFTER it, so the card itself was never
# tried. This re-emits only Luhn-valid bare runs, which _CC_RE already emits
# whenever no neighbour joins, so precision is unchanged.
_CC_BARE_RE = re.compile(r"(?<!\d)\d{13,19}(?!\d)")

# The GROUPED card notations humans actually write: 4-4-4-4(-3) (Visa/MC/
# Discover, 16-19 digits) and 4-6-5 (Amex). This twin exists for near-miss
# emission only: a Luhn failure on THIS shape is a mistyped card (the grouping
# does not occur in order numbers), while a Luhn failure on a bare digit run
# from _CC_RE above is as likely an order number as a card — so the bare shape
# stays drop-on-fail and only the grouped one demotes.
_CC_GROUPED_RE = re.compile(
    r"\b(?:\d{4}(?:[\s\-]\d{4}){3}(?:[\s\-]\d{3})?|\d{4}[\s\-]\d{6}[\s\-]\d{5})\b"
)

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# IPv6. The previous pattern was `\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b`,
# which was wrong in BOTH directions and shipped that way:
#
#   * it matched every HH:MM:SS timestamp ("om 12:30:45" -> IPAddress @ 0.99) and
#     every MAC address. IPAddress is regex-complete, so GLiNER is never asked and
#     cannot dissent; regex spans skip _apply_validators; and _validate_ip had no
#     opinion on anything without exactly three dots. With the Node-side default
#     action=block, any message containing a time of day was refused.
#   * it could not express `::` at all, so a real address was matched PARTIALLY —
#     "2001:db8::8a2e:370:7334" yielded only the "8a2e:370:7334" tail, i.e. the
#     redaction covered part of the address and left the prefix in cleartext.
#
# So: keep the pattern permissive enough to bound the span correctly (including
# `::` compression and IPv4-mapped tails) and let `ipaddress` decide. The
# lookarounds — rather than \b, which treats ':' as a boundary — stop a match
# from starting or ending mid-token.
_IPV6_RE = re.compile(
    r"(?<![0-9A-Za-z.:])"
    r"(?:[0-9A-Fa-f]{0,4}:){2,7}"
    r"(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?"
    r"(?![0-9A-Za-z.:])"
)

_URL_RE = re.compile(r"https?://\S+|www\.[A-Za-z0-9\-]+\.[A-Za-z]{2,}\S*")

# Specific high-precision secret patterns.
_SECRET_RES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("openai", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b")),
    ("aws", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36}\b")),
)
# Generic hex secret — only emit when an anchor word appears within
# 40 chars before the match to keep precision high (port of the MAC
# anchor approach from emailTextUtils.js).
_HEX_SECRET_RE = re.compile(r"\b[0-9a-fA-F]{32,}\b")
_HEX_SECRET_ANCHOR_RE = re.compile(
    r"\b(?:secret|key|token|password|api[_\-]?key|bearer)" + _ANCHOR_GAP,
    re.IGNORECASE,
)


def _is_valid_iban(candidate: str) -> bool:
    """Standard ISO 13616 mod-97 check."""
    s = candidate.replace(" ", "").upper()
    if not (4 < len(s) <= 34):
        return False
    rearranged = s[4:] + s[:4]
    # A=10, B=11, ..., Z=35
    digits_str = "".join(c if c.isdigit() else str(ord(c) - 55) for c in rearranged)
    try:
        return int(digits_str) % 97 == 1
    except ValueError:
        return False


def _is_valid_iban_anysep(candidate: str) -> bool:
    """mod-97 on an IBAN grouped with spaces or dashes (_IBAN_ANYCASE_RE).

    At least 15 characters without separators, the same floor as _IBAN_RE's
    body bound (ISO 13616 registers no shorter IBAN): the grouped shape also
    fits a 14-character Dutch VAT number (`NL908830705B27`), and one in 97 of
    those passes mod-97.
    """
    compact = candidate.replace("-", "").replace(" ", "")
    return len(compact) >= 15 and _is_valid_iban(compact)


def _is_valid_luhn(candidate: str) -> bool:
    """Standard Luhn check on a digit string (separators stripped)."""
    digits = [int(c) for c in candidate if c.isdigit()]
    if not (13 <= len(digits) <= 19):
        return False
    checksum = 0
    parity = len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def _is_valid_ipv4(candidate: str) -> bool:
    parts = candidate.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(p) <= 255 for p in parts)
    except ValueError:
        return False


def _is_valid_ipv6(candidate: str) -> bool:
    """Let the stdlib decide, so the pattern can stay permissive.

    This is what stops `12:30:45` and `aa:bb:cc:dd:ee:ff` from being redacted as
    addresses: both parse as neither a full eight-hextet form nor a `::`
    compression. Hand-rolling the rule instead would mean re-deriving RFC 4291,
    and the last hand-rolled attempt is what shipped the timestamp bug.
    """
    try:
        ipaddress.IPv6Address(candidate.strip())
        return True
    except ValueError:
        return False
