"""Region-scoped detection: the country patterns and what suppression may claim.

Why regions exist at all. `REGEX_COMPLETE_CATEGORIES` tells pii.py to stop asking
GLiNER about a category, and it used to be a hand-written global list while the
patterns behind NationalIdentificationNumber, TaxIdentificationNumber,
LicensePlateNumber and PassportNumber were Dutch-only. A German tenant therefore
had NEITHER detector for German identifiers: the model was suppressed and the
pattern could not match. Measured at up to 63.7pp recall on national ID and
81.8pp on licence plate.

So the load-bearing property here is not "more patterns". It is that suppression
is computed from the same registry that provides the coverage, per active region,
and can therefore never outrun it.

Stdlib only.
"""

from __future__ import annotations

import unittest

from app.services.pii_regex import (
    ANY_REGION,
    PatternSpec,
    REGEX_COMPLETE_CATEGORIES,
    SHIPPED_REGIONS,
    _SPECS,
    detect_regex_pii,
    normalise_regions,
    regex_complete_categories,
)


def _found(text: str, regions=None) -> set[tuple[str, str]]:
    return {
        (e["category"], e["text"])
        for e in detect_regex_pii(text, enabled_regions=regions)
    }


def _cats(text: str, regions=None) -> set[str]:
    return {c for c, _ in _found(text, regions)}


# Published valid identifiers, one row per country. Every value here is real
# (BZSt test number, INSEE example, canonical PESEL, …) so a failure means the
# pattern or the checksum is wrong rather than the fixture.
COUNTRY_CASES: tuple[tuple[str, str, str, str], ...] = (
    (
        "BE",
        "NationalIdentificationNumber",
        "85.07.30-033.28",
        "Mijn rijksregisternummer is 85.07.30-033.28.",
    ),
    ("BE", "TaxIdentificationNumber", "BE0123456789", "BTW-nummer BE0123456789."),
    ("BE", "LicensePlateNumber", "1-ABC-123", "Nummerplaat 1-ABC-123."),
    # The Steuer-IdNr is Germany's lifelong personal identifier (the country has
    # no separate national ID), so it is a National ID; the USt-IdNr is the
    # business VAT number and is the Tax one.
    ("DE", "NationalIdentificationNumber", "86095742719", "Steuer-ID: 86095742719."),
    ("DE", "TaxIdentificationNumber", "DE123456789", "USt-IdNr DE123456789."),
    # Ported from Presidio 2.2.364 (MIT). Both values are the published
    # examples from the respective specifications.
    (
        "DE",
        "NationalIdentificationNumber",
        "15070649C103",
        "Rentenversicherungsnummer 15070649C103.",
    ),  # DRV documentation
    (
        "DE",
        "HealthInsuranceNumber",
        "A000500015",
        "Krankenversichertennummer A000500015.",
    ),  # § 290 SGB V Anlage 1
    ("DE", "TaxIdentificationNumber", "0218150815012", "Steuernummer 0218150815012."),
    (
        "DE",
        "TaxIdentificationNumber",
        "123/456/78901",
        "Die Steuernummer 123/456/78901.",
    ),
    ("DE", "TaxIdentificationNumber", "HRB 12345", "eingetragen unter HRB 12345."),
    (
        "FR",
        "NationalIdentificationNumber",
        "2 69 05 49 588 157 80",
        "Mon NIR est 2 69 05 49 588 157 80.",
    ),
    ("FR", "LicensePlateNumber", "AB-123-CD", "Plaque AB-123-CD."),
    ("ES", "NationalIdentificationNumber", "12345678Z", "Mi DNI es 12345678Z."),
    ("ES", "NationalIdentificationNumber", "X1234567L", "Mi NIE es X1234567L."),
    ("ES", "LicensePlateNumber", "1234 BCD", "Matricula 1234 BCD."),
    (
        "IT",
        "NationalIdentificationNumber",
        "RSSMRA85M01H501Z",
        "Codice fiscale RSSMRA85M01H501Z.",
    ),
    ("IT", "TaxIdentificationNumber", "IT12345678901", "P.IVA IT12345678901."),
    ("PL", "NationalIdentificationNumber", "44051401359", "PESEL: 44051401359."),
    ("PL", "TaxIdentificationNumber", "1234563218", "NIP: 1234563218."),
    ("SE", "NationalIdentificationNumber", "811218-9876", "Personnummer 811218-9876."),
    ("AT", "NationalIdentificationNumber", "1237 010180", "SVNR 1237 010180."),
    ("AT", "TaxIdentificationNumber", "ATU12345678", "UID ATU12345678."),
    # United Kingdom, ported from Presidio 2.2.364 (MIT).
    (
        "GB",
        "NationalIdentificationNumber",
        "AB123456C",
        "National Insurance number AB123456C.",
    ),
    ("GB", "HealthInsuranceNumber", "943 476 5919", "NHS number 943 476 5919."),
    ("GB", "LicensePlateNumber", "AB51 CDE", "Registration AB51 CDE."),
    ("GB", "DriversLicenseNumber", "MORGA657054SM9IJ", "DVLA MORGA657054SM9IJ."),
    ("GB", "PassportNumber", "GB1234567", "Passport number GB1234567."),
    ("US", "TaxIdentificationNumber", "912-78-1234", "ITIN 912-78-1234."),
    ("US", "BankAccountNumber", "021000021", "Routing number 021000021."),
    ("NL", "NationalIdentificationNumber", "123456782", "Mijn BSN is 123456782."),
    ("NL", "LicensePlateNumber", "12-AB-34", "Kenteken 12-AB-34."),
)


class CountryCoverageTests(unittest.TestCase):
    def test_each_country_identifier_is_detected_in_its_own_region(self):
        for region, category, value, text in COUNTRY_CASES:
            with self.subTest(region=region, value=value):
                self.assertIn((category, value), _found(text, [region]))

    def test_each_country_identifier_is_detected_with_all_regions_on(self):
        """The shipped default is every region, so this is the real default path."""
        for region, category, value, text in COUNTRY_CASES:
            with self.subTest(region=region, value=value):
                self.assertIn((category, value), _found(text))

    def test_every_shipped_region_actually_has_patterns(self):
        declared = {r for spec in _SPECS for r in spec.regions} - {ANY_REGION}
        self.assertEqual(
            declared,
            set(SHIPPED_REGIONS),
            "SHIPPED_REGIONS is what the admin UI offers as a choice; a region in "
            "it with no patterns is a checkbox that does nothing",
        )


