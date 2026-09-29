"""Checksum validators owned by the eval harness.

These are vendored copies of the five validators that used to live in
``app/services/pii_regex.py``. The corpus generator uses them to *construct*
provably-valid synthetic identifiers (a generated IBAN really does satisfy
mod-97, a generated BSN really does satisfy the elfproef).

Why vendored rather than imported:

1. **The corpus must not be defined by the detector under test.** While
   ``value_banks.py`` imported these from the regex tier, the corpus was by
   construction the exact set of values that tier was perfect on — which is
   why its measured recall of 1.0000 is a tautology rather than a measurement.
   The gold set has to be defined independently of any detector.
2. **The corpus outlives the regex tier.** ``pii_regex.py`` is being deleted;
   corpus generation must keep working, and must keep producing byte-identical
   output at ``--seed 42`` so the CI reproducibility check still holds.

While ``pii_regex.py`` still exists, ``tests/test_eval_harness.py`` asserts
these agree with it exactly, so the vendoring cannot drift silently during the
transition. That test is deleted along with the regex tier.

Pure stdlib — this module sits on the model-free CI path.
"""

from __future__ import annotations


def is_valid_bsn(digits: str) -> bool:
    """Dutch BSN elfproef.

    Originally ported from server/core/emailTextUtils.js isValidBsn().
    """
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
    parts = candidate.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(p) <= 255 for p in parts)
    except ValueError:
        return False


def is_valid_ipv6(candidate: str) -> bool:
    """Stdlib parse — the rule is RFC 4291 and is not worth re-deriving.

    Vendored alongside the others so the drift test can pin it. Exists because
    the regex tier's IPv6 pattern used to be its own validator, and matched
    every `HH:MM:SS` timestamp while truncating every `::`-compressed address.
    """
    import ipaddress

    try:
        ipaddress.IPv6Address(candidate.strip())
        return True
    except ValueError:
        return False


def is_valid_ssn(candidate: str) -> bool:
    """Reject well-known invalid SSN ranges."""
    area = candidate[:3]
    if area in ("000", "666"):
        return False
    if area.startswith("9"):
        return False
    group = candidate[4:6]
    serial = candidate[7:11]
    return group != "00" and serial != "0000"


# ── Country national-identifier checksums ──────────────────────────────────
#
# Added so the regex tier can cover more than the Netherlands. That is not a
# nice-to-have: REGEX_COMPLETE_CATEGORIES suppresses GLiNER per category, so a
# Dutch-only NationalIdentificationNumber pattern meant a German tenant had
# neither detector for German IDs (measured: up to 63.7pp recall lost).
#
# Only algorithms verified against published valid numbers are here. Where a
# country's check digit could not be confirmed (Italian codice fiscale CIN,
# Spanish CIF, Italian partita IVA) the pattern side uses a distinctive SHAPE
# plus a context anchor instead. Shipping a checksum that is subtly wrong is
# worse than shipping none: it silently REFUTES valid identifiers, and a refuted
# span is demoted rather than dropped, so the failure is invisible.


def is_valid_iso7064_mod11_10(digits: str, length: int = 11) -> bool:
    """ISO/IEC 7064 MOD 11,10 — German Steuer-IdNr and USt-IdNr.

    Verified against the BZSt published test number 86095742719.
    """
    if not (len(digits) == length and digits.isdigit()):
        return False
    if digits[0] == "0":
        return False
    product = 10
    for ch in digits[:-1]:
        total = (int(ch) + product) % 10
        if total == 0:
            total = 10
        product = (2 * total) % 11
    check = (11 - product) % 10
    return check == int(digits[-1])


def is_valid_be_national_id(candidate: str) -> bool:
    """Belgian rijksregisternummer / numéro national — mod-97 over the first 9.

    Verified against 85.07.30-033.28. Births from 2000 prefix a `2` before the
    modulo, which is why both branches are tried: the number itself carries no
    century, so accepting either is the only correct reading.
    """
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 11:
        return False
    body, check = digits[:9], int(digits[9:])
    return check in (97 - int(body) % 97, 97 - int("2" + body) % 97)


def is_valid_fr_nir(candidate: str) -> bool:
    """French NIR / numéro de sécurité sociale — 13 digits + 2-digit key.

    Corsica uses 2A/2B in the département, which map to 19/18 before the modulo
    (the standard INSEE substitution).
    """
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
    """Spanish DNI (8 digits + letter) and NIE (X/Y/Z + 7 digits + letter).

    Verified against 12345678Z. The letter is a mod-23 table lookup, so this is
    a real check digit rather than a shape test.
    """
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
    """Polish PESEL — weighted mod-10. Verified against 44051401359."""
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 11:
        return False
    weights = (1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
    total = sum(w * int(d) for w, d in zip(weights, digits))
    return (10 - total % 10) % 10 == int(digits[10])


def is_valid_pl_nip(candidate: str) -> bool:
    """Polish NIP (tax) — weighted mod-11. Verified against 1234563218."""
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 10:
        return False
    weights = (6, 5, 7, 2, 3, 4, 5, 6, 7)
    total = sum(w * int(d) for w, d in zip(weights, digits)) % 11
    if total == 10:
        return False
    return total == int(digits[9])


def is_valid_se_personnummer(candidate: str) -> bool:
    """Swedish personnummer / organisationsnummer — Luhn over 10 digits.

    Verified against 811218-9876. A 12-digit form carries the century, which
    Luhn does not cover, so it is dropped before the check.
    """
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) == 12:
        digits = digits[2:]
    if len(digits) != 10:
        return False
    total = 0
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def is_valid_at_svnr(candidate: str) -> bool:
    """Austrian Sozialversicherungsnummer — weighted mod-11.

    Verified against 1237 010180. The check digit sits at position 4, not at the
    end, which is the detail a generic "last digit" implementation gets wrong.
    """
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 10:
        return False
    weights = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)
    total = sum(w * int(d) for w, d in zip(weights, digits)) % 11
    if total == 10:
        return False
    return total == int(digits[3])


