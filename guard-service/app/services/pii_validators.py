"""Arithmetic validators — the ONLY non-model logic allowed to touch a span.

THE RULE
--------
    No pattern may propose or suppress a span. Only the model proposes spans.

A checksum is not a detector. ``re.finditer`` over a document *finds* things;
``is_valid_iban("NL91ABNA0417164300")`` decides whether something the model
already found satisfies mod-97. This module is the second kind, and the shape
of its public API is what makes that structurally true rather than a promise:

  * ``validate(category, text) -> bool | None`` takes exactly two arguments,
  * the second is a SPAN's own string — never the document,
  * there is no ``import re`` anywhere in this file.

``tests/test_pii.py::ValidatorContractTests`` asserts all three against the
module source. A validator that cannot see the document cannot propose a span
from it, so "only an AI model detects" stays literally true no matter what
someone adds here later.

WHAT THIS BUYS, AND WHAT IT DOES NOT
------------------------------------
It buys PRECISION and correct LABELLING: a model span that satisfies mod-97 is
an IBAN and not a BankAccountNumber, decided arithmetically instead of by
comparing two confidences that came out of different forward passes.

It buys NO RECALL. A validator cannot fire on a span the model never proposed.
This is the most common misreading of the design, so it is stated twice: the
unanchored Dutch BSN that GLiNER misses (measured recall 0.04 unanchored vs
1.00 anchored) is NOT recovered by moving the elfproef here. That loss is the
price of the rule, and it was accepted knowingly.

NEVER DROP A SPAN
-----------------
A failed validation DEMOTES confidence; it never deletes. Two reasons:

1. ``_finalise``'s ``union(kept) == union(input)`` invariant is this
   component's anti-leak guarantee. Dropping a span before _finalise happens
   OUTSIDE that invariant, so it would silently un-redact characters the model
   flagged — and the property test would still pass.
2. Luhn fails on a real card number the user typed with a typo. That number is
   still PII.

Pure stdlib. Bodies are vendored from ``eval/validators.py``, which is already
the canonical copy and is designed to outlive ``pii_regex.py``.
"""

from __future__ import annotations

import ipaddress
from typing import Optional

# Confidence a span is raised to when arithmetic confirms it. Deliberately NOT
# 1.0 or 0.99: _finalise must still be able to prefer a MORE SPECIFIC validated
# category over a general one, and nothing should hold an unbeatable maximum.
VALIDATED_CONFIDENCE = 0.97

# Multiplier applied when arithmetic REFUTES a span. Demotion, not deletion —
# see the module docstring. Chosen so a refuted span falls below a typical
# per-category floor without falling out of its overlap cluster.
REFUTED_CONFIDENCE_FACTOR = 0.7


def is_valid_bsn(digits: str) -> bool:
    """Dutch BSN elfproef."""
    if not (len(digits) == 9 and digits.isdigit()):
        return False
    weights = (9, 8, 7, 6, 5, 4, 3, 2, -1)
    total = sum(w * int(d) for w, d in zip(weights, digits))
    return total != 0 and total % 11 == 0


def is_valid_iban(candidate: str) -> bool:
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


def is_valid_luhn(candidate: str) -> bool:
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


def is_valid_ipv4(candidate: str) -> bool:
    parts = candidate.strip().split(".")
    if len(parts) != 4:
        return False
    try:
        return all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)
    except ValueError:
        return False


def is_valid_ipv6(candidate: str) -> bool:
    """Stdlib parse. Not a search primitive — it decides about one span."""
    try:
        ipaddress.IPv6Address(candidate.strip())
        return True
    except ValueError:
        return False


def is_valid_ssn(candidate: str) -> bool:
    """Reject well-known invalid US SSN ranges."""
    s = candidate.strip()
    if len(s) < 11:
        return False
    area = s[:3]
    if area in ("000", "666") or area.startswith("9"):
        return False
    return s[4:6] != "00" and s[7:11] != "0000"


def is_valid_iso7064_mod11_10(digits: str) -> bool:
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