class RegionIsolationTests(unittest.TestCase):
    def test_a_foreign_identifier_is_not_detected_outside_its_region(self):
        de = "Meine Steuer-ID: 86095742719."
        self.assertIn("NationalIdentificationNumber", _cats(de, ["DE"]))
        self.assertNotIn("NationalIdentificationNumber", _cats(de, ["NL"]))

    def test_dutch_detection_is_unaffected_by_other_regions_being_on(self):
        nl = "Mijn BSN is 123456782 en kenteken 12-AB-34."
        self.assertEqual(_found(nl, ["NL"]), _found(nl))

    def test_country_neutral_patterns_ignore_the_region_filter(self):
        # Email/IBAN/card belong to no country; narrowing regions must not
        # silently switch them off.
        text = "mail jan@voorbeeld.nl, IBAN NL91ABNA0417164300"
        for regions in (None, ["NL"], ["US"], ["PL"]):
            with self.subTest(regions=regions):
                cats = _cats(text, regions)
                self.assertIn("Email", cats)
                self.assertIn("InternationalBankingAccountNumber", cats)

    def test_normalise_regions_treats_blank_and_star_as_everything(self):
        for value in (None, [], ["*"], ["  "], ["NL", "*"]):
            with self.subTest(value=value):
                self.assertIsNone(normalise_regions(value))
        self.assertEqual(normalise_regions([" nl ", "de"]), frozenset({"NL", "DE"}))


