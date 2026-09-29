"""The pattern registry and the public entry points.

``_SPECS`` is the ordered list of every detector; ``detect_regex_pii`` runs the
ones that apply to the requested categories and regions, and
``regex_complete_categories`` says which categories may keep GLiNER out.
Order in ``_SPECS`` is load-bearing where two specs share a shape.
"""

from __future__ import annotations

from typing import Iterable

from . import at, be, de, es, fr, gb, generic, it, nl, pl, se, us
from .spec import (
    _ANY,
    _AT,
    _BE,
    _DE,
    _ES,
    _FR,
    _GB,
    _IT,
    _NL,
    _PL,
    _SE,
    _US,
    ANY_REGION,
    SHIPPED_REGIONS,
    PatternSpec,
    _digit_count_between,
    _scan,
)

# ── Country patterns: BE · DE · FR · ES · IT · PL · SE · AT · GB · US ───
#
# PRECISION RULE, applied throughout this block. A bare run of digits filtered
# only by a mod-10/mod-11 check still admits ~9-10% of random numbers of that
# length. One such pattern (the Dutch BSN) is an accepted cost; nine are not. So
# a country's identifier is unanchored ONLY when the written form carries a
# separator or a letter that makes it distinctive on its own. Otherwise the bare
# form requires a context anchor — and an anchored spec can never be `complete`,
# so GLiNER keeps answering for exactly the mentions the anchor would miss.
#
# The visible consequence: PESEL and Steuer-IdNr have no conventional separator,
# so those categories stay non-complete for PL/DE and the model keeps running.
# That is the conservative direction, and it is what the region-aware
# completeness computation exists to express.
_COUNTRY_SPECS: tuple[PatternSpec, ...] = (
    # ── Belgium ────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _BE,
        be._BE_NATID_DOTTED_RE,
        validate=be._is_valid_be_national_id,
        complete=True,
    ),
    PatternSpec(
        "NationalIdentificationNumber",
        _BE,
        be._BE_NATID_BARE_RE,
        validate=be._is_valid_be_national_id,
        pre_anchor=be._BE_NATID_ANCHOR_RE,
    ),
    PatternSpec("TaxIdentificationNumber", _BE, be._BE_VAT_RE, complete=True),
    PatternSpec("LicensePlateNumber", _BE, be._BE_PLATE_RE),
    # ── Germany ────────────────────────────────────────────────────────
    # The Steuer-IdNr is Germany's lifelong PERSONAL identifier — the country has
    # no separate national ID number, and the eval corpus (authored independently
    # of this detector) labels it NationalIdentificationNumber. The USt-IdNr below
    # is the business VAT number and is the one that belongs under Tax.
    PatternSpec(
        "NationalIdentificationNumber",
        _DE,
        de._DE_TAXID_SPACED_RE,
        validate=de._is_valid_iso7064_mod11_10,
        complete=True,
    ),
    PatternSpec(
        "NationalIdentificationNumber",
        _DE,
        de._DE_TAXID_BARE_RE,
        validate=de._is_valid_iso7064_mod11_10,
        pre_anchor=de._DE_NATID_ANCHOR_RE,
    ),
    PatternSpec("TaxIdentificationNumber", _DE, de._DE_VAT_RE, complete=True),
    # RVNR. The date structure plus the surname initial make the shape carry
    # itself; the mod-10 check alone would not.
    PatternSpec(
        "NationalIdentificationNumber",
        _DE,
        de._DE_RVNR_RE,
        validate=de._is_valid_de_rvnr,
    ),
    PatternSpec(
        "HealthInsuranceNumber",
        _DE,
        de._DE_KVNR_RE,
        validate=de._is_valid_de_kvnr,
        pre_anchor=de._DE_KVNR_ANCHOR_RE,
    ),
    PatternSpec(
        "TaxIdentificationNumber",
        _DE,
        de._DE_STEUERNUMMER_ELSTER_RE,
        pre_anchor=de._DE_STEUERNUMMER_ANCHOR_RE,
    ),
    PatternSpec("TaxIdentificationNumber", _DE, de._DE_STEUERNUMMER_SLASHED_RE),
    PatternSpec("TaxIdentificationNumber", _DE, de._DE_HRB_RE),
    PatternSpec(
        "LicensePlateNumber", _DE, de._DE_PLATE_RE, pre_anchor=de._DE_PLATE_ANCHOR_RE
    ),
    # ── France ─────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _FR,
        fr._FR_NIR_RE,
        validate=fr._is_valid_fr_nir,
        complete=True,
    ),
    PatternSpec("TaxIdentificationNumber", _FR, fr._FR_VAT_RE, complete=True),
    PatternSpec(
        "TaxIdentificationNumber",
        _FR,
        fr._FR_SIREN_RE,
        pre_anchor=fr._FR_SIREN_ANCHOR_RE,
    ),
    PatternSpec("LicensePlateNumber", _FR, fr._FR_PLATE_RE, complete=True),
    PatternSpec(
        "PhoneNumber", _FR, fr._FR_PHONE_RE, post_filter=_digit_count_between(10, 10)
    ),
    # ── Spain ──────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _ES,
        es._ES_DNI_RE,
        validate=es._is_valid_es_dni,
        complete=True,
    ),
    PatternSpec(
        "NationalIdentificationNumber",
        _ES,
        es._ES_NIE_RE,
        validate=es._is_valid_es_dni,
        complete=True,
    ),
    PatternSpec("TaxIdentificationNumber", _ES, es._ES_VAT_RE, complete=True),
    PatternSpec("LicensePlateNumber", _ES, es._ES_PLATE_RE, complete=True),
    PatternSpec(
        "PhoneNumber", _ES, es._ES_PHONE_RE, post_filter=_digit_count_between(9, 9)
    ),
    # ── Italy ──────────────────────────────────────────────────────────
    PatternSpec("NationalIdentificationNumber", _IT, it._IT_CF_RE, complete=True),
    PatternSpec("TaxIdentificationNumber", _IT, it._IT_VAT_RE, complete=True),
    PatternSpec(
        "LicensePlateNumber", _IT, it._IT_PLATE_RE, pre_anchor=it._IT_PLATE_ANCHOR_RE
    ),
    PatternSpec(
        "PhoneNumber", _IT, it._IT_PHONE_RE, post_filter=_digit_count_between(9, 10)
    ),
    # ── Poland ─────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _PL,
        pl._PL_PESEL_RE,
        validate=pl._is_valid_pl_pesel,
        pre_anchor=pl._PL_PESEL_ANCHOR_RE,
    ),
    PatternSpec("TaxIdentificationNumber", _PL, pl._PL_VAT_RE, complete=True),
    PatternSpec(
        "TaxIdentificationNumber",
        _PL,
        pl._PL_NIP_RE,
        validate=pl._is_valid_pl_nip,
        pre_anchor=pl._PL_NIP_ANCHOR_RE,
    ),
    PatternSpec(
        "LicensePlateNumber", _PL, pl._PL_PLATE_RE, pre_anchor=pl._PL_PLATE_ANCHOR_RE
    ),
    PatternSpec(
        "PhoneNumber", _PL, pl._PL_PHONE_RE, post_filter=_digit_count_between(9, 9)
    ),
    # ── Sweden ─────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _SE,
        se._SE_PERSONNUMMER_RE,
        validate=se._is_valid_se_personnummer,
        complete=True,
    ),
    PatternSpec("TaxIdentificationNumber", _SE, se._SE_VAT_RE, complete=True),
    PatternSpec(
        "TaxIdentificationNumber",
        _SE,
        se._SE_ORGNR_RE,
        validate=se._is_valid_se_personnummer,
        pre_anchor=se._SE_ORGNR_ANCHOR_RE,
    ),
    PatternSpec(
        "LicensePlateNumber", _SE, se._SE_PLATE_RE, pre_anchor=se._SE_PLATE_ANCHOR_RE
    ),
    # ── Austria ────────────────────────────────────────────────────────
    PatternSpec(
        "NationalIdentificationNumber",
        _AT,
        at._AT_SVNR_SPACED_RE,
        validate=at._is_valid_at_svnr,
        complete=True,
    ),
    PatternSpec(
        "NationalIdentificationNumber",
        _AT,
        at._AT_SVNR_BARE_RE,
        validate=at._is_valid_at_svnr,
        pre_anchor=at._AT_SVNR_ANCHOR_RE,
    ),
    PatternSpec("TaxIdentificationNumber", _AT, at._AT_VAT_RE, complete=True),
    PatternSpec(
        "LicensePlateNumber", _AT, at._AT_PLATE_RE, pre_anchor=at._AT_PLATE_ANCHOR_RE
    ),
    # ── United Kingdom ─────────────────────────────────────────────────
    # None of these is `complete`. NINO and the licence have no checksum at
    # all, the plate pattern covers only the 2001+ series, and the NHS spec is
    # anchor-required (which forbids `complete` outright). So GB keeps GLiNER
    # for every one of these categories and the regex tier is purely additive —
    # the conservative direction, and the honest one while UK coverage is one
    # release old.
    PatternSpec("NationalIdentificationNumber", _GB, gb._GB_NINO_RE),
    PatternSpec(
        "HealthInsuranceNumber",
        _GB,
        gb._GB_NHS_RE,
        validate=gb._is_valid_uk_nhs,
        pre_anchor=gb._GB_NHS_ANCHOR_RE,
    ),
    PatternSpec("LicensePlateNumber", _GB, gb._GB_PLATE_RE),
    PatternSpec(
        "DriversLicenseNumber",
        _GB,
        gb._GB_DL_RE,
        validate=gb._is_valid_uk_driving_licence,
    ),
    PatternSpec(
        "PassportNumber",
        _GB,
        gb._GB_PASSPORT_RE,
        pre_anchor=nl._DUTCH_PASSPORT_ANCHOR_RE,
    ),
    # ── United States ──────────────────────────────────────────────────
    PatternSpec("TaxIdentificationNumber", _US, us._US_ITIN_RE, complete=True),
    PatternSpec(
        "TaxIdentificationNumber", _US, us._US_EIN_RE, pre_anchor=us._US_EIN_ANCHOR_RE
    ),
    PatternSpec(
        "BankAccountNumber",
        _US,
        us._US_ROUTING_RE,
        validate=us._is_valid_aba_routing,
        pre_anchor=us._US_ROUTING_ANCHOR_RE,
    ),
    PatternSpec(
        "HealthInsuranceNumber",
        _US,
        us._US_MBI_RE,
        pre_anchor=us._US_MBI_ANCHOR_RE,
    ),
    PatternSpec(
        "DriversLicenseNumber",
        _US,
        us._US_DL_RE,
        pre_anchor=us._US_DL_ANCHOR_RE,
    ),
    PatternSpec(
        "PassportNumber", _US, us._US_PASSPORT_RE, pre_anchor=us._US_PASSPORT_ANCHOR_RE
    ),
    PatternSpec(
        "PhoneNumber", _US, us._US_PHONE_RE, post_filter=_digit_count_between(10, 10)
    ),
)