def is_valid_be_national_id(candidate: str) -> bool:
    """Belgian rijksregisternummer — mod-97 over the first nine digits.

    Both century branches are accepted: post-2000 births prefix a `2` before the
    modulo, and the number carries nothing that says which era it is from.
    """
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 11:
        return False
    body, check = d[:9], int(d[9:])
    return check in (97 - int(body) % 97, 97 - int("2" + body) % 97)


def is_valid_fr_nir(candidate: str) -> bool:
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


def is_valid_es_dni(candidate: str) -> bool:
    """Spanish DNI / NIE — mod-23 check letter."""
    s = candidate.upper().replace("-", "").replace(" ", "")
    if len(s) != 9:
        return False
    head, letter = s[:8], s[8]
    if head[0] in "XYZ":
        head = str("XYZ".index(head[0])) + head[1:]
    if not head.isdigit() or not letter.isalpha():
        return False
    return letter == "TRWAGMYFPDXBNJZSQVHLCKE"[int(head) % 23]


def is_valid_pl_pesel(candidate: str) -> bool:
    """Polish PESEL — weighted mod-10."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 11:
        return False
    weights = (1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
    total = sum(w * int(x) for w, x in zip(weights, d))
    return (10 - total % 10) % 10 == int(d[10])


def is_valid_se_personnummer(candidate: str) -> bool:
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


def is_valid_at_svnr(candidate: str) -> bool:
    """Austrian Sozialversicherungsnummer — weighted mod-11, check at index 3."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 10:
        return False
    weights = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)
    total = sum(w * int(x) for w, x in zip(weights, d)) % 11
    return total != 10 and total == int(d[3])


def is_valid_uk_nhs(candidate: str) -> bool:
    """UK NHS number — ten digits, weighted mod-11 (weights 10..1)."""
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 10:
        return False
    return sum(int(x) * w for x, w in zip(d, range(10, 0, -1))) % 11 == 0


def _validate_health_insurance(span_text: str) -> Optional[bool]:
    """Confirm a UK NHS number; no opinion on anything else.

    Confirming only, and the asymmetry matters more here than elsewhere: a Dutch
    polisnummer is alphanumeric with no check digit at all, and a German KVNR is
    a letter plus nine digits under a different algorithm. Refuting a span for
    failing the NHS arithmetic would demote every non-UK health identifier the
    model correctly found — health data is DSGVO Art. 9, so that is the most
    expensive direction to be wrong in.
    """
    digits = "".join(c for c in span_text if c.isdigit())
    if len(digits) == 10 and is_valid_uk_nhs(digits):
        return True
    return None


def _validate_national_id(span_text: str) -> Optional[bool]:  # noqa: C901, PLR0911
    """Shape-gated national-ID checksums, confirming only — never refuting.

    Used to be NL-only, with a comment explaining why non-NL identifiers had to
    return None: a Belgian rijksregisternummer satisfies no elfproef, and 27 of
    the corpus's 85 NationalIdentificationNumber spans are non-Dutch, so a False
    there would demote correct model detections for the crime of not being Dutch.

    That reasoning still holds and is what shapes this function. Each branch is
    gated on the shape its algorithm applies to, and a span that matches no
    branch — or that matches a shape but no country's check — still returns None
    rather than False. The asymmetry is deliberate: several of these shapes
    collide (11 bare digits is a Belgian national number, a German Steuer-IdNr
    AND a Polish PESEL), so failing one country's arithmetic says nothing about
    whether the span is an identifier. Only a positive result is informative.
    """
    digits = "".join(c for c in span_text if c.isdigit())
    compact = span_text.strip().upper().replace(" ", "").replace("-", "")

    if len(digits) == 9:
        # Dutch BSN. Refutable, because at this shape the elfproef is the only
        # candidate rule and 9 digits is not a shape another country shares here.
        return is_valid_bsn(digits)

    if len(digits) == 11:
        for check in (
            is_valid_be_national_id,
            is_valid_iso7064_mod11_10,
            is_valid_pl_pesel,
        ):
            if check(digits):
                return True
        return None

    if len(digits) == 15:
        return True if is_valid_fr_nir(span_text) else None

    if len(compact) == 9 and compact[:8].isdigit() and compact[8].isalpha():
        return True if is_valid_es_dni(compact) else None
    if len(compact) == 9 and compact[0] in "XYZ":
        return True if is_valid_es_dni(compact) else None

    if len(digits) == 10:
        for check in (is_valid_se_personnummer, is_valid_at_svnr):
            if check(digits):
                return True
        return None
    if len(digits) == 12 and is_valid_se_personnummer(digits):
        return True

    return None


