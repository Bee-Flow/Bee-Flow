"""Which category names a cluster of overlapping spans.

``overlaps`` merges a transitively-overlapping cluster into ONE emitted span,
so exactly one of the contenders' categories survives. This module owns that
choice and the tables it rests on: the is-a relation, the context-separable
siblings, the margin-above-floor comparison and the frozen precedence that
replaces iteration order.
"""

from __future__ import annotations

from .thresholds import _PER_CATEGORY_THRESHOLD, _UI_DEFAULT_THRESHOLD

# general category -> categories that are STRICTLY MORE SPECIFIC than it.
# Read as: "when these overlap and confidence is close, prefer the specific".
#
# IS-A RELATIONS ONLY. "An IBAN is a bank account number" belongs here; "a
# phone number is inside an address block" does NOT. _finalise emits a single
# label for the union of a cluster, so a part-of relation resolved here renames
# the whole extent after one of its parts — which is how street addresses came
# back as `[url_1]`. Containment is handled structurally in _finalise instead.
# An IBAN *is* a bank account number, so the model scoring the general label
# marginally higher is not evidence that the specific one is wrong — and the
# specific label produces the more useful token on the restore path.
# MUST be acyclic — see test_specificity_relation_is_acyclic. A cycle makes
# the winner depend on iteration order, which is exactly the non-determinism
# this table exists to remove. (An earlier draft declared TaxIdentificationNumber
# and NationalIdentificationNumber each more specific than the other; a 9-digit
# RSIN and BSN are arithmetically identical, so the tie flipped and dropped
# TaxIdentificationNumber recall by 7.7pp. They are SIBLINGS — only context
# separates them — so neither may override the other.)
_SPECIFIC_OVER_GENERAL: dict[str, tuple[str, ...]] = {
    # IBAN is the most determinate reading of an IBAN-shaped string, and it is
    # contested from four directions at once. Measured over gold IBAN spans,
    # the winning label was: 3x TaxIdentificationNumber, 3x BankAccountNumber,
    # 2x CreditCardNumber, 1x NationalIdentificationNumber, 2x IBAN.
    #
    # That is not the model failing to see them — the IBAN labels fire fine in
    # isolation. It is one string legitimately matching several shapes:
    # "NL91ABNA0417164300" reads as a Dutch BTW number (NL + digits + B +
    # digits), as a bank account, as a long card-like digit run. Of those
    # readings only IBAN is a checksummed international standard, so where the
    # model is torn it is the correct and safer call.
    "BankAccountNumber": (
        "InternationalBankingAccountNumber",
        "CreditCardNumber",
    ),
    "TaxIdentificationNumber": ("InternationalBankingAccountNumber",),
    "CreditCardNumber": ("InternationalBankingAccountNumber",),
    # An SSN is a national identification number; the reverse does not hold.
    "NationalIdentificationNumber": (
        "USSocialSecurityNumber",
        "InternationalBankingAccountNumber",
    ),
    # A bare Organization overlapping a Person prefers the Person: a missed
    # personal name is the higher-consequence leak.
    "Organization": ("Person",),
    # NOTE: there was an "Address": ("PhoneNumber", "Email", "URL") row here,
    # intended to let a phone/email/URL *inside* an address block keep its own
    # label. It could never do that — the output is a flat, disjoint span list,
    # so a cluster yields exactly ONE label — and instead it renamed the whole
    # extent after the contained span: street addresses came back as `[url_1]`.
    # Containment is now handled structurally in _finalise (the covering span
    # names the union), which is the correct fix for both directions.
}

# Confidence gap within which specificity overrides raw score. Wide enough to
# cover the observed IBAN/BankAccountNumber margin, narrow enough that a
# confident general label still wins outright.
#
# Sweepable: `python -m eval.run_eval --tier off --split dev` at 0.10 / 0.35 /
# 1.00 (1.00 == specificity is unconditional). The band is a symptom-level
# knob — see _label_margin below for why the underlying comparison is the real
# problem — so measure before widening it.
_SPECIFICITY_BAND = 0.10

# Final tie-break when two contenders are genuinely indistinguishable. Earlier
# entries win. Frozen and explicit because the alternative is ITERATION ORDER,
# which makes the emitted label depend on which chunk the model happened to see
# first — a real bug once already (TaxIdentificationNumber lost 7.7pp to an
# order-dependent tie with NationalIdentificationNumber).
_CATEGORY_PRECEDENCE: tuple[str, ...] = (
    # Checksummed and most determinate first.
    "InternationalBankingAccountNumber",
    "USSocialSecurityNumber",
    "NationalIdentificationNumber",
    "CreditCardNumber",
    "IPAddress",
    # Then the rest of the structured identifiers.
    "TaxIdentificationNumber",
    "HealthInsuranceNumber",
    "PassportNumber",
    "DriversLicenseNumber",
    "BankAccountNumber",
    "LicensePlateNumber",
    "ApiKeyOrSecret",
    "Email",
    "PhoneNumber",
    "URL",
    "DateOfBirth",
    # Fuzzy last: a person's name losing a tie to an IBAN is right; the reverse
    # renames a bank account after whoever is standing next to it.
    "MedicalCondition",
    "Medication",
    "Person",
    "Address",
    "Organization",
)


