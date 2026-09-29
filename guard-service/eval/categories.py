"""Category taxonomies owned by the eval harness.

Why this module exists: the harness used to classify categories by importing
``REGEX_COMPLETE_CATEGORIES`` from ``app.services.pii_regex``. That coupled the
*measuring instrument* to the *thing being measured* — once the regex tier is
deleted the harness cannot even start, and while it exists the tier split
silently changes whenever production does. Both are unacceptable for a
regression baseline.

So the groupings below are **eval-owned constants**. ``WAS_REGEX`` in particular
is a frozen historical fact — the set of categories that the regex tier owned
before the GLiNER-only cutover — and must never be "kept in sync" with anything.
It is what lets us gate "the categories we took a detector away from" as a group,
forever, long after ``pii_regex.py`` is gone.

Pure stdlib: this module sits on the model-free CI path.
"""

from __future__ import annotations

from .schema import CANONICAL_CATEGORIES

# ── Frozen history: the regex tier's 11 categories ─────────────────────────
# Snapshot of app/services/pii_regex.py REGEX_COMPLETE_CATEGORIES as it stood
# before the cutover. DO NOT EDIT to track production — that is the entire
# point. These are the categories whose detector is being replaced.
WAS_REGEX: frozenset[str] = frozenset(
    {
        "Email",
        "PhoneNumber",
        "InternationalBankingAccountNumber",
        "CreditCardNumber",
        "IPAddress",
        "URL",
        "NationalIdentificationNumber",
        "USSocialSecurityNumber",
        "LicensePlateNumber",
        "TaxIdentificationNumber",
        "ApiKeyOrSecret",
    }
)

# Person was detected by BOTH tiers: the regex tier caught Dutch title-prefixed
# names ("Mr. Eva Meijer") at confidence 0.95, GLiNER caught bare names.
WAS_BOTH: frozenset[str] = frozenset({"Person"})

# Everything else was already GLiNER-only. These are the CONTROL GROUP for the
# cutover experiment: nothing about their detector changes, so a statistically
# significant move in any of them means the experiment is confounded (most
# likely by the per-chunk token budget shifting) and no other row is
# trustworthy until it is explained.
WAS_GLINER: frozenset[str] = CANONICAL_CATEGORIES - WAS_REGEX - WAS_BOTH

# Categories that GAINED a deterministic detector after WAS_GLINER was frozen,
# and are therefore no longer a control for anything.
#
# The UK port (2026-07-30) added an NHS-number spec with a mod-11 check, a DVLA
# licence spec and a UK passport spec. WAS_GLINER stays as it is — it is a
# historical snapshot and rewriting it would falsify the cutover record — but
# the control group must mean what it says. Keeping these in it produced a
# +9.5pp "control group moved" failure that was not confounding at all: it was
# the intended change, reported as if the experiment were untrustworthy.
#
# Subtract, never re-derive from app.services.pii_regex. The eval must not be
# defined by the detector under test; that circularity is what made the old
# recall of 1.0000 a tautology. So this list is maintained BY HAND, with the
# release that caused each entry named above.
GAINED_A_DETECTOR: frozenset[str] = frozenset(
    {
        "HealthInsuranceNumber",
        "DriversLicenseNumber",
        "PassportNumber",
    }
)

# What is left is still a genuine control: Address, BankAccountNumber,
# DateOfBirth, MedicalCondition, Medication and Organization have no
# deterministic detector in any shipped region, so a move in them still means
# something shifted underneath the experiment.
CONTROL_GROUP: frozenset[str] = WAS_GLINER - GAINED_A_DETECTOR

# ── Risk ───────────────────────────────────────────────────────────────────
# High-leak categories: a recall drop here fails the gate hardest. Moved here
# from run_eval.py so the gate and the report share one definition.
HIGH_RISK: frozenset[str] = frozenset(
    {
        "Person",
        "Address",
        "MedicalCondition",
        "NationalIdentificationNumber",
        "TaxIdentificationNumber",
        "HealthInsuranceNumber",
        "InternationalBankingAccountNumber",
        "Email",
        "PhoneNumber",
        "CreditCardNumber",
    }
)