# Order is load-bearing where two specs share a shape — see the RSIN/BSN note.
_SPECS: tuple[PatternSpec, ...] = (
    PatternSpec("Email", _ANY, generic._EMAIL_RE, complete=True),
    PatternSpec("URL", _ANY, generic._URL_RE, complete=True),
    PatternSpec(
        "IPAddress",
        _ANY,
        generic._IPV4_RE,
        validate=generic._is_valid_ipv4,
        complete=True,
    ),
    PatternSpec(
        "IPAddress",
        _ANY,
        generic._IPV6_RE,
        validate=generic._is_valid_ipv6,
        complete=True,
    ),
    # The spaced form goes FIRST: it is the longer match, and putting it after
    # the contiguous pattern would leave the leading `NL59` group to be found on
    # its own and the rest of the account in cleartext.
    # near_miss on both IBAN specs: highest-value demote-never-drop in the
    # registry. A mod-97-failing IBAN-shaped token is a typo'd real account
    # (the shape — CC + 2 check digits + national BBAN layout — does not occur
    # by accident), the model is measurably no net (R 0.037 on the corpus),
    # and in a fail-closed DLP product redacting it at 0.69 is
    # privacy-correct. Guarded by the near-miss precision-budget test.
    PatternSpec(
        "InternationalBankingAccountNumber",
        _ANY,
        generic._IBAN_SPACED_RE,
        validate=generic._is_valid_iban,
        complete=True,
        near_miss=True,
    ),
    PatternSpec(
        "InternationalBankingAccountNumber",
        _ANY,
        generic._IBAN_RE,
        validate=generic._is_valid_iban,
        complete=True,
        near_miss=True,
    ),
    PatternSpec(
        "CreditCardNumber",
        _ANY,
        generic._CC_RE,
        validate=generic._is_valid_luhn,
        complete=True,
    ),
    # The grouped twin carries the near-miss (see _CC_GROUPED_RE): Luhn-fail
    # on the 4-4-4-4 / 4-6-5 grouping = mistyped card, emitted at 0.69;
    # Luhn-fail on a bare run = as likely an order number, still dropped. Not
    # `complete` — _CC_RE above already claims the category; this spec only
    # adds the demoted emission for the distinctive notation.
    PatternSpec(
        "CreditCardNumber",
        _ANY,
        generic._CC_GROUPED_RE,
        validate=generic._is_valid_luhn,
        near_miss=True,
    ),
    # RSIN runs BEFORE BSN: same 9-digit pattern and elfproef, but
    # context-anchored. If both fire on the same span we want RSIN
    # (TaxIdentificationNumber) to win when the anchor word is present.
    PatternSpec(
        "TaxIdentificationNumber",
        _NL,
        nl._RSIN_RE,
        validate=nl._is_valid_bsn,
        pre_anchor=nl._RSIN_ANCHOR_RE,
    ),
    PatternSpec(
        "NationalIdentificationNumber",
        _NL,
        nl._BSN_CANDIDATE_RE,
        validate=nl._is_valid_bsn,
        complete=True,
    ),
    # near_miss: the dashed 3-2-4 grouping is distinctive on its own; a
    # range-check failure (000/9xx area) on that exact layout is a mistyped
    # SSN, not a coincidence.
    PatternSpec(
        "USSocialSecurityNumber",
        _US,
        us._SSN_RE,
        validate=us._is_valid_ssn,
        complete=True,
        near_miss=True,
    ),
    *(
        PatternSpec("LicensePlateNumber", _NL, pat, complete=True)
        for pat in nl._NL_PLATE_RES
    ),
    PatternSpec("TaxIdentificationNumber", _NL, nl._BTW_RE, complete=True),
    # KVK Chamber of Commerce numbers — anchor-required to avoid eating
    # arbitrary 8-digit numbers (order IDs, dates, etc.).
    PatternSpec(
        "TaxIdentificationNumber", _NL, nl._KVK_RE, pre_anchor=nl._KVK_ANCHOR_RE
    ),
    # Dutch zorgverzekering polisnummer — the category that was invisible in
    # EVERY tier mode (regex had no NL pattern; model recall 0.07). There is
    # no checksum and no fixed national layout (insurers issue 8-10 chars,
    # digit-only or mixed), so the ONLY precision-safe detector is an anchored
    # one, mirroring the GB NHS port: the health-insurance words carry the
    # precision, the shape only bounds the extent. Anchored ⇒ structurally
    # never `complete` ⇒ purely additive — unanchored polisnummers remain
    # model-only, which the anchored-never-complete rule exists to keep
    # honest. The digit-count filter blocks all-letter tokens ("polisnummer
    # ONBEKEND") without excluding the digit-only real formats.
    PatternSpec(
        "HealthInsuranceNumber",
        _NL,
        nl._NL_POLIS_RE,
        pre_anchor=gb._GB_NHS_ANCHOR_RE,
        post_filter=_digit_count_between(1, 10),
    ),
    # Dutch passport — letters+digits pattern, anchor-required so we don't
    # tokenise random product codes (e.g. "NX1234567" in a SKU list). GLiNER
    # still runs for passports, which is what `complete=False` buys.
    PatternSpec(
        "PassportNumber",
        _NL,
        nl._DUTCH_PASSPORT_RE,
        pre_anchor=nl._DUTCH_PASSPORT_ANCHOR_RE,
    ),
    # DEMOTED from complete=True by the measured-completeness check
    # (eval/check_completeness): this pattern requires a separator or a +/0
    # prefix, so it measures recall 0.000 on the four most common real-world
    # shapes — bare Dutch mobile `0632181960` (0/143), bare landline (0/49),
    # `0031…` (7/49) and parenthesised NANP (0/53) — 294 of 852 gold phone
    # spans, while the model measures R 1.000. `complete=True` here meant a
    # tier=on deployment detected those numbers with NOTHING. The pattern
    # itself stays (it wins precision at 0.99 where it does match); demotion
    # only re-activates the model's `phone number` label as the recall net.
    PatternSpec(
        "PhoneNumber",
        _ANY,
        generic._PHONE_RE,
        post_filter=generic._phone_digits_ok,
    ),
    *(
        PatternSpec("ApiKeyOrSecret", _ANY, pat, complete=True)
        for _name, pat in generic._SECRET_RES
    ),
    PatternSpec(
        "ApiKeyOrSecret",
        _ANY,
        generic._HEX_SECRET_RE,
        pre_anchor=generic._HEX_SECRET_ANCHOR_RE,
        confidence=0.92,
    ),
    # Deliberately NOT complete. A Dutch-title pattern covers a sliver of the
    # people in real text; suppressing GLiNER for Person on that basis would be
    # the single most damaging thing this file could do.
    PatternSpec("Person", _NL, nl._DUTCH_TITLED_PERSON_RE, confidence=0.95),
    *_COUNTRY_SPECS,
)