def _validate_iban(span_text: str) -> Optional[bool]:
    s = span_text.strip()
    # An IBAN is CC + 2 check digits + up to 30 alnum. Anything else is not a
    # malformed IBAN, it is a different thing the model happened to label IBAN,
    # and arithmetic has no opinion about it.
    compact = s.replace(" ", "").upper()
    if len(compact) < 5 or not compact[:2].isalpha() or not compact.isalnum():
        return None
    return is_valid_iban(compact)


def _validate_card(span_text: str) -> Optional[bool]:
    digits = [c for c in span_text if c.isdigit()]
    if not (13 <= len(digits) <= 19):
        return None
    return is_valid_luhn(span_text)


def _validate_ip(span_text: str) -> Optional[bool]:
    s = span_text.strip()
    # A network or endpoint notation is not a bare address, and arithmetic has
    # no standing to refute it: `2001:db8::/32` and `[2001:db8::1]:443` are
    # both things a model may legitimately label IPAddress.
    if "/" in s or "[" in s or "]" in s:
        return None
    if ":" in s:
        # Used to return None for everything without exactly three dots ("IPv6
        # or something else — no opinion"), which meant a model span labelled
        # IPAddress was never checked against the one thing that settles it.
        # Unlike the elfproef — which is Dutch, so a Belgian ID failing it means
        # nothing — RFC 4291 is universal: there is no valid IPv6 address that
        # fails an IPv6 parse. `12:30:45` and `aa:bb:cc:dd:ee:ff` are the spans
        # that actually turn up, and both are properly refutable.
        # Note `::ffff:192.0.2.1` has three dots AND colons, hence this first.
        return is_valid_ipv6(s)
    if s.count(".") == 3:
        return is_valid_ipv4(s)
    return None  # neither shape — arithmetic has no opinion


def _validate_ssn(span_text: str) -> Optional[bool]:
    s = span_text.strip()
    if len(s) != 11 or s[3] != "-" or s[6] != "-":
        return None
    return is_valid_ssn(s)


# category -> validator. Categories absent here are never validated, which is
# the correct default: most PII has no checksum.
_VALIDATORS = {
    "NationalIdentificationNumber": _validate_national_id,
    "InternationalBankingAccountNumber": _validate_iban,
    "CreditCardNumber": _validate_card,
    "IPAddress": _validate_ip,
    "USSocialSecurityNumber": _validate_ssn,
    "HealthInsuranceNumber": _validate_health_insurance,
}

VALIDATED_CATEGORIES = frozenset(_VALIDATORS)


def validate(category: str, text: str) -> Optional[bool]:
    """Does *text* satisfy *category*'s checksum?

    Returns True (confirmed), False (refuted), or None (no opinion — either the
    category has no checksum, or the span is not the right shape for one).

    ``text`` is a SINGLE SPAN's string. Passing a document here would be a
    contract violation, and the signature is asserted by test so it cannot
    quietly grow a third parameter that reintroduces one.
    """
    fn = _VALIDATORS.get(category)
    if fn is None or not text:
        return None
    try:
        return fn(text)
    except Exception:
        # A validator must never break a detection response. No opinion.
        return None


__all__ = [
    "validate",
    "VALIDATED_CATEGORIES",
    "VALIDATED_CONFIDENCE",
    "REFUTED_CONFIDENCE_FACTOR",
]