# ── Structure ──────────────────────────────────────────────────────────────
# The axis the cutover decision actually turns on. A "structured" category has
# a machine-checkable surface form, which means two things:
#   1. boundary EXACTNESS is a safety metric, not a quality metric — the Node
#      side tokenises by splicing offset/length, so a span clipped by one
#      character leaves a digit of the IBAN in the prompt; and
#   2. it is where the regex tier was strongest and the model is least proven.
# Note this set is deliberately LARGER than WAS_REGEX: PassportNumber,
# DriversLicenseNumber, BankAccountNumber, HealthInsuranceNumber and
# DateOfBirth are structured but were already GLiNER-only, so their measured
# performance is our prior for what GLiNER-only looks like on structured data.
STRUCTURED: frozenset[str] = frozenset(
    {
        "Email",
        "PhoneNumber",
        "InternationalBankingAccountNumber",
        "CreditCardNumber",
        "IPAddress",
        "URL",
        "NationalIdentificationNumber",
        "USSocialSecurityNumber",
        "LicensePlateNumber",
        "TaxIdentificationNumber",
        "ApiKeyOrSecret",
        "BankAccountNumber",
        "PassportNumber",
        "DriversLicenseNumber",
        "HealthInsuranceNumber",
        "DateOfBirth",
    }
)

FUZZY: frozenset[str] = CANONICAL_CATEGORIES - STRUCTURED

# Structured AND checksum-backed today. The regex tier's precision on these
# came entirely from the validator (the BSN pattern is literally ``\b\d{9}\b``),
# so these are the categories where a model has the least to work with and the
# plan gates them hardest.
CHECKSUM_BACKED: frozenset[str] = frozenset(
    {
        "InternationalBankingAccountNumber",
        "CreditCardNumber",
        "NationalIdentificationNumber",
        "USSocialSecurityNumber",
        "IPAddress",
    }
)


def _invert(name_to_members: dict[str, frozenset[str]]) -> dict[str, str]:
    """Flatten {class: members} into {category: class}."""
    out: dict[str, str] = {}
    for cls, members in name_to_members.items():
        for cat in members:
            out[cat] = cls
    return out


# ── The report groupings ───────────────────────────────────────────────────
# `evaluate()` takes this and emits report["by_class"][grouping][class].
# `by_prior_owner` is the direct successor to the old `by_tier` split.
CLASS_MAPS: dict[str, dict[str, str]] = {
    "by_prior_owner": _invert(
        {
            "was_regex": WAS_REGEX,
            "was_both": WAS_BOTH,
            "was_gliner": WAS_GLINER,
        }
    ),
    "by_structure": _invert(
        {
            "structured": STRUCTURED,
            "fuzzy": FUZZY,
        }
    ),
    "by_risk": _invert(
        {
            "high": HIGH_RISK,
            "standard": CANONICAL_CATEGORIES - HIGH_RISK,
        }
    ),
}


def _self_check() -> None:
    """Fail loudly at import if a taxonomy drifts off the canonical 21.

    A typo'd category id here would silently drop a category out of a gated
    class — exactly the kind of quiet coverage loss this harness exists to
    catch.
    """
    for name, members in (
        ("WAS_REGEX", WAS_REGEX),
        ("WAS_BOTH", WAS_BOTH),
        ("HIGH_RISK", HIGH_RISK),
        ("STRUCTURED", STRUCTURED),
        ("CHECKSUM_BACKED", CHECKSUM_BACKED),
    ):
        unknown = members - CANONICAL_CATEGORIES
        if unknown:
            raise ValueError(
                f"{name} contains non-canonical categories: {sorted(unknown)}"
            )

    for grouping, mapping in CLASS_MAPS.items():
        missing = CANONICAL_CATEGORIES - set(mapping)
        if missing:
            raise ValueError(
                f"CLASS_MAPS[{grouping!r}] does not partition the canonical "
                f"categories; missing: {sorted(missing)}"
            )


_self_check()