def normalise_regions(
    enabled_regions: Iterable[str] | None,
) -> frozenset[str] | None:
    """Canonical region set, or None meaning "every region".

    None and {"*"} both mean "no restriction" so a caller can pass the guard's
    configured default through without special-casing it.
    """
    if enabled_regions is None:
        return None
    codes = frozenset(str(r).strip().upper() for r in enabled_regions if str(r).strip())
    if not codes or ANY_REGION in codes:
        return None
    return codes


def _spec_applies(spec: PatternSpec, regions: frozenset[str] | None) -> bool:
    return regions is None or ANY_REGION in spec.regions or bool(spec.regions & regions)


def regex_complete_categories(
    enabled_regions: Iterable[str] | None = None,
) -> frozenset[str]:
    """Categories this tier covers well enough to keep GLiNER out of them.

    Computed from the registry rather than hand-listed, because the hand-listed
    version could not know which regions were active. That is precisely how a
    non-Dutch tenant ended up with GLiNER suppressed for national IDs that only
    a Dutch pattern could match: the category was "complete" globally and empty
    locally.

    UNKNOWN REGION SUPPRESSES CONSERVATIVELY. ``None`` (the `*` default, and
    what every deployment that never sets GUARD_PII_REGIONS runs) used to take
    the UNION over every country's complete specs — so a Polish tenant lost
    the model for NationalIdentificationNumber because the NETHERLANDS has a
    BSN pattern, and an unanchored PESEL was then detected by nothing. When
    the region is unknown the tenant could be anywhere, including outside the
    shipped regions, so only a pattern valid EVERYWHERE (_ANY) may suppress.
    Coverage is untouched (detect_regex_pii still runs every spec under
    ``None``); only the right to silence the model narrows. Declaring regions
    re-earns the country-specific suppression — that is the latency lever.
    """
    regions = normalise_regions(enabled_regions)
    if regions is None:
        return frozenset(
            spec.category
            for spec in _SPECS
            if spec.complete and ANY_REGION in spec.regions
        )
    return frozenset(
        spec.category
        for spec in _SPECS
        if spec.complete and _spec_applies(spec, regions)
    )


