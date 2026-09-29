"""Which labels share one GLiNER forward pass, and what that makes reachable.

The grouping is the single most consequential tuning decision in the service:
a label's score depends on what it was asked alongside, so the partition
decides both precision and which categories can be detected at all. It is
therefore also part of the engine fingerprint — hence the digest here.
"""

from __future__ import annotations

import contextlib

from .categories import GLINER_LABELS_TO_CATEGORY

# ── Label grouping ─────────────────────────────────────────────────────
# GLiNER's attention is divided across the label list it receives, so the
# same span scores differently depending on what it is asked alongside.
# Two distinct effects, both measured on eval/corpus:
#
#  * DILUTION — "api key" alone scores P/R 1.000; the same label alongside
#    four other secret-ish labels drops to P 0.475.
#  * CANNIBALISATION — in one 4-label financial group, 85 gold IBANs were
#    tagged 43× BankAccountNumber, 13× TaxIdentificationNumber, 7× api-key,
#    5× NationalIdentificationNumber and only a handful as iban. Mutually
#    confusable categories in one group destroy each other.
#
# Cost is LINEAR in group count and chunk count is flat: _label_prompt_tokens
# sizes the per-chunk text budget from the WIDEST group, so as long as the
# widest group stays at/below the historical 6 labels, chunking is unchanged
# and only the number of forward passes grows. Measured 2,985 / 949 / 652
# chars-per-second at 1 / 3 / 5 groups.
#
# INVARIANT: groups 1 and 2 are byte-identical to the pre-cutover partition.
# They are the only two with calibrated floors, so holding them fixed keeps
# Person/Address/MedicalCondition as a control group — any movement there is
# then attributable to something other than relabelling.
#
# Labels are the strings GLiNER is asked for; they map to canonical category
# keys via GLINER_LABELS_TO_CATEGORY. A label here that is missing from that
# map is silently dropped by _accept.
_LABEL_GROUPS: list[list[str]] = [
    # G1 — identity in prose. FROZEN (control group).
    ["person", "organization", "address"],
    # G2 — healthcare vocabulary. FROZEN (control group).
    [
        "medical condition",
        "medication",
        "health insurance id number",
        "health insurance number",
        "national health insurance number",
    ],
    # G3 — contact & network. Mutually distinct shapes, safe to share.
    ["email address", "phone number", "url", "ip address"],
    # G4 — IBAN, kept AWAY from bank account number (the cannibalisation
    # pair). Both casings map to the same category, so they reinforce rather
    # than compete: uppercase carries precision, lowercase carries recall.
    ["IBAN", "iban", "credit card number"],
    # G5 — national identification. All five labels map to ONE category, so
    # they cannot cannibalise each other; the Dutch phrasings measured far
    # stronger than the English ones on Dutch text.
    [
        "burgerservicenummer",
        "citizen service number",
        "national id number",
        "identity card number",
        "identity document number",
    ],
    # G6 — government documents. Distinct shapes (alphanumeric / 10-digit /
    # xxx-xx-xxxx), kept out of G5 so they don't compete with national IDs.
    ["passport number", "driver's license number", "social security number"],
    # G7 — the remainder. tax identification number is kept away from G5
    # because RSIN is a 9-digit run sharing the BSN elfproef, and bank
    # account number away from G4 for the reason above.
    [
        "date of birth",
        "license plate number",
        "tax identification number",
        "bank account number",
        "api key",
    ],
]


# ── The active grouping ────────────────────────────────────────────────
# `_LABEL_GROUPS` above is the SHIPPED partition. What the service actually
# asks the model for goes through label_groups() below, so a sweep can put a
# candidate partition in front of it without anything rebinding a module
# global.
#
# That matters more than it looks. The floors in thresholds.py are only valid
# for the grouping they were fitted under — the group decides which labels
# compete in one forward pass, and therefore the whole score distribution a
# floor sits in. A sweep that silently measured the shipped partition while
# believing it measured a candidate would produce floors for the wrong world,
# and nothing downstream could tell.
_active_label_groups: list[list[str]] | None = None


def label_groups() -> list[list[str]]:
    """The grouping to ask GLiNER for, right now.

    Every reader goes through here — model_loading for its token budget and
    warm-up, detection for the passes themselves — so an override reaches all
    of them or none of them. Reading `_LABEL_GROUPS` directly is the bug this
    function exists to prevent.
    """
    return _active_label_groups if _active_label_groups is not None else _LABEL_GROUPS


@contextlib.contextmanager
def use_label_groups(groups: list[list[str]]):
    """Run a block against a candidate partition instead of the shipped one.

    For the eval harness. A context manager rather than a setter because a
    sweep that forgets to restore leaves the process measuring the wrong
    thing for every case after it, and that failure is silent.
    """
    global _active_label_groups
    previous = _active_label_groups
    _active_label_groups = groups
    try:
        yield
    finally:
        _active_label_groups = previous


def _grouped_categories() -> frozenset[str]:
    """Categories reachable through GLiNER: those with a label in a group.

    A label can exist in GLINER_LABELS_TO_CATEGORY and still be unreachable,
    because detect() only ever asks the model about labels that appear in
    _LABEL_GROUPS. That gap is invisible at runtime today because the regex
    tier covers exactly the affected categories.
    """
    return frozenset(
        GLINER_LABELS_TO_CATEGORY[lbl]
        for group in label_groups()
        for lbl in group
        if lbl in GLINER_LABELS_TO_CATEGORY
    )


def _label_group_digest() -> str:
    """Short, stable sha256 digest of the active label grouping."""
    import hashlib as _h
    import json as _j

    payload = _j.dumps([list(g) for g in label_groups()], separators=(",", ":"))
    return _h.sha256(payload.encode("utf-8")).hexdigest()[:12]