def is_valid_de_rvnr(candidate: str) -> bool:
    """German Rentenversicherungsnummer (RVNR) — VKVV § 4.

    Verified against the DRV documentation example 15070649C103:
        effective  = '15070649' + '03' (C=3) + '10'
        x weights  = 2,5,0,35,0,6,8,9,0,3,2,0
        cross-sums = 2,5,0, 8,0,6,8,9,0,3,2,0  -> 43,  43 mod 10 = 3 = check digit

    Twelve characters: two-digit regional office, birth day (01-31, or 51-81
    when the +50 Ergänzungsmerkmal disambiguates two otherwise identical
    numbers), birth month, birth year, the initial of the birth surname, a
    two-digit serial, and the check digit.

    The day and month ranges are enforced here as well as in the pattern. They
    are structural invariants of a real RVNR, and without them a match on an
    impossible date could still be promoted by a lucky checksum collision.

    Ported from Presidio's DeSocialSecurityRecognizer (MIT).
    """
    s = candidate.upper().strip().replace(" ", "")
    if len(s) != 12 or not (s[:8].isdigit() and s[8].isalpha() and s[9:].isdigit()):
        return False
    day, month = int(s[2:4]), int(s[4:6])
    if not (1 <= day <= 31 or 51 <= day <= 81) or not 1 <= month <= 12:
        return False
    effective = s[:8] + str(ord(s[8]) - ord("A") + 1).zfill(2) + s[9:11]
    weights = (2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1)
    total = 0
    for ch, w in zip(effective, weights):
        product = int(ch) * w
        total += product // 10 + product % 10
    return total % 10 == int(s[11])


def is_valid_de_kvnr(candidate: str) -> bool:
    """German Krankenversicherungsnummer (KVNR) — GKV-Spitzenverband, § 290 SGB V.

    Verified against A000500015 (§ 290 SGB V Anlage 1, Stand 02.01.2023).

    Ten characters: the initial of the birth surname, eight data digits, and a
    check digit. The letter expands to its two-digit ordinal, giving ten
    effective digits; alternating weights 1,2 are applied, each product of ten
    or more is replaced by its cross-sum, and the total mod 10 is the check.

    A mod-10 check on `[A-Z]\\d{9}` admits roughly one in ten random matches,
    which is why the spec carrying it is anchor-required — see the
    precision-budget tests. Ported from Presidio's
    DeHealthInsuranceRecognizer (MIT).
    """
    s = candidate.upper().strip().replace(" ", "").replace("-", "")
    if len(s) != 10 or not s[0].isalpha() or not s[1:].isdigit():
        return False
    effective = str(ord(s[0]) - ord("A") + 1).zfill(2) + s[1:9]
    total = 0
    for ch, w in zip(effective, (1, 2) * 5):
        product = int(ch) * w
        total += product - 9 if product >= 10 else product
    return total % 10 == int(s[9])


def is_valid_uk_nhs(candidate: str) -> bool:
    """UK NHS number — ten digits, weighted mod-11. Verified against 943 476 5919.

    Weights run 10..1 across all ten digits (the check digit itself carries
    weight 1), so a valid number sums to 0 mod 11. Ported from Presidio's
    NhsRecognizer (MIT); see guard-service/tools/presidio_upstream.json.

    A remainder of 1 means the check digit would have to be 10, which cannot be
    written — those numbers are simply never issued, and the mod-11 test rejects
    them for free.
    """
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 10:
        return False
    total = sum(int(d) * w for d, w in zip(digits, range(10, 0, -1)))
    return total % 11 == 0


def is_valid_aba_routing(candidate: str) -> bool:
    """US ABA routing number — 3-7-1 weighted mod-10. Verified against 021000021."""
    digits = "".join(c for c in candidate if c.isdigit())
    if len(digits) != 9:
        return False
    weights = (3, 7, 1, 3, 7, 1, 3, 7, 1)
    return sum(w * int(d) for w, d in zip(weights, digits)) % 10 == 0


# Legacy aliases — the underscore-prefixed names value_banks.py used while
# these lived in pii_regex.py. Kept so the diff stays reviewable.
_is_valid_bsn = is_valid_bsn
_is_valid_iban = is_valid_iban
_is_valid_luhn = is_valid_luhn
_is_valid_ipv4 = is_valid_ipv4
_is_valid_ipv6 = is_valid_ipv6
_is_valid_ssn = is_valid_ssn