# The union view: what is complete when every shipped region is declared.
# Kept as a module constant because callers and the eval taxonomy import it —
# note this is NOT what a region-less (`*`) deployment suppresses; that is
# regex_complete_categories(None), which is deliberately smaller (see above).
REGEX_COMPLETE_CATEGORIES: frozenset[str] = regex_complete_categories(SHIPPED_REGIONS)


def detect_regex_pii(
    text: str,
    enabled_categories: frozenset[str] | set[str] | None = None,
    enabled_regions: Iterable[str] | None = None,
    stats: dict | None = None,
) -> list[dict]:
    """Run the applicable regex detectors and return entity dicts.

    *enabled_categories* (if provided) restricts which detectors run —
    skipping a detector when the category isn't requested saves work.
    *enabled_regions* restricts by country; None means every region.
    *stats* (optional out-param) is filled with ``{"near_miss": {"<Category>:
    <reason>": count}}`` — how often a shape matched but was dropped by its
    checksum or missing anchor. Counts only, never values.
    """
    if not text:
        return []

    regions = normalise_regions(enabled_regions)
    near_miss = stats.setdefault("near_miss", {}) if stats is not None else None
    entities: list[dict] = []
    for spec in _SPECS:
        if enabled_categories is not None and spec.category not in enabled_categories:
            continue
        if not _spec_applies(spec, regions):
            continue
        for ent in _scan(
            text,
            spec.pattern,
            spec.category,
            validate=spec.validate,
            confidence=spec.confidence,
            pre_anchor=spec.pre_anchor,
            near_miss_counts=near_miss,
            near_miss=spec.near_miss,
        ):
            if spec.post_filter is None or spec.post_filter(ent):
                entities.append(ent)
    return entities
