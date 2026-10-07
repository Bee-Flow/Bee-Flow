"""What every regex detector is made of: the spec, the entity it emits, the scan.

Public names: ``PatternSpec``, ``ANY_REGION``, ``SHIPPED_REGIONS``, the region
constants (``_NL`` … ``_ANY``), ``_scan``, ``_make_entity`` and
``_digit_count_between``. A spec never changes a value it matched; it only
decides whether the match is emitted, and at what confidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable

# The demotion factor near-miss emission shares with _apply_validators —
# IMPORTED, not copied: a drifted copy would give the two tiers different
# "typo'd identifier" confidences for the same arithmetic verdict.
from app.services.pii_validators import REFUTED_CONFIDENCE_FACTOR

# Region code for a pattern that is not country-specific (email, IBAN, Luhn).
ANY_REGION = "*"

# ── Human-readable labels — keep in sync with CATEGORY_LABELS in pii.py.
_CATEGORY_LABELS: dict[str, str] = {
    "Email": "Email Address",
    "PhoneNumber": "Phone Number",
    "InternationalBankingAccountNumber": "IBAN",
    "CreditCardNumber": "Credit Card Number",
    "IPAddress": "IP Address",
    "URL": "URL",
    "NationalIdentificationNumber": "National ID",
    "USSocialSecurityNumber": "SSN (US)",
    "LicensePlateNumber": "License Plate",
    "TaxIdentificationNumber": "Tax ID",
    "ApiKeyOrSecret": "API Key / Secret",
    "Person": "Person Name",
    "PassportNumber": "Passport Number",
    "BankAccountNumber": "Bank Account Number",
    "DriversLicenseNumber": "Driver's License",
    "HealthInsuranceNumber": "Health Insurance Number",
}

_NL = frozenset({"NL"})
_BE = frozenset({"BE"})
_DE = frozenset({"DE"})
_FR = frozenset({"FR"})
_ES = frozenset({"ES"})
_IT = frozenset({"IT"})
_PL = frozenset({"PL"})
_SE = frozenset({"SE"})
_AT = frozenset({"AT"})
_GB = frozenset({"GB"})
_US = frozenset({"US"})
_ANY = frozenset({ANY_REGION})

# Every region this package ships patterns for. Used by the region-coverage test
# and by the admin UI to offer a choice rather than a free-text field.
SHIPPED_REGIONS: frozenset[str] = frozenset(
    {"NL", "BE", "DE", "FR", "ES", "IT", "PL", "SE", "AT", "GB", "US"}
)


def _count_digits(s: str) -> int:
    return sum(1 for c in s if c.isdigit())


def _make_entity(
    *,
    text: str,
    category: str,
    offset: int,
    length: int,
    confidence: float,
) -> dict:
    return {
        "text": text,
        "category": category,
        "label": _CATEGORY_LABELS.get(category, category),
        "confidence": round(confidence, 4),
        "offset": offset,
        "length": length,
    }


def _scan(  # noqa: PLR0913
    text: str,
    pattern: re.Pattern[str],
    category: str,
    *,
    validate: Callable[[str], bool] | None = None,
    confidence: float = 0.99,
    pre_anchor: re.Pattern[str] | None = None,
    near_miss_counts: dict[str, int] | None = None,
    near_miss: bool = False,
) -> Iterable[dict]:
    # ``near_miss_counts`` receives one increment per dropped candidate, keyed
    # "<Category>:<reason>". Counts only — never the value, offset or any text,
    # the same privacy stance as the by_category log field. A shape that
    # matched but died here is a candidate NOTHING else may ever see (under
    # tier=on the model is not asked about complete categories), so these
    # counters are the only trace a near-miss leaves.
    #
    # ``near_miss`` (per spec, opt-in) is demote-never-drop for the REGEX
    # tier: a checksum-failing match on a DISTINCTIVE shape is emitted at
    # spec confidence x REFUTED_CONFIDENCE_FACTOR instead of being dropped.
    # This is the same rule _apply_validators gives model spans ("Luhn fails
    # on a real card number typed with a typo — which is still PII"), which
    # is dead under tier=on for exactly the categories where checksums
    # silence the model. The anchor gate is checked FIRST: a near-miss may
    # soften the checksum, never the anchor — the anchor IS the precision.
    for m in pattern.finditer(text):
        match_str = m.group(0)
        if pre_anchor is not None:
            window = text[max(0, m.start() - 40) : m.start()]
            if not pre_anchor.search(window):
                if near_miss_counts is not None:
                    key = f"{category}:anchor_missing"
                    near_miss_counts[key] = near_miss_counts.get(key, 0) + 1
                continue
        checksum_failed = validate is not None and not validate(match_str)
        if checksum_failed:
            if near_miss_counts is not None:
                key = f"{category}:checksum_failed"
                near_miss_counts[key] = near_miss_counts.get(key, 0) + 1
            if not near_miss:
                continue
        ent = _make_entity(
            text=match_str,
            category=category,
            offset=m.start(),
            length=m.end() - m.start(),
            confidence=(
                round(confidence * REFUTED_CONFIDENCE_FACTOR, 4)
                if checksum_failed
                else confidence
            ),
        )
        if checksum_failed:
            # The same keys _apply_validators stamps on a refuted model span,
            # so _pick_label's arithmetic stage treats both tiers' near-misses
            # identically: a validated=True contender always beats this one.
            ent["validated"] = False
            ent["near_miss"] = "checksum_failed"
        # Record that surrounding words, not the digits, are what identified
        # this span. _pick_label needs it to separate categories that are
        # arithmetically identical — see _CONTEXT_SEPARABLE_SIBLINGS.
        if pre_anchor is not None:
            ent["context_hit"] = True
        yield ent


@dataclass(frozen=True)
class PatternSpec:
    """One detector: a pattern, who it applies to, and how far to trust it."""

    category: str
    # ISO 3166-1 alpha-2 codes, or {ANY_REGION} when the pattern is not
    # country-specific.
    regions: frozenset[str]
    pattern: re.Pattern[str]
    validate: Callable[[str], bool] | None = None
    pre_anchor: re.Pattern[str] | None = None
    confidence: float = 0.99
    # May this spec suppress GLiNER for its category? See
    # regex_complete_categories. Off by default: suppressing the model is the
    # decision that can silently lose recall, so it has to be asked for.
    complete: bool = False
    # Extra accept/reject on the finished entity (digit counts, ranges).
    post_filter: Callable[[dict], bool] | None = None
    # Demote-never-drop for checksum failures: emit the match at confidence x
    # REFUTED_CONFIDENCE_FACTOR instead of silently dropping it. OPT-IN, and
    # only defensible for DISTINCTIVE shapes: a mod-97-failing
    # `NL91ABNA0417164301` is almost certainly a typo'd IBAN (still PII, and
    # the model is measurably no net for it — R 0.037), while an
    # elfproef-failing bare nine-digit run is almost certainly an order
    # number (the elfproef rejects ~10/11 of them; emitting those would flag
    # half of commerce). Guarded by the per-spec precision-budget test.
    near_miss: bool = False
    # Does a checksum failure or anchor miss on this spec feed the near-miss
    # counters? Off only for a TWIN that re-scans a shape another spec already
    # covers (the any-case IBAN and bare card specs): there a failure is
    # either the same candidate counted a second time or not a near miss at
    # all (a lower-case word run, or a following word the greedy grouping
    # absorbed), and the counters must keep meaning one increment per
    # dropped candidate.
    counts_near_miss: bool = True

    def __post_init__(self) -> None:
        # An anchored pattern only fires when a nearby keyword is present, so by
        # construction it misses every unanchored mention. Letting it claim the
        # category would tell pii.py to stop asking GLiNER about exactly the
        # instances this pattern cannot see — a silent recall hole, and the
        # easiest one to introduce by adding `complete=True` out of optimism.
        if self.complete and self.pre_anchor is not None:
            raise ValueError(
                f"{self.category}: an anchor-required pattern cannot be `complete` "
                "— it misses every unanchored mention"
            )
        if self.near_miss and self.validate is None:
            raise ValueError(
                f"{self.category}: near_miss=True without a validator is "
                "meaningless — only a checksum can produce a near-miss; a "
                "shape-only spec has nothing to fail"
            )
        if not self.regions:
            raise ValueError(f"{self.category}: a spec must declare its regions")


def _digit_count_between(low: int, high: int) -> Callable[[dict], bool]:
    def _check(ent: dict) -> bool:
        return low <= _count_digits(ent["text"]) <= high

    return _check