def _label_margin(ent: dict) -> float:
    """Confidence expressed as distance above the category's OWN floor.

    Raw confidence is not comparable across categories here, and the reason is
    structural rather than a tuning miss: each label group is a SEPARATE
    forward pass with its own label set and its own softmax denominator. A 0.62
    from the IBAN group and a 0.65 from the bank-account group are samples from
    different distributions, and `max(cluster, key=confidence)` compared them as
    if they were the same number. That is the mechanism behind 43 of 85 gold
    IBANs being emitted as BankAccountNumber.

    The per-category floor is the only per-category normalisation constant this
    component has, and it was fitted on exactly these score distributions, so
    the distance above it is comparable in a way the raw score is not: a 0.52
    Person (floor 0.40, margin +0.12) genuinely beats a 0.58 Organization
    (floor 0.50, margin +0.08). Under raw confidence that comparison came out
    backwards.

    The UI slider shifts every floor equally (see _final_floor), so it cancels
    in any comparison between two spans and is deliberately not applied here.
    """
    floor = _PER_CATEGORY_THRESHOLD.get(ent["category"], _UI_DEFAULT_THRESHOLD)
    return ent["confidence"] - floor


# Category pairs that are arithmetically INDISTINGUISHABLE — same shape, same
# checksum — so only the surrounding words can tell them apart. Keep this list
# tiny and justify every entry: it is an escape hatch from the margin ordering,
# and the margin ordering is what fixed the IBAN/BankAccountNumber confusion.
#
#   TaxIdentificationNumber / NationalIdentificationNumber
#       A Dutch RSIN (corporate) and BSN (personal) are both nine digits and
#       both satisfy the elfproef. There is no arithmetic that separates them.
_CONTEXT_SEPARABLE_SIBLINGS: tuple[frozenset[str], ...] = (
    frozenset({"TaxIdentificationNumber", "NationalIdentificationNumber"}),
)


def _by_sibling_context(contenders: list[dict]) -> list[dict]:
    """Between DECLARED siblings only: keep the contenders the surrounding words
    named (``context_hit``), when some but not all were. A set filter, so it is
    order-independent; it never changes the extent, only who names it."""
    cats = {e["category"] for e in contenders}
    if any(cats <= sib and len(cats) > 1 for sib in _CONTEXT_SEPARABLE_SIBLINGS):
        anchored = [e for e in contenders if e.get("context_hit")]
        if anchored and len(anchored) < len(contenders):
            return anchored
    return contenders