class SuppressionNeverOutrunsCoverageTests(unittest.TestCase):
    """The invariant the whole region mechanism exists to hold."""

    def test_a_category_is_only_complete_where_a_pattern_provides_it(self):
        for region in sorted(SHIPPED_REGIONS):
            complete = regex_complete_categories([region])
            for category in complete:
                providers = [
                    s
                    for s in _SPECS
                    if s.category == category
                    and s.complete
                    and (ANY_REGION in s.regions or region in s.regions)
                ]
                with self.subTest(region=region, category=category):
                    self.assertTrue(
                        providers,
                        f"{category} is suppressed for {region} with no pattern "
                        "covering it — the exact hole regions were added to close",
                    )

    def test_polish_national_ids_keep_the_model(self):
        """A concrete instance, because the general test above can pass vacuously.

        A PESEL is eleven bare digits with a mod-10 check, which admits ~10% of
        random numbers of that length — so it is anchor-required, and an anchored
        spec may not claim its category. NationalIdentificationNumber therefore
        must NOT be suppressed for a Polish tenant: the model has to keep
        answering for the PESELs written without a nearby keyword.
        """
        self.assertNotIn(
            "NationalIdentificationNumber",
            regex_complete_categories(["PL"]),
        )
        # The Netherlands (BSN, elfproef) and Germany (Steuer-IdNr in its spaced
        # written form, MOD 11,10) both do have unanchored coverage, so for them
        # the suppression is earned.
        self.assertIn("NationalIdentificationNumber", regex_complete_categories(["NL"]))
        self.assertIn("NationalIdentificationNumber", regex_complete_categories(["DE"]))

    def test_licence_plates_are_only_claimed_where_the_shape_is_distinctive(self):
        for region in ("NL", "FR", "ES"):
            self.assertIn(
                "LicensePlateNumber", regex_complete_categories([region]), region
            )
        # German, Italian, Polish, Swedish and Austrian plates need a context
        # anchor, so the model has to keep answering for them.
        for region in ("DE", "IT", "PL", "SE", "AT"):
            self.assertNotIn(
                "LicensePlateNumber", regex_complete_categories([region]), region
            )

    def test_all_regions_matches_the_expected_global_set(self):
        """Changing what is suppressed must be a deliberate act.

        eval/categories.WAS_REGEX is a frozen snapshot of the HISTORICAL set
        and the eval taxonomy self-checks against it, so a change here is a
        change to the measurement baseline — never a side effect of adding a
        pattern. Two deliberate changes are recorded in this expectation:

        * PhoneNumber left (phase A2): complete=True while the regex measured
          0.000 on 294/852 gold spans and the model measured 1.000 — demoted
          by the measured-completeness check (eval/check_completeness).
        """
        self.assertEqual(
            REGEX_COMPLETE_CATEGORIES,
            frozenset(
                {
                    "Email",
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
            ),
        )

    def test_an_unknown_region_only_suppresses_globally_valid_patterns(self):
        """`*` (regions=None) suppression is _ANY-only — the union bug's fix.

        The union over every country's complete specs meant a Polish tenant
        lost the model for NationalIdentificationNumber because the
        NETHERLANDS has a BSN pattern; an unanchored PESEL was then detected
        by NOTHING. With the region unknown, only patterns valid everywhere
        may silence the model; country-specific suppression must be EARNED by
        declaring the region.
        """
        unknown = regex_complete_categories(None)
        self.assertEqual(
            unknown,
            frozenset(
                {
                    "Email",
                    "URL",
                    "IPAddress",
                    "InternationalBankingAccountNumber",
                    "CreditCardNumber",
                    "ApiKeyOrSecret",
                }
            ),
        )
        for spelled_like_none in ([], ["*"], ["  "]):
            self.assertEqual(regex_complete_categories(spelled_like_none), unknown)
        # Declaring a region re-earns its suppression; the union view is still
        # reachable by declaring every shipped region.
        self.assertIn("NationalIdentificationNumber", regex_complete_categories(["NL"]))
        self.assertEqual(
            regex_complete_categories(SHIPPED_REGIONS), REGEX_COMPLETE_CATEGORIES
        )
        # Coverage is untouched by the narrowing: a Dutch BSN is still
        # DETECTED under regions=None — only the right to silence the model
        # changed. (123456782 satisfies the elfproef.)
        self.assertIn("NationalIdentificationNumber", _cats("BSN 123456782"))

    def test_an_anchored_spec_cannot_claim_its_category(self):
        import re

        with self.assertRaises(ValueError):
            PatternSpec(
                "Email",
                frozenset({"NL"}),
                re.compile(r"x"),
                pre_anchor=re.compile(r"y$"),
                complete=True,
            )

    def test_a_spec_must_declare_regions(self):
        import re

        with self.assertRaises(ValueError):
            PatternSpec("Email", frozenset(), re.compile(r"x"))


class CrossCountryPrecisionTests(unittest.TestCase):
    """Hard negatives, one per shape collision that actually bit."""

    def test_a_national_phone_pattern_does_not_swallow_a_national_id(self):
        """The regression that made the eval gate fail, kept as a test.

        With separators optional, the Spanish phone pattern reduced to "any nine
        digits starting 6-9" — which is also a Dutch BSN, a French SIREN and a US
        routing number. It won overlap resolution against the BSN it had eaten:
        PhoneNumber precision 0.927 -> 0.692 AND NationalIdentificationNumber
        recall 0.615 -> 0.385. A phone pattern that hides national IDs is worse
        than no phone pattern.
        """
        # A real BSN (elfproef-valid) that starts with 6, i.e. inside the Spanish
        # phone pattern's leading-digit range — the collision only exists here.
        bsn = "Mijn BSN is 600000011 en verder niets."
        found = _found(bsn)  # all regions, including ES
        self.assertIn(("NationalIdentificationNumber", "600000011"), found)
        self.assertNotIn("PhoneNumber", {c for c, _ in found})

    def test_ordinary_business_numbers_are_not_identifiers(self):
        text = (
            "Ordernummer 12345678, factuur 20240115, bedrag 1234567890, "
            "tijd 12:30:45, versie 1.2.3."
        )
        self.assertEqual(_found(text), set())

    def test_an_unanchored_bare_run_is_not_claimed_by_pl_or_de(self):
        """PESEL and Steuer-IdNr are bare 11-digit runs, so they need an anchor.

        Their checksums admit ~10% of random numbers of that length, and three
        countries share the shape. Without the anchor requirement, one valid-by-
        accident order number would be redacted as someone's national ID.
        """
        # A number that satisfies the PESEL checksum but has no keyword near it.
        self.assertEqual(_found("Referentie 44051401359 in het dossier."), set())
        # With the keyword, it is found.
        self.assertIn(
            ("NationalIdentificationNumber", "44051401359"),
            _found("PESEL: 44051401359", ["PL"]),
        )

    def test_anchored_us_identifiers_need_their_keyword(self):
        self.assertEqual(_found("Nummer 021000021 staat erbij.", ["US"]), set())
        self.assertIn(
            ("BankAccountNumber", "021000021"),
            _found("routing number 021000021", ["US"]),
        )


class AnchorGapTests(unittest.TestCase):
    """How far a keyword may sit from the value it anchors.

    The gap was separators only (`[\\s:#\\-]{0,10}`), which meant the keyword had
    to be effectively adjacent. "BSN: 123456789" anchored; "Het BSN is
    123456789" did not, and neither did any other sentence a person would
    actually write. Measured on the corpus, EVERY missed Polish PESEL and
    Austrian SVNR was a value whose keyword was present but one prose word too
    far away — PL recall 0.214, AT 0.500, for detectors working exactly as
    designed.

    Widening it to "up to 25 characters, none of them a digit" moved
    NationalIdentificationNumber recall +5.3pp and TaxIdentificationNumber
    +6.5pp, and added ZERO false positives — including zero on the hard-negatives
    split, checked before and after.
    """

    def test_a_keyword_reaches_across_ordinary_prose(self):
        for text in (
            "Het BSN is 44051401359",
            "Het BSN in dit dossier luidt 44051401359",
            "burgerservicenummer van betrokkene is 44051401359",
        ):
            self.assertIn(
                ("NationalIdentificationNumber", "44051401359"),
                _found(text, ["PL"]),
                text,
            )

    def test_a_keyword_may_not_reach_past_another_number(self):
        """The digit exclusion is what keeps the wider gap safe.

        Without it, one keyword would claim every number after it: "BSN
        123456782 en ordernummer 44051401359" would redact the order number as
        a second national ID.
        """
        found = _found("Het BSN 123456782 en het ordernummer 44051401359")
        self.assertIn(("NationalIdentificationNumber", "123456782"), found)
        self.assertNotIn(("NationalIdentificationNumber", "44051401359"), found)

    def test_the_gap_is_still_bounded(self):
        # 25 characters is the limit; a keyword a whole clause away must not
        # reach. (_scan's 40-character lookback bounds it a second time.)
        self.assertEqual(
            _found("BSN staat in de bijlage van het dossier bij 44051401359", ["PL"]),
            set(),
        )

    def test_an_anchor_word_must_be_a_whole_word(self):
        """The regression the wider gap exposed, kept as a test.

        `DL` is a legitimate abbreviation in the US driving-licence anchor, and
        the alternation had no word boundary — so it matched the "DL" inside the
        licence plate "LT20 ADL" and, across the newly widened gap, claimed a
        bank account twenty-one characters later as a driver's licence. Under
        the old separator-only gap the same bug existed and was simply out of
        reach.
        """
        found = _found("kenteken LT20 ADL, oud rekeningnummer 1764296280.")
        self.assertNotIn("DriversLicenseNumber", {c for c, _ in found})
        self.assertIn(("LicensePlateNumber", "LT20 ADL"), found)
        # The abbreviation still works when it really is one.
        self.assertIn(
            ("DriversLicenseNumber", "1764296280"),
            _found("DL number 1764296280", ["US"]),
        )


class PrecisionBudgetTests(unittest.TestCase):
    """An unanchored spec must be able to say no to noise.

    The old rule was "checksum-backed may go unanchored". Too coarse, and the
    UK NHS number is why: it has a real mod-11 check, but it sits on `\\d{3}
    \\d{3} \\d{4}` — ten digits, the most common shape there is — and mod-11
    lets 9.2% of random runs through. With GUARD_PII_REGIONS defaulting to `*`
    that pattern is live on Dutch text, so roughly one order number in eleven
    would have been redacted as someone's health record.

    The real rule is about the PAIR: shape specificity times checksum strength.
    A narrow shape carries a weak check (the Swedish personnummer's Luhn is only
    1-in-10, but the mandatory `-` separator does the work); a broad shape needs
    a strong one (mod-97, 1-in-97) or an anchor. This test measures the product
    directly instead of arguing about it — generate strings the pattern accepts,
    and see how many survive everything downstream.
    """

    # THIS NUMBER IS NOT A QUALITY CLAIM. It is the firing rate on a frozen
    # synthetic distribution, and it exists so that a pattern getting BROADER
    # shows up as a diff. Do not read it as "3% of real messages get a false
    # positive"; real text is not this dense in bare digit runs.
    #
    # What the residual is made of, all of it known and accepted:
    #   * long runs that satisfy Luhn      -> CreditCardNumber (~1 in 10)
    #   * nine-digit runs that satisfy the elfproef -> NationalIdentificationNumber
    #     (~1 in 11; the pattern is literally `\b\d{9}\b` plus the check)
    # Both are the price of detecting those categories without an anchor, and
    # both are why the categories that CANNOT afford it are anchor-required.
    _MAX_FIRING_RATE = 0.05

    @staticmethod
    def _business_noise(n=3000):
        """Sentences full of the numbers that are NOT identifiers.

        Order numbers, invoice references, quantities, dates, amounts, version
        strings — the things a support mailbox is actually full of. This is the
        population a broad pattern eats, so it is the population to measure
        against. Conditioning on "strings the pattern already matches" measures
        only the validator and reports 100% for every shape-only spec, which
        says nothing about whether the shape is safe.
        """
        import random

        rng = random.Random(20260730)
        frames = [
            "Ordernummer {} is verzonden op {}.",
            "Factuur {} bedraagt EUR {},- exclusief btw.",
            "Referentie {} hoort bij dossier {}.",
            "Het pakket {} is geleverd, tracking {}.",
            "Versie {} van artikel {} staat klaar.",
            "Aantal {} stuks, magazijnlocatie {}.",
            "Ticket {} is gesloten door team {}.",
        ]

        def token():
            kind = rng.random()
            if kind < 0.45:  # bare digit runs, all lengths
                return "".join(
                    str(rng.randint(0, 9)) for _ in range(rng.randint(4, 16))
                )
            # NO SPACE-GROUPED DIGIT RUNS. A 3-3-4 grouping is a NANP phone
            # number and a 4-4-4 one contains a trunk-0 group; detecting either
            # is the phone pattern working, not a false positive, and including
            # them made this test measure the generator instead of the code.
            if kind < 0.8:  # letter+digit codes
                return "".join(
                    rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
                    for _ in range(rng.randint(1, 3))
                ) + "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(3, 9)))
            if kind < 0.9:  # dates
                return f"{rng.randint(1, 28):02d}-{rng.randint(1, 12):02d}-20{rng.randint(10, 26)}"
            return f"{rng.randint(1, 9)}.{rng.randint(0, 20)}.{rng.randint(0, 40)}"

        return [rng.choice(frames).format(token(), token()) for _ in range(n)]

    def test_the_shipped_patterns_stay_quiet_on_ordinary_business_text(self):
        """Coarse canary. Catches something going wildly broad, and nothing subtler.

        Verified by construction: removing the NHS spec's anchor — the exact
        mistake this section is about — moves this number by 0.6pp and does NOT
        trip the ceiling, because only a fraction of the tokens here are ten
        digits long. That is why the per-spec check below exists and why this
        one is not the guard.
        """
        docs = self._business_noise()
        hits = [(d, e) for d in docs if (e := detect_regex_pii(d))]
        rate = len(hits) / len(docs)
        detail = "\n  ".join(
            f"{[(x['category'], x['text']) for x in e]}  in  {d!r}"
            for d, e in hits[:12]
        )
        self.assertLessEqual(
            rate,
            self._MAX_FIRING_RATE,
            f"patterns fire on {rate:.1%} of identifier-free business text "
            f"(ceiling {self._MAX_FIRING_RATE:.0%}); first offenders:\n  {detail}",
        )

    # Unanchored specs whose shape is bare digits and whose checksum admits more
    # than _MIN_REJECTION of them. Every entry is a DELIBERATE, documented cost;
    # the list exists so the cost is visible rather than implied.
    _ACCEPTED_WEAK_UNANCHORED = {
        # The elfproef admits ~1 in 11 nine-digit runs, and `\b\d{9}\b` is as
        # broad as a shape gets. Accepted because the alternative is worse:
        # measured model recall on an unanchored BSN is 0.04, so requiring an
        # anchor would mean Dutch citizen numbers are simply not detected in the
        # product's primary market. See app/services/pii_bsn.py.
        ("NationalIdentificationNumber", r"\b\d{9}\b"),
        # Luhn admits ~1 in 10, but a 13-19 digit run is already rare in prose
        # and an undetected card number is a payment-data leak.
        ("CreditCardNumber", r"\b(?:\d[\s\-]?){12,18}\d\b"),
        # Same Luhn rationale as the entry above. It re-emits only Luhn-valid
        # bare runs that the pattern above lost by joining a neighbouring
        # number (`klant 7 4111111111111111`), so it adds no new false
        # positives beyond what that pattern already accepts.
        ("CreditCardNumber", r"(?<!\d)\d{13,19}(?!\d)"),
    }
    _MIN_REJECTION = 0.95

    def test_a_weak_checksum_on_a_bare_digit_shape_must_be_anchored(self):  # noqa: C901
        """The rule, enforced per spec rather than in aggregate.

        Shape specificity times checksum strength. A shape made only of digits
        and separators brings no specificity at all, so the checksum has to
        carry it alone — mod-97 (1 in 97) can, mod-10 and mod-11 (1 in 10, 1 in
        11) cannot. Those need an anchor, and this is what says so.
        """
        import random
        import re as _re
        import app.services.pii_regex as pr

        rng = random.Random(777)
        offenders = []
        for spec in pr._COUNTRY_SPECS + pr._SPECS:
            if spec.pre_anchor is not None:
                continue
            src = spec.pattern.pattern
            # Does the shape demand anything but digits and separators?
            if _re.search(
                r"[A-Za-z](?![-\]])|A-Z|a-z", _re.sub(r"\\[dsbwSWD]", "", src)
            ):
                continue  # letters required — shape carries it
            # Sample strings this pattern actually matches, from digits alone.
            matched = []
            for _ in range(60000):
                if len(matched) >= 3000:
                    break
                s = "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(6, 20)))
                m = spec.pattern.search(s)
                if m and m.group(0):
                    matched.append(m.group(0))
            if len(matched) < 200:
                continue  # shape too rare to sample
            kept = 0
            for s in matched:
                if spec.validate is not None and not spec.validate(s):
                    continue
                ent = {
                    "text": s,
                    "category": spec.category,
                    "offset": 0,
                    "length": len(s),
                    "confidence": spec.confidence,
                }
                if spec.post_filter is not None and not spec.post_filter(ent):
                    continue
                kept += 1
            rejection = 1 - kept / len(matched)
            if rejection >= self._MIN_REJECTION:
                continue
            if (spec.category, src) in self._ACCEPTED_WEAK_UNANCHORED:
                continue
            offenders.append(
                f"{spec.category} {src!r} is unanchored but rejects only "
                f"{rejection:.1%} of the digit strings its own shape matches "
                f"(needs {self._MIN_REJECTION:.0%}, or a pre_anchor, or an entry "
                f"in _ACCEPTED_WEAK_UNANCHORED with a reason)"
            )
        self.assertEqual(offenders, [], "\n  ".join([""] + offenders))

    def test_what_the_anchor_on_a_broad_shape_is_worth(self):
        """The worked example the rule is built on, measured per SHAPE.

        The mixed corpus above dilutes this — only a fraction of its tokens are
        ten digits long — so the honest question is conditional: of the
        ten-digit order numbers a support mailbox contains, how many does the
        NHS spec claim? Anchored, none. Unanchored, one in eleven, because that
        is what a mod-11 check on a shape this common buys you.
        """
        import random
        import app.services.pii_regex as pr

        rng = random.Random(4242)
        runs = [
            "Ordernummer " + "".join(str(rng.randint(0, 9)) for _ in range(10))
            for _ in range(5000)
        ]

        anchored = sum(
            bool(
                pr._scan(
                    t,
                    pr._GB_NHS_RE,
                    "HealthInsuranceNumber",
                    validate=pr._is_valid_uk_nhs,
                    pre_anchor=pr._GB_NHS_ANCHOR_RE,
                )
                and list(
                    pr._scan(
                        t,
                        pr._GB_NHS_RE,
                        "HealthInsuranceNumber",
                        validate=pr._is_valid_uk_nhs,
                        pre_anchor=pr._GB_NHS_ANCHOR_RE,
                    )
                )
            )
            for t in runs
        )
        unanchored = sum(
            bool(
                list(
                    pr._scan(
                        t,
                        pr._GB_NHS_RE,
                        "HealthInsuranceNumber",
                        validate=pr._is_valid_uk_nhs,
                    )
                )
            )
            for t in runs
        )
        self.assertEqual(anchored, 0, "'Ordernummer' is not a health-insurance keyword")
        self.assertGreater(
            unanchored / len(runs),
            0.07,
            "a mod-11 check admits about one ten-digit run in eleven",
        )

    def test_the_nhs_number_is_the_case_this_rule_exists_for(self):
        """Pin the specific measurement, so the rule keeps its worked example."""
        import app.services.pii_regex as pr
        import random

        rng = random.Random(99)
        runs = [
            "".join(str(rng.randint(0, 9)) for _ in range(10)) for _ in range(20000)
        ]
        rate = sum(pr._is_valid_uk_nhs(r) for r in runs) / len(runs)
        self.assertGreater(rate, 0.08, "mod-11 should admit roughly one in eleven")
        # ...which is exactly why the spec carrying it is anchor-required.
        nhs = [s for s in pr._COUNTRY_SPECS if s.validate is pr._is_valid_uk_nhs]
        self.assertTrue(nhs, "the NHS spec disappeared")
        for s in nhs:
            self.assertIsNotNone(
                s.pre_anchor,
                "a ten-digit shape behind a 1-in-11 check must stay anchor-required",
            )
            self.assertFalse(s.complete)


class SpacedIbanTests(unittest.TestCase):
    """An IBAN written the way banks print it was not detected AT ALL.

    `_IBAN_RE` cannot match across a space, so `NL59 RABO 2654 2351 16` — the
    conventional groups-of-four layout, and roughly a fifth of how people paste
    them — produced nothing. Not a clipped span: nothing. Meanwhile the generic
    phone pattern matched fragments of the same string (`06 4746 87`), so the
    account left the guard unredacted while a piece of it was reported as a
    telephone number. Fixing the IBAN side moved IBAN recall +17.0pp AND phone
    precision +5.8pp, because they were one bug.
    """

    def _resolve(self, text):
        from app.services.pii import PiiService

        ents = detect_regex_pii(text)
        return [
            (e["category"], e["text"])
            for e in PiiService._finalise(ents, text=text)["entities"]
        ]

    def test_a_spaced_iban_is_detected_whole(self):
        for text, value in (
            (
                "Kun je overmaken naar NL59 RABO 2654 2351 16 alsjeblieft",
                "NL59 RABO 2654 2351 16",
            ),
            (
                "Betalingen lopen via IT47 5573 8573 6801 1923 6037 681 hier",
                "IT47 5573 8573 6801 1923 6037 681",
            ),
        ):
            self.assertIn(
                ("InternationalBankingAccountNumber", value), self._resolve(text), text
            )

    def test_the_match_stops_at_the_end_of_the_account(self):
        # A following all-caps token must not be swallowed — that would extend
        # the redaction over ordinary text and break the restore path.
        self.assertIn(
            ("InternationalBankingAccountNumber", "DE74 4203 1977 7486 7595 14"),
            self._resolve("rekening DE74 4203 1977 7486 7595 14 EUR 500"),
        )

    def test_mod_97_still_decides_the_confidence(self):
        # Before near-miss emission this asserted ABSENCE. The mod-97 verdict
        # still decides — but now it decides the confidence (0.99 vs the
        # demoted 0.693), not existence: a checksum-failing IBAN shape is a
        # typo'd real account and must be redacted, flagged as suspect.
        found = detect_regex_pii("Bedrag NL59 RABO 2654 2351 17 klopt niet")
        ibans = [
            e for e in found if e["category"] == "InternationalBankingAccountNumber"
        ]
        self.assertEqual([e["confidence"] for e in ibans], [0.693])
        self.assertEqual(ibans[0]["near_miss"], "checksum_failed")

    def test_no_phone_fragment_survives_a_spaced_iban(self):
        found = self._resolve("Betalingen lopen via ES18 6774 7226 4085 7216 9666")
        self.assertNotIn("PhoneNumber", {c for c, _ in found})


class UkPortTests(unittest.TestCase):
    """Details of the Presidio port that are easy to get subtly wrong."""

    def test_never_issued_nino_prefixes_are_rejected(self):
        for bad in (
            "BG123456C",
            "GB123456C",
            "NK123456C",
            "KN123456C",
            "NT123456C",
            "TN123456C",
            "ZZ123456C",
        ):
            self.assertEqual(_cats(f"Nummer {bad} hier", ["GB"]), set(), bad)

    def test_nino_letter_alphabets_are_position_specific(self):
        # D/F/I/Q/U/V are never used in either position, and O is additionally
        # excluded from the SECOND. Dropping that distinction is the easiest way
        # to port this pattern wrong.
        self.assertEqual(_cats("Nummer DA123456C", ["GB"]), set())
        self.assertEqual(_cats("Nummer AO123456C", ["GB"]), set())
        self.assertIn("NationalIdentificationNumber", _cats("Nummer OA123456C", ["GB"]))

    def test_plate_age_identifier_must_be_a_range_that_exists(self):
        # Only 02-29 (March) and 51-79 (September) are ever issued.
        for bad in ("AB01 CDE", "AB30 CDE", "AB50 CDE", "AB80 CDE"):
            self.assertEqual(_cats(f"kenteken {bad}", ["GB"]), set(), bad)
        for good in ("AB02 CDE", "AB29 CDE", "AB51 CDE", "AB79 CDE"):
            self.assertIn("LicensePlateNumber", _cats(f"kenteken {good}", ["GB"]), good)

    def test_the_nhs_number_needs_a_keyword(self):
        """Ten digits with a mod-11 check is not enough on its own.

        Measured: the checksum admits 9.2% of random ten-digit runs, and the
        3-3-4 grouping is also a US phone number and the tail of a spaced IBAN.
        """
        self.assertEqual(_cats("Referentie 943 476 5919 hier", ["GB"]), set())
        self.assertIn("HealthInsuranceNumber", _cats("NHS number 943 476 5919", ["GB"]))

    def test_the_nhs_anchor_speaks_the_products_languages(self):
        # A Dutch agent writes "polisnummer" about a UK number. Anchoring on
        # English alone left 26 corpus NHS numbers to the US phone pattern.
        self.assertIn(
            ("HealthInsuranceNumber", "943 476 5919"),
            _found("polisnummer 943 476 5919", ["GB"]),
        )

    def test_an_invalid_nhs_checksum_is_not_detected(self):
        self.assertEqual(_cats("NHS number 943 476 5918", ["GB"]), set())

    def test_a_dvla_licence_needs_a_well_formed_surname_field(self):
        # Positions 1-5 are the surname padded with TRAILING 9s; a 9 in the
        # middle means the 16-character match is a coincidence.
        self.assertIn("DriversLicenseNumber", _cats("MORGA657054SM9IJ", ["GB"]))
        self.assertEqual(_cats("99999657054SM9IJ", ["GB"]), set())
        self.assertEqual(_cats("MO9GA657054SM9IJ", ["GB"]), set())

    def test_uk_postcodes_are_deliberately_not_detected(self):
        # Upstream ships UK_POSTCODE at confidence 0.1. It is not a standalone
        # identifier, and the only category it could map to is Address — a fuzzy
        # GLiNER category whose spans are whole address blocks, so emitting a
        # postcode as one would make the extent lie. Same call as DE_PLZ.
        self.assertEqual(_cats("Adres: SW1A 1AA, Londen", ["GB"]), set())


class NearMissCounterTests(unittest.TestCase):
    """A shape that matched but died must leave a trace.

    Under tier=on the model is never asked about a complete category, so a
    checksum-fail or anchor-miss there is seen by NOTHING else. The counters
    are the only evidence that class of event exists at all — before them a
    near-miss died in a bare `continue` (pii_regex._scan) and the shadow-mode
    aggregate diff could not surface it either.
    """

    def test_checksum_fail_is_counted_even_when_not_emitted(self):
        # BSN is NOT in the near-miss opt-in set (bare nine digits), so an
        # elfproef failure is dropped — but the counter must still fire: the
        # counters are observability for EVERY near-miss, emitted or not.
        stats: dict = {}
        ents = detect_regex_pii("Referentie 123456789 hoort bij dossier.", stats=stats)
        self.assertEqual(
            [e for e in ents if e["category"] == "NationalIdentificationNumber"], []
        )
        self.assertEqual(
            stats["near_miss"].get("NationalIdentificationNumber:checksum_failed"), 1
        )

    def test_checksum_fail_is_counted_when_emitted_too(self):
        # IBAN IS opted in: the same event is both emitted (demoted) and
        # counted — emission never replaces the counter.
        stats: dict = {}
        ents = detect_regex_pii(
            "IBAN NL91ABNA0417164301 graag controleren.", stats=stats
        )
        self.assertEqual(
            [
                e["confidence"]
                for e in ents
                if e["category"] == "InternationalBankingAccountNumber"
            ],
            [0.693],
        )
        self.assertEqual(
            stats["near_miss"].get("InternationalBankingAccountNumber:checksum_failed"),
            1,
        )

    def test_anchor_miss_is_counted_not_emitted(self):
        stats: dict = {}
        ents = detect_regex_pii("Referentie 12345678 zonder ankerwoord.", stats=stats)
        self.assertEqual(
            [e for e in ents if e["category"] == "TaxIdentificationNumber"], []
        )
        self.assertEqual(
            stats["near_miss"].get("TaxIdentificationNumber:anchor_missing"), 1
        )

    def test_counts_carry_no_values(self):
        """Counts and category names only — the same privacy stance as the
        by_category log field. A value or offset in here would put PII in the
        applog."""
        stats: dict = {}
        detect_regex_pii("IBAN NL91ABNA0417164301 en nog 12345678.", stats=stats)
        for key, count in stats["near_miss"].items():
            category, reason = key.split(":")
            self.assertIn(reason, ("checksum_failed", "anchor_missing"), key)
            self.assertIsInstance(count, int)

    def test_a_valid_value_is_not_a_near_miss(self):
        stats: dict = {}
        ents = detect_regex_pii("IBAN NL91ABNA0417164300.", stats=stats)
        self.assertIn(
            "InternationalBankingAccountNumber", {e["category"] for e in ents}
        )
        self.assertNotIn(
            "InternationalBankingAccountNumber:checksum_failed",
            stats.get("near_miss", {}),
        )

    def test_no_stats_dict_means_no_overhead_and_no_error(self):
        # The default path (stats=None) must stay byte-identical.
        self.assertEqual(
            detect_regex_pii("IBAN NL91ABNA0417164300."),
            detect_regex_pii("IBAN NL91ABNA0417164300.", stats={}),
        )


class DutchPolisnummerTests(unittest.TestCase):
    """The category that was invisible in EVERY tier mode gets its first
    detector: regex had no NL pattern, model recall measured 0.07, and there
    is no checksum — so the anchored spec is the only precision-safe form.
    """

    def test_an_anchored_polisnummer_is_detected(self):
        for text in (
            "polisnummer AB12CD34EF bij de zorgverzekeraar",
            "Het polisnummer bij de zorgverzekeraar is 7Q2K9X4B.",
            "verzekerdennummer 123456789 staat op de zorgpas",  # digit-only real format
        ):
            self.assertIn("HealthInsuranceNumber", _cats(text), text)

    def test_without_an_anchor_nothing_fires(self):
        # Unanchored polisnummers stay model-only — the anchored-never-complete
        # rule keeps that honest (GLiNER is still asked about this category).
        self.assertNotIn(
            "HealthInsuranceNumber", _cats("Referentie AB12CD34EF is verwerkt.")
        )

    def test_an_all_letter_token_is_not_a_polisnummer(self):
        self.assertNotIn(
            "HealthInsuranceNumber", _cats("polisnummer ONBEKEND, wordt nagestuurd")
        )

    def test_the_spec_is_anchored_and_therefore_never_complete(self):
        self.assertNotIn("HealthInsuranceNumber", regex_complete_categories(["NL"]))

    def test_the_gb_nhs_number_still_wins_its_own_shape(self):
        # Shared anchor words, different value shapes: a grouped NHS number in
        # a Dutch sentence must still come back as the NHS detection.
        found = _found("polisnummer 943 476 5919", ["GB", "NL"])
        self.assertIn(("HealthInsuranceNumber", "943 476 5919"), found)


class NearMissEmissionTests(unittest.TestCase):
    """Demote-never-drop for the regex tier — the typo'd-identifier net.

    _apply_validators' rule ("Luhn fails on a real card number typed with a
    typo — which is still PII") was model-only, i.e. dead under tier=on for
    exactly the categories where checksums silence the model. Opt-in specs
    with DISTINCTIVE shapes now emit their checksum failures at
    confidence x REFUTED_CONFIDENCE_FACTOR instead of dropping them.

    The boundary of "distinctive" is load-bearing and pinned here: IBAN shape
    (country + check digits + >=15 chars total), GROUPED card notation, and
    the dashed SSN qualify; bare digit runs never do — an elfproef-failing
    nine-digit run is an order number ~10 times out of 11, and emitting those
    would flag half of commerce.
    """

    def _one(self, text: str, category: str) -> dict | None:
        hits = [e for e in detect_regex_pii(text) if e["category"] == category]
        return hits[0] if hits else None

    def test_a_typoed_iban_is_emitted_demoted_not_dropped(self):
        ent = self._one(
            "IBAN NL91ABNA0417164301 graag controleren.",
            "InternationalBankingAccountNumber",
        )
        self.assertIsNotNone(
            ent,
            "a mod-97-failing IBAN shape is a typo'd real account and must be redacted",
        )
        self.assertAlmostEqual(ent["confidence"], 0.693, places=3)
        self.assertIs(ent["validated"], False)
        self.assertEqual(ent["near_miss"], "checksum_failed")

    def test_a_valid_iban_is_untouched_by_the_near_miss_path(self):
        ent = self._one("IBAN NL91ABNA0417164300.", "InternationalBankingAccountNumber")
        self.assertEqual(ent["confidence"], 0.99)
        self.assertNotIn("near_miss", ent)
        self.assertNotIn("validated", ent)

    def test_a_spaced_typoed_iban_is_also_caught(self):
        ent = self._one(
            "Rekening NL91 ABNA 0417 1643 01 graag.",
            "InternationalBankingAccountNumber",
        )
        self.assertIsNotNone(ent)
        self.assertEqual(ent["near_miss"], "checksum_failed")

    def test_a_luhn_failing_GROUPED_card_is_emitted(self):
        ent = self._one(
            "Betaal met kaart 4111 1111 1111 1112 vandaag.", "CreditCardNumber"
        )
        self.assertIsNotNone(
            ent,
            "grouped 4-4-4-4 notation is card notation; "
            "a Luhn failure there is a mistyped card",
        )
        self.assertAlmostEqual(ent["confidence"], 0.693, places=3)

    def test_a_luhn_failing_BARE_run_is_still_dropped(self):
        # A bare 17-digit run that fails Luhn is as likely an order number as
        # a card; emitting it would redact ordinary commerce. The distinctive
        # GROUPING is what earns the emission, and only that.
        self.assertIsNone(
            self._one("Order 41111111111111129 is verzonden.", "CreditCardNumber")
        )

    def test_a_bad_range_ssn_is_emitted(self):
        ent = self._one("SSN 000-12-3456 is ingevuld.", "USSocialSecurityNumber")
        self.assertIsNotNone(
            ent,
            "the dashed 3-2-4 layout is distinctive on "
            "its own; a range failure is a mistyped SSN",
        )
        self.assertAlmostEqual(ent["confidence"], 0.693, places=3)

    def test_an_elfproef_failing_bare_run_is_still_dropped(self):
        # BSN is deliberately NOT opted in: its shape is `\b\d{9}\b`.
        self.assertIsNone(
            self._one(
                "Referentie 123456789 hoort bij dossier.",
                "NationalIdentificationNumber",
            )
        )

    def test_short_pseudo_iban_codes_no_longer_match_at_all(self):
        # ISO 13616 registers no IBAN under 15 chars total; the old 4..30 body
        # bound admitted every "AB123456" reference code, leaving mod-97 as
        # the only defence — untenable once failures are EMITTED.
        self.assertEqual(detect_regex_pii("Code AB123456 is de referentie."), [])

    def test_anchor_misses_are_never_softened(self):
        # A valid PESEL without its anchor word: the anchor IS the precision,
        # so near-miss emission must not resurrect it. (44051401359 passes the
        # mod-10 check; the spec is anchor-required.)
        self.assertEqual(
            [
                e
                for e in detect_regex_pii("Referentie 44051401359 in het dossier.")
                if e["category"] == "NationalIdentificationNumber"
            ],
            [],
        )

    def test_near_miss_requires_a_validator(self):
        import re

        with self.assertRaises(ValueError):
            PatternSpec("Email", frozenset({"NL"}), re.compile(r"x"), near_miss=True)

    def test_the_demotion_factor_is_imported_not_copied(self):
        from app.services.pii_regex import REFUTED_CONFIDENCE_FACTOR as regex_f
        from app.services.pii_validators import REFUTED_CONFIDENCE_FACTOR as val_f

        self.assertIs(regex_f, val_f)

    def test_near_miss_firing_rate_stays_under_the_ceiling(self):
        """The precision budget for emission, measured on business noise.

        The counters may fire freely (they are observability); EMISSION is a
        redaction and pays rent here. The ceiling is per-document over the
        same frozen noise distribution as PrecisionBudgetTests — a spec
        getting hotter shows up as a diff, and the fix is flipping that
        spec's near_miss flag back, not raising this number.
        """
        docs = PrecisionBudgetTests._business_noise()
        noisy = [
            (d, [e for e in ents if e.get("near_miss")])
            for d in docs
            if (ents := detect_regex_pii(d))
        ]
        firing = [(d, ents) for d, ents in noisy if ents]
        rate = len(firing) / len(docs)
        self.assertLessEqual(
            rate,
            0.005,
            f"near-miss emission fired on {rate:.2%} of business-noise "
            f"documents (ceiling 0.5%); examples: {firing[:3]}",
        )


class MeasuredCompletenessTests(unittest.TestCase):
    """The empirical completion of the suppression-never-outruns-coverage rule.

    SuppressionNeverOutrunsCoverageTests proves the STRUCTURAL half: a category
    is only complete where a pattern provides it. This class proves the
    EMPIRICAL half via eval.check_completeness: the pattern must also MEASURE
    well enough to justify silencing the model. PhoneNumber is the standing
    counter-example (complete for _ANY, recall 0.000 on four everyday shapes)
    until phase A2 demotes it — the check must keep detecting that row for as
    long as it exists.
    """

    report: dict

    @classmethod
    def setUpClass(cls) -> None:
        from eval.check_completeness import build_report

        cls.report = build_report(split="all")

    def _rows(self, verdict: str) -> list[dict]:
        return [r for r in self.report["rows"] if r["verdict"] == verdict]

    def test_phone_is_no_longer_claimed_complete(self):
        """The first claim this check ever caught, kept as the regression pin.

        PhoneNumber shipped complete=True while its regex measured 0.000 on
        four everyday shapes (bare Dutch mobile, bare landline, 0031-, NANP
        parenthesised) against model recall 1.000. The A2 demotion means it no
        longer appears among the claims AT ALL — reclaiming it must come with
        the recall evidence this check demands.
        """
        claimed = {(r["region"], r["category"]) for r in self.report["rows"]}
        self.assertNotIn(
            ("*", "PhoneNumber"),
            claimed,
            "PhoneNumber is claimed complete again — its regex "
            "must first prove >=0.90 recall AND >= model recall "
            "on every value_kind, including the bare forms",
        )

    def test_every_failure_is_allowlisted_with_a_removal_plan(self):
        from eval.check_completeness import ALLOWED_FAILURES

        for row in self._rows("FAIL"):
            key = f"{row['region']}:{row['category']}"
            self.assertIn(
                key,
                ALLOWED_FAILURES,
                f"unearned complete=True claim {key}: fix the spec "
                f"(complete=False) or the pattern — do not allowlist "
                f"without a phase that removes the entry",
            )
            self.assertTrue(
                ALLOWED_FAILURES[key].strip(),
                f"{key}: an allowlist entry needs its removal plan",
            )

    def test_failing_rows_name_the_missing_shapes(self):
        """The value_kind breakout is what makes a failure actionable."""
        for row in self._rows("FAIL"):
            kinds = row.get("value_kinds") or {}
            self.assertTrue(
                kinds, f"{row['category']}: FAIL row without its value_kind breakout"
            )
            self.assertTrue(
                any(k["recall"] < 1.0 for k in kinds.values()),
                f"{row['category']}: no value_kind under 1.0 — "
                f"then why did the row fail?",
            )

    def test_skips_are_loud_and_carry_the_reason(self):
        for row in self._rows("SKIP"):
            self.assertTrue(
                row.get("detail"),
                f"{row['region']}:{row['category']}: a silent SKIP "
                f"is a suppressed alarm",
            )

    def test_earned_claims_actually_measure_earned(self):
        """Every non-skipped, non-failing claim sits at or above the floor."""
        for row in self._rows("ok"):
            self.assertGreaterEqual(
                row["recall"], 0.90, f"{row['region']}:{row['category']}"
            )


if __name__ == "__main__":
    unittest.main()