def _pick_label(contenders: list[dict]) -> dict:
    """Choose which category names an overlap cluster. Deterministic.

    Five stages, most authoritative first:

      1. ARITHMETIC. A span whose checksum passed is not an opinion. If some
         contenders are validated, only they compete.
      1.5 CONTEXT, but only between declared siblings — see below.
      2. SPECIFICITY. `_SPECIFIC_OVER_GENERAL` encodes a semantic is-a fact
         ("an IBAN *is* a bank account number"), not a confidence judgement.
      3. MARGIN above the category's own floor — see _label_margin.
      4. FROZEN PRECEDENCE. Never iteration order.
    """
    # 0 — between declared siblings the words come FIRST. They share one
    # checksum, so arithmetic cannot separate them; letting it filter first only
    # decides who carries the `validated` stamp. A model span is stamped by
    # _apply_validators, a regex span is not, so "BSN 123456782" came back as a
    # tax number: the model's TaxIdentificationNumber passed the elfproef and
    # the regex BSN that said "BSN" never reached stage 1.5.
    contenders = _by_sibling_context(contenders)

    # 1 — arithmetic beats opinion.
    validated = [e for e in contenders if e.get("validated") is True]
    if validated:
        contenders = validated

    # 1.5 — CONTEXT decides between siblings that nothing else can separate.
    #
    # A Dutch RSIN and a BSN are both nine digits and both satisfy the SAME
    # elfproef; only the surrounding words differ. pii_regex.py said so in a
    # comment — "If both fire on the same span we want RSIN to win when the
    # anchor word is present" — but nothing implemented it, and it could not
    # work as written: _finalise sorts its input, so emission order is gone,
    # and both spans carry 0.99 while TaxIdentificationNumber's floor (0.55) is
    # HIGHER than NationalIdentificationNumber's (0.45), giving BSN the larger
    # margin. RSIN would have needed a confidence of 1.09 to win. Measured
    # consequence in eval/metrics.hybrid-newtiebreak.json:
    # "TaxIdentificationNumber->NationalIdentificationNumber": 5 — every
    # anchored RSIN in held-out was mislabelled, half that category's misses.
    #
    # Deliberately narrow. It fires only when the cluster's categories are a
    # DECLARED sibling pair, so it cannot leak into the Person/Address/URL
    # contests _SPECIFIC_OVER_GENERAL exists for. It is a set filter, so it is
    # order-independent. And it only ever changes the LABEL — the union extent
    # is computed by _finalise from the whole cluster either way, so
    # `union(kept) == union(input)` still holds and nothing stops being redacted.
    contenders = _by_sibling_context(contenders)

    def _rank(ent: dict) -> int:
        try:
            return _CATEGORY_PRECEDENCE.index(ent["category"])
        except ValueError:
            return len(_CATEGORY_PRECEDENCE)

    # 3 + 4 — highest margin, exact ties resolved by the frozen precedence
    # rather than by iteration order. Done as ONE key so the tie-break can
    # never be re-litigated after the specificity override below: resolving
    # ties afterwards would let precedence quietly undo a semantic decision.
    #
    # EQUAL CONFIDENCE IS NOT EVIDENCE. _label_margin subtracts the category's
    # floor to make scores from different softmax denominators comparable. That
    # reasoning holds for MODEL spans, which are samples from a distribution. It
    # does not hold when every contender carries the same constant — which is
    # exactly the deterministic case, since a PatternSpec emits a fixed
    # confidence. There `margin = constant - floor` reduces to `-floor`, so the
    # winner is simply whichever category has the lowest floor, and floors were
    # fitted to GLiNER score distributions rather than to any claim about which
    # reading of a string is right. Measured consequence: PhoneNumber (0.35) and
    # IBAN (0.35) beat NationalIdentificationNumber (0.45) on every shared span,
    # so a Swedish personnummer came back as `[phone_1]` and a French NIR that
    # happens to satisfy Luhn (one in ten do) as `[credit_card_1]`.
    #
    # _CATEGORY_PRECEDENCE is the table that answers this — "checksummed and
    # most determinate first", with IBAN, SSN and NationalIdentificationNumber
    # above PhoneNumber. It was already the tie-break; equal confidence is
    # simply the case that should have reached it.
    #
    # EXTENT FIRST, THOUGH. Precedence alone is too blunt, because two
    # deterministic candidates are not always describing the same text. On
    # "+49 151 79376392" the phone pattern matches all 16 characters while the
    # card pattern matches the 15 after the `+` — and a `+` is decisive evidence
    # of a phone number that the card reading cannot explain at all. Bare
    # precedence hands that span to CreditCardNumber (rank 3 beats rank 13),
    # which is how this change first measured -3.0pp card precision.
    #
    # So: the candidate that explains MORE of the text wins, and precedence only
    # separates candidates that explain the same amount. That is the same
    # principle _SPECIFICITY_MIN_COVERAGE and the containment handling in
    # _finalise already rest on — the covering span names the union — applied to
    # the one comparison that had no evidence of its own to go on.
    if len({round(e["confidence"], 9) for e in contenders}) == 1:
        best = max(contenders, key=lambda e: (e["length"], -_rank(e)))
    else:
        best = max(contenders, key=lambda e: (round(_label_margin(e), 9), -_rank(e)))

    # 2 — specificity, applied LAST because it is the most authoritative:
    # `_SPECIFIC_OVER_GENERAL` states an is-a fact ("an IBAN *is* a bank
    # account number"), not a confidence judgement. The band is measured in
    # MARGIN space, matching what `best` was chosen on — comparing a margin gap
    # against a raw-confidence band would mean a different thing per category.
    for e in contenders:
        if e is best:
            continue
        if (
            e["category"] in _SPECIFIC_OVER_GENERAL.get(best["category"], ())
            and _label_margin(best) - _label_margin(e) < _SPECIFICITY_BAND
        ):
            best = e
    return best


# Fraction of the merged extent a span must cover before it may name it.
# _finalise emits ONE label for the union of an overlapping cluster, so a label
# that describes only a sub-part makes a false claim about the whole span — the
# defect that returned the street "Ambachtsweg 103" as `[url_1]`. Set below 1.0
# because the IBAN/BankAccountNumber contest has real boundary jitter (a spaced
# IBAN reads a few characters longer); a genuine sub-part sits far lower.
_SPECIFICITY_MIN_COVERAGE = 0.80
