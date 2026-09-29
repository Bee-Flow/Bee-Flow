"""Model-free tests for the PII eval harness (matcher / metrics / schema / corpus).

These run with no model download (stdlib + the regex tier only), so they gate
harness correctness cheaply in CI. A malformed corpus, a broken matcher, or a
metric regression fails here without a 2.5 GB model.

    python -m unittest tests.test_eval_harness
    pytest tests/test_eval_harness.py
"""

from __future__ import annotations

import os
import unittest

from eval.schema import (
    Record,
    Span,
    CANONICAL_CATEGORIES,
    CorpusError,
    validate_record,
    load_jsonl,
)
from eval.matcher import SpanTuple, iou, match_spans
from eval.leak import evaluate_leak
from eval.metrics import evaluate
from eval import value_banks as vb
from eval import validators as ev
from eval.categories import WAS_REGEX, HIGH_RISK, CLASS_MAPS, CONTROL_GROUP
from eval.run_eval import gate
from app.services.pii_regex import REGEX_COMPLETE_CATEGORIES, detect_regex_pii

_CORPUS_DIR = os.path.join(os.path.dirname(__file__), "..", "eval", "corpus")


class VendoringDriftTests(unittest.TestCase):
    """Guards the eval harness's vendored copies against silent drift.

    The harness deliberately owns its own category taxonomy (eval/categories.py)
    and checksum validators (eval/validators.py) so the corpus is not defined by
    the detector under test and survives the regex tier's deletion. While
    pii_regex.py still exists, these assert the copies are faithful.

    DELETE THIS WHOLE CLASS along with app/services/pii_regex.py — at that point
    there is nothing left to drift from, and the eval constants become the sole
    definition by design.
    """

    def test_was_regex_contains_production_set(self):
        # Equality held until phase A2 demoted PhoneNumber (complete=True with
        # measured recall 0.000 on 294/852 gold phone spans). WAS_REGEX is
        # frozen HISTORY — "what did the regex tier own before the cutover
        # work" — and history now correctly CONTAINS production: demotions
        # shrink the live set, never the snapshot. A category appearing in
        # production but not in history would mean the snapshot missed an
        # ownership transfer, which is still a bug.
        self.assertTrue(
            set(WAS_REGEX) >= set(REGEX_COMPLETE_CATEGORIES),
            "REGEX_COMPLETE_CATEGORIES grew beyond the WAS_REGEX snapshot: "
            f"{set(REGEX_COMPLETE_CATEGORIES) - set(WAS_REGEX)}",
        )
        # The demotions themselves are named, so a silent future demotion
        # still fails here and has to be recorded.
        self.assertEqual(
            set(WAS_REGEX) - set(REGEX_COMPLETE_CATEGORIES),
            {"PhoneNumber"},
            "the demoted set changed — record the new demotion (or its "
            "reversal) here and in eval/check_completeness's history",
        )

    def test_validators_agree_with_production(self):
        from app.services import pii_regex as pr

        cases = {
            "bsn": (
                ev.is_valid_bsn,
                pr._is_valid_bsn,
                ["123456782", "111222333", "000000000", "12345678", "abcdefghi", ""],
            ),
            "iban": (
                ev.is_valid_iban,
                pr._is_valid_iban,
                [
                    "NL91ABNA0417164300",
                    "NL91ABNA0417164301",
                    "NL91 ABNA 0417 1643 00",
                    "DE89370400440532013000",
                    "XX",
                    "NOTANIBAN",
                ],
            ),
            "luhn": (
                ev.is_valid_luhn,
                pr._is_valid_luhn,
                [
                    "4111111111111111",
                    "4111111111111112",
                    "79927398713",
                    "5555555555554444",
                    "1234",
                ],
            ),
            "ipv4": (
                ev.is_valid_ipv4,
                pr._is_valid_ipv4,
                ["192.0.2.1", "256.0.0.1", "1.2.3", "0.0.0.0", "a.b.c.d"],
            ),
            "ipv6": (
                ev.is_valid_ipv6,
                pr._is_valid_ipv6,
                [
                    "2001:db8::8a2e:370:7334",
                    "fe80::1",
                    "::1",
                    "fe80::",
                    "::ffff:192.0.2.1",
                    "12:30:45",
                    "aa:bb:cc:dd:ee:ff",
                    "",
                ],
            ),
            "ssn": (
                ev.is_valid_ssn,
                pr._is_valid_ssn,
                [
                    "123-45-6789",
                    "000-45-6789",
                    "666-45-6789",
                    "900-45-6789",
                    "123-00-6789",
                    "123-45-0000",
                ],
            ),
            # Country checksums. Three copies exist (eval/validators.py is
            # canonical, app/services/pii_validators.py is vendored for model
            # spans, pii_regex.py has a private copy for pattern spans), so each
            # positive sample is a published valid number and each negative is
            # the same number with the check digit changed.
            "de_mod11_10": (
                ev.is_valid_iso7064_mod11_10,
                pr._is_valid_iso7064_mod11_10,
                ["86095742719", "86095742718", "06095742719", "1234", ""],
            ),
            "be_natid": (
                ev.is_valid_be_national_id,
                pr._is_valid_be_national_id,
                ["85.07.30-033.28", "85073003328", "85073003327", "123", ""],
            ),
            "fr_nir": (
                ev.is_valid_fr_nir,
                pr._is_valid_fr_nir,
                ["269054958815780", "269054958815781", "1800112A1234554", "12345", ""],
            ),
            "es_dni": (
                ev.is_valid_es_dni,
                pr._is_valid_es_dni,
                ["12345678Z", "12345678A", "X1234567L", "X1234567A", ""],
            ),
            "pl_pesel": (
                ev.is_valid_pl_pesel,
                pr._is_valid_pl_pesel,
                ["44051401359", "44051401358", "4405140135", ""],
            ),
            "pl_nip": (
                ev.is_valid_pl_nip,
                pr._is_valid_pl_nip,
                ["1234563218", "1234563219", "123456321", ""],
            ),
            "se_pnr": (
                ev.is_valid_se_personnummer,
                pr._is_valid_se_personnummer,
                ["811218-9876", "811218-9875", "198112189876", "8112189876", ""],
            ),
            "at_svnr": (
                ev.is_valid_at_svnr,
                pr._is_valid_at_svnr,
                ["1237010180", "1230010180", "1237 010180", "123", ""],
            ),
            "aba": (
                ev.is_valid_aba_routing,
                pr._is_valid_aba_routing,
                ["021000021", "021000022", "02100002", ""],
            ),
            "uk_nhs": (
                ev.is_valid_uk_nhs,
                pr._is_valid_uk_nhs,
                [
                    "9434765919",
                    "943 476 5919",
                    "943-476-5919",
                    "9434765918",
                    "943476591",
                    "",
                ],
            ),
            "de_rvnr": (
                ev.is_valid_de_rvnr,
                pr._is_valid_de_rvnr,
                ["15070649C103", "15070649C104", "15990649C103", "1507064C103", ""],
            ),
            "de_kvnr": (
                ev.is_valid_de_kvnr,
                pr._is_valid_de_kvnr,
                ["A000500015", "A000500016", "A00050001", "0000500015", ""],
            ),
        }
        for name, (mine, theirs, samples) in cases.items():
            for s in samples:
                with self.subTest(validator=name, sample=s):
                    self.assertEqual(mine(s), theirs(s))

    def test_app_validators_agree_with_the_canonical_copy(self):
        """The THIRD copy — the one model spans go through.

        pii_validators.py vendors the same arithmetic for _validate_national_id.
        Nothing else compares those two files, so without this the model path and
        the pattern path could disagree about the same number.
        """
        from app.services import pii_validators as pv

        pairs = [
            (
                ev.is_valid_iso7064_mod11_10,
                pv.is_valid_iso7064_mod11_10,
                ["86095742719", "86095742718", "06095742719", ""],
            ),
            (
                ev.is_valid_be_national_id,
                pv.is_valid_be_national_id,
                ["85073003328", "85073003327", ""],
            ),
            (
                ev.is_valid_fr_nir,
                pv.is_valid_fr_nir,
                ["269054958815780", "269054958815781", ""],
            ),
            (ev.is_valid_es_dni, pv.is_valid_es_dni, ["12345678Z", "12345678A", ""]),
            (
                ev.is_valid_pl_pesel,
                pv.is_valid_pl_pesel,
                ["44051401359", "44051401358"],
            ),
            (
                ev.is_valid_se_personnummer,
                pv.is_valid_se_personnummer,
                ["811218-9876", "811218-9875"],
            ),
            (ev.is_valid_at_svnr, pv.is_valid_at_svnr, ["1237010180", "1230010180"]),
            (
                ev.is_valid_uk_nhs,
                pv.is_valid_uk_nhs,
                ["9434765919", "943 476 5919", "9434765918", ""],
            ),
        ]
        for canonical, vendored, samples in pairs:
            for s in samples:
                with self.subTest(fn=canonical.__name__, sample=s):
                    self.assertEqual(canonical(s), vendored(s))


class MatcherTests(unittest.TestCase):
    def test_iou(self):
        self.assertEqual(iou((0, 10), (0, 10)), 1.0)
        self.assertEqual(iou((0, 10), (20, 30)), 0.0)
        self.assertAlmostEqual(iou((0, 10), (5, 15)), 5 / 15)

    def test_strict_requires_exact(self):
        g = [SpanTuple(0, 10, "Person")]
        p = [SpanTuple(0, 9, "Person")]
        self.assertEqual(len(match_spans(g, p, mode="strict").tp), 0)
        self.assertEqual(len(match_spans(g, p, mode="overlap").tp), 1)

    def test_category_must_match(self):
        g = [SpanTuple(0, 10, "Person")]
        p = [SpanTuple(0, 10, "Organization")]
        mr = match_spans(g, p, mode="overlap")
        self.assertEqual(len(mr.tp), 0)
        self.assertEqual(mr.fp, [0])
        self.assertEqual(mr.fn, [0])
        # Overlapping different category -> confusion Person<-Organization.
        self.assertIn(("Person", "Organization", 1.0), mr.confusion)

    def test_one_to_one_greedy(self):
        # Two preds both overlap one gold; only the best-IoU one is a TP.
        g = [SpanTuple(0, 10, "Person")]
        p = [SpanTuple(0, 6, "Person"), SpanTuple(0, 10, "Person")]
        mr = match_spans(g, p, mode="overlap")
        self.assertEqual(len(mr.tp), 1)
        self.assertEqual(mr.tp[0][1], 1)  # the exact one (pred idx 1) wins
        self.assertEqual(mr.fp, [0])

    def test_missed_gold_is_confusion_to_empty(self):
        g = [SpanTuple(0, 10, "Person")]
        mr = match_spans(g, [], mode="overlap")
        self.assertEqual(mr.fn, [0])
        self.assertIn(("Person", "∅", 0.0), mr.confusion)


class MetricsTests(unittest.TestCase):
    def _rec(self, text, spans, **kw):
        return Record(
            id=kw.get("id", "r"),
            text=text,
            spans=tuple(spans),
            lang=kw.get("lang", "nl"),
            size_class=kw.get("size_class", "short"),
        )

    def test_perfect_and_missed(self):
        rec = self._rec(
            "Mark en Sanne",
            [Span(0, 4, "Person", "Mark"), Span(8, 13, "Person", "Sanne")],
        )
        preds = [[SpanTuple(0, 4, "Person"), SpanTuple(8, 13, "Person")]]
        rep = evaluate([rec], preds, regex_categories=REGEX_COMPLETE_CATEGORIES)
        pc = rep["overall"]["per_category"]["Person"]
        self.assertEqual((pc["tp"], pc["fp"], pc["fn"]), (2, 0, 0))
        self.assertEqual(pc["recall"], 1.0)

    def test_false_positive_and_negative_counts(self):
        rec = self._rec("Mark", [Span(0, 4, "Person", "Mark")])
        preds = [[SpanTuple(0, 4, "Organization")]]  # wrong category
        rep = evaluate([rec], preds, regex_categories=REGEX_COMPLETE_CATEGORIES)
        self.assertEqual(rep["overall"]["per_category"]["Person"]["fn"], 1)
        self.assertEqual(rep["overall"]["per_category"]["Organization"]["fp"], 1)

    def test_size_class_breakdown(self):
        r1 = self._rec(
            "Mark", [Span(0, 4, "Person", "Mark")], id="a", size_class="short"
        )
        r2 = self._rec(
            "Sanne", [Span(0, 5, "Person", "Sanne")], id="b", size_class="large"
        )
        preds = [[SpanTuple(0, 4, "Person")], []]
        rep = evaluate([r1, r2], preds, regex_categories=REGEX_COMPLETE_CATEGORIES)
        self.assertEqual(rep["by_size_class"]["short"]["micro"]["recall"], 1.0)
        self.assertEqual(rep["by_size_class"]["large"]["micro"]["recall"], 0.0)


class SchemaValidationTests(unittest.TestCase):
    def test_slice_mismatch_rejected(self):
        rec = Record(id="x", text="Mark", spans=(Span(0, 4, "Person", "WRONG"),))
        with self.assertRaises(CorpusError):
            validate_record(rec)

    def test_unknown_category_rejected(self):
        rec = Record(id="x", text="Mark", spans=(Span(0, 4, "Nope", "Mark"),))
        with self.assertRaises(CorpusError):
            validate_record(rec)

    def test_overlap_rejected(self):
        rec = Record(
            id="x",
            text="Mark Jansen",
            spans=(Span(0, 6, "Person", "Mark J"), Span(5, 11, "Person", "Jansen")),
        )
        with self.assertRaises(CorpusError):
            validate_record(rec)

    def test_valid_record_passes(self):
        rec = Record(id="x", text="Mark", spans=(Span(0, 4, "Person", "Mark"),))
        validate_record(rec)  # no raise


class ValueBankTests(unittest.TestCase):
    def test_checksum_values_are_well_formed(self):
        """Generated identifiers must satisfy their own checksum.

        This replaces an older test that asserted every generated value was
        *detected by the regex tier*. That assertion made the corpus circular:
        it could only ever contain values the outgoing detector already found,
        which is why the regex tier scored recall 1.0000 on it — a tautology,
        not a measurement. It also actively blocked adding realistic formats
        (a bare `0644137044` is a real phone number and was rejected by the
        test purely because `_PHONE_RE` needs a separator).

        The corpus contract is now about the VALUE, not about any detector:
        an IBAN really satisfies mod-97, a BSN really satisfies the elfproef.

        Keyed on VALUE_KIND, not category. It used to map
        NationalIdentificationNumber to the Dutch elfproef, which held only
        because Dutch documents were barred from containing a foreign
        identifier. They no longer are — a Dutch care provider writes Dutch
        prose about a Polish employee's PESEL — and one category now spans nine
        different algorithms. Checking the wrong one is not a stricter test, it
        is a test of something else: it failed a perfectly valid Steuer-IdNr
        for not being a BSN.
        """
        import random

        rng = random.Random(7)
        digits_only = lambda v: "".join(c for c in v if c.isdigit())  # noqa: E731
        checks = {
            "bsn_valid": ev.is_valid_bsn,
            "natid_de": lambda v: ev.is_valid_iso7064_mod11_10(digits_only(v)),
            "natid_be": ev.is_valid_be_national_id,
            "natid_fr": ev.is_valid_fr_nir,
            "natid_es": ev.is_valid_es_dni,
            "natid_pl": ev.is_valid_pl_pesel,
            "natid_se": ev.is_valid_se_personnummer,
            "natid_at": ev.is_valid_at_svnr,
            "natid_rvnr_de": ev.is_valid_de_rvnr,
            "health_ins_gb": ev.is_valid_uk_nhs,
            "health_ins_de": ev.is_valid_de_kvnr,
            "credit_card_test": ev.is_valid_luhn,
            "ssn_us": ev.is_valid_ssn,
            "ipv4_doc": ev.is_valid_ipv4,
        }
        # Italian codice fiscale (CIN) and the UK NINO have no checksum we
        # verified, so their values are shape-only by design — see the note in
        # eval/validators.py on why an unverified checksum is worse than none.
        no_checksum = {"natid_it", "natid_gb", "health_ins_nl"}
        # Deliberately INVALID kinds: the typo'd-identifier population the
        # near-miss demote-never-drop emission is measured on. The contract
        # inverts — the value must FAIL its checksum, or it is not a typo.
        invalid_by_design = {
            "iban_typo": ev.is_valid_iban,
            "cc_typo": ev.is_valid_luhn,
            "ssn_bad_range": ev.is_valid_ssn,
        }

        seen: set[str] = set()
        for cat in (
            "InternationalBankingAccountNumber",
            "CreditCardNumber",
            "NationalIdentificationNumber",
            "USSocialSecurityNumber",
            "IPAddress",
            "HealthInsuranceNumber",
        ):
            for lang in ("nl", "de", "fr", "es", "it", "en"):
                for _ in range(60):
                    val, kind = vb.generate(cat, rng, lang)
                    seen.add(kind)
                    if kind in no_checksum:
                        continue
                    if kind in invalid_by_design:
                        with self.subTest(kind=kind, value=val):
                            self.assertFalse(
                                invalid_by_design[kind](val),
                                f"{kind} value {val!r} PASSES its checksum — "
                                f"then it is not a typo and mismeasures the "
                                f"near-miss net",
                            )
                        continue
                    check = (
                        ev.is_valid_iban
                        if kind.startswith("iban_")
                        else checks.get(kind)
                    )
                    if check is None:
                        continue
                    with self.subTest(kind=kind, value=val):
                        self.assertTrue(
                            check(val), f"{kind} value {val!r} fails its own checksum"
                        )

        # A generator that silently stops emitting a country would leave that
        # country's detector unmeasured while every test still passed — which is
        # exactly how BE, PL, SE and AT ended up with zero corpus values.
        # The typo kinds are part of the same contract: if they vanish, the
        # near-miss net goes unmeasured while its tests stay green.
        for kind in set(checks) | no_checksum | set(invalid_by_design):
            self.assertIn(kind, seen, f"no {kind} value was generated at all")

    def test_phone_formats_include_the_bare_forms(self):
        """The corpus must contain the formats a regex CANNOT match.

        A bare `0644137044` has no separator and no `+`, so `_PHONE_RE` misses
        it — and it is the single most common way a Dutch user types their
        mobile. If the generator ever stops emitting these, the corpus silently
        goes back to only asking questions the regex tier can answer.
        """
        import random

        rng = random.Random(11)
        kinds = {vb.gen_phone(rng, "nl")[1] for _ in range(400)}
        for required in (
            "phone_nl_mobile_bare",
            "phone_nl_landline_bare",
            "phone_nl_mobile_spaced",
        ):
            self.assertIn(required, kinds)


class CoverModeTests(unittest.TestCase):
    """`cover` mode: the prediction must FULLY CONTAIN the gold span."""

    def test_clipped_span_is_a_hit_in_overlap_but_not_in_cover(self):
        # The whole reason cover mode exists. A prediction covering 80% of an
        # IBAN scores as a clean TP at IoU>=0.5, yet the uncovered characters
        # stay in the prompt because Node redacts by splicing offset/length.
        g = [SpanTuple(0, 10, "InternationalBankingAccountNumber")]
        p = [SpanTuple(0, 8, "InternationalBankingAccountNumber")]
        self.assertEqual(len(match_spans(g, p, mode="overlap").tp), 1)
        self.assertEqual(len(match_spans(g, p, mode="cover").tp), 0)

    def test_over_extended_span_still_covers(self):
        g = [SpanTuple(5, 10, "Person")]
        p = [SpanTuple(0, 20, "Person")]
        self.assertEqual(len(match_spans(g, p, mode="cover").tp), 1)

    def test_exact_span_covers(self):
        g = [SpanTuple(0, 10, "Email")]
        p = [SpanTuple(0, 10, "Email")]
        self.assertEqual(len(match_spans(g, p, mode="cover").tp), 1)


class LeakMetricTests(unittest.TestCase):
    """redaction_recall (safety) vs label_recall (quality)."""

    def _rec(self, text, spans):
        return Record(
            id="t",
            text=text,
            spans=tuple(spans),
            lang="nl",
            size_class="short",
            source="test",
        )

    def test_mislabelled_but_fully_covered_is_not_a_leak(self):
        # An IBAN tagged BankAccountNumber is still fully redacted — the token
        # just reads [bank_account_number_1]. Safety is intact, quality is not.
        rec = self._rec(
            "iban NL91ABNA0417164300 x",
            [Span(5, 23, "InternationalBankingAccountNumber", "NL91ABNA0417164300")],
        )
        preds = [[SpanTuple(5, 23, "BankAccountNumber")]]
        out = evaluate_leak([rec], preds)
        cat = out["per_category"]["InternationalBankingAccountNumber"]
        self.assertEqual(cat["redaction_recall"], 1.0)  # safe
        self.assertEqual(cat["label_recall"], 0.0)  # wrong token name
        self.assertEqual(cat["label_only_failures"], 1)
        self.assertEqual(cat["partial_leak_rate"], 0.0)

    def test_partial_cover_is_flagged_as_the_dangerous_class(self):
        rec = self._rec(
            "iban NL91ABNA0417164300 x",
            [Span(5, 23, "InternationalBankingAccountNumber", "NL91ABNA0417164300")],
        )
        preds = [[SpanTuple(5, 19, "InternationalBankingAccountNumber")]]
        out = evaluate_leak([rec], preds)
        cat = out["per_category"]["InternationalBankingAccountNumber"]
        self.assertEqual(cat["partial_leak_rate"], 1.0)
        self.assertEqual(cat["redaction_recall"], 0.0)
        self.assertEqual(cat["leaked_chars"], 4)
        self.assertGreater(cat["leaked_alnum_chars"], 0)
        self.assertEqual(
            out["worst_partial"][0]["category"], "InternationalBankingAccountNumber"
        )

    def test_zero_cover_is_a_miss_not_a_partial(self):
        rec = self._rec(
            "iban NL91ABNA0417164300 x",
            [Span(5, 23, "InternationalBankingAccountNumber", "NL91ABNA0417164300")],
        )
        out = evaluate_leak([rec], [[]])
        cat = out["per_category"]["InternationalBankingAccountNumber"]
        self.assertEqual(cat["zero_miss_rate"], 1.0)
        self.assertEqual(cat["partial_leak_rate"], 0.0)

    def test_union_of_two_partial_spans_can_fully_cover(self):
        # Coverage is computed over the UNION of all predictions of ANY
        # category — two adjacent partial spans together redact the value.
        rec = self._rec(
            "iban NL91ABNA0417164300 x",
            [Span(5, 23, "InternationalBankingAccountNumber", "NL91ABNA0417164300")],
        )
        preds = [
            [
                SpanTuple(5, 15, "InternationalBankingAccountNumber"),
                SpanTuple(15, 23, "BankAccountNumber"),
            ]
        ]
        out = evaluate_leak([rec], preds)
        cat = out["per_category"]["InternationalBankingAccountNumber"]
        self.assertEqual(cat["redaction_recall"], 1.0)
        self.assertEqual(cat["leaked_chars"], 0)

    def test_over_redaction_is_counted(self):
        rec = self._rec("hallo Jan hier", [Span(6, 9, "Person", "Jan")])
        preds = [[SpanTuple(0, 14, "Person")]]
        out = evaluate_leak([rec], preds)
        self.assertEqual(out["overall"]["redaction_recall"], 1.0)
        self.assertEqual(out["overall"]["over_redaction_chars"], 11)


class CorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = []
        for f in ("short.jsonl", "large.jsonl", "negatives.jsonl"):
            path = os.path.join(_CORPUS_DIR, f)
            cls.records.extend(load_jsonl(path))  # re-validates every span

    def test_corpus_loads_and_validates(self):
        self.assertGreater(len(self.records), 100)

    def test_covers_all_21_categories(self):
        present = set()
        for r in self.records:
            present |= r.categories_present
        missing = CANONICAL_CATEGORIES - present
        self.assertEqual(
            missing, set(), f"corpus is missing categories: {sorted(missing)}"
        )

    def test_large_docs_have_deep_tail_entities(self):
        large = [r for r in self.records if r.size_class == "large"]
        self.assertTrue(large)
        deep_total = sum(r.meta.get("spans_past_1400", 0) for r in large)
        self.assertGreater(
            deep_total, 50, "large corpus lacks deep-tail entities for truncation tests"
        )

    def test_regex_tier_pipeline_runs_end_to_end(self):
        """Model-free smoke: schema -> detector -> matcher -> metrics.

        The recall bar here used to be 0.98, which quietly encoded "the corpus
        may only contain what the regex tier already finds". Once the corpus
        gained realistic formats (bare phone numbers, KVK/RSIN tax ids behind
        natural phrasing) the true figure fell to ~0.88 — the tier had not
        regressed, the corpus had stopped flattering it.

        So this asserts the PIPELINE works, with a loose floor that catches a
        genuinely broken detector without dictating what the corpus may hold.
        The precise per-category numbers belong in the eval baselines, which
        are reviewed snapshots, not in a unit test.
        """
        from app.services.pii import PiiService

        preds = []
        for r in self.records:
            resolved = PiiService._finalise(detect_regex_pii(r.text), text=r.text)[
                "entities"
            ]
            preds.append(
                [
                    SpanTuple(
                        int(e["offset"]),
                        int(e["offset"]) + int(e["length"]),
                        e["category"],
                        e["confidence"],
                    )
                    for e in resolved
                ]
            )
        rep = evaluate(self.records, preds, regex_categories=WAS_REGEX)
        micro = rep["by_tier"]["regex"]["micro"]
        self.assertGreater(
            micro["recall"], 0.5, "regex tier looks broken, not merely out-performed"
        )
        self.assertGreater(
            micro["precision"],
            0.9,
            "regex tier precision collapsed — check the new negatives",
        )

    def test_corpus_contains_formats_regex_cannot_match(self):
        """The corpus must keep asking questions the regex tier gets wrong.

        This is the anti-tautology guard. If every gold span were regex-findable
        the corpus could never measure a detector change — it would only ever
        confirm the incumbent. Bare phone numbers are the canonical example.
        """
        from app.services.pii import PiiService

        missed = 0
        for r in self.records:
            found = {
                (e["offset"], e["category"])
                for e in PiiService._finalise(detect_regex_pii(r.text), text=r.text)[
                    "entities"
                ]
            }
            for s in r.spans:
                if s.category in WAS_REGEX and (s.start, s.category) not in found:
                    missed += 1
        self.assertGreater(
            missed,
            20,
            "corpus has drifted back to only containing regex-friendly "
            "values; re-add realistic formats before trusting any baseline",
        )


class GateSelfTests(unittest.TestCase):
    """The gate needs its own regression tests, or a silent gate looks green.

    Every check below corresponds to a real way the model-only cutover can go
    wrong. They are asserted by feeding gate() a synthetic report with exactly
    one defect injected, so a check that stops firing fails here rather than
    six months later on a production regression.

    Model-free by construction: gate() only reads dicts.
    """

    @staticmethod
    def _scope(f1=0.90, precision=0.90, recall=0.90, per_category=None):
        return {
            "micro": {"f1": f1, "precision": precision, "recall": recall, "f2": recall},
            "per_category": per_category or {},
        }

    @classmethod
    def _report(cls, **over):
        """A clean report that passes every check."""
        # 60 gold spans per HIGH_RISK category, so nothing is skipped by the
        # statistical-resolution guard.
        cats = {
            c: {
                "tp": 54,
                "fp": 6,
                "fn": 6,
                "precision": 0.90,
                "recall": 0.90,
                "f1": 0.90,
                "f2": 0.90,
            }
            for c in HIGH_RISK
        }
        rep = {
            "overall": cls._scope(per_category=cats),
            "control_group": {
                "micro": {"f1": 0.80, "precision": 0.8, "recall": 0.8, "f2": 0.8}
            },
            "mode_micro": {
                "cover": {"recall": 0.95, "precision": 0.9, "f1": 0.92, "f2": 0.93}
            },
            "leak": {
                "overall": {
                    "redaction_recall": 0.95,
                    "partial_leak_rate": 0.02,
                    "over_redaction_rate": 0.001,
                }
            },
            "degraded_rate": 0.0,
            # gate() refuses to compare reports that scored different corpora,
            # so even synthetic reports must carry a lock.
            "meta": {
                "corpus_lock": {
                    "large.jsonl": "aa",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                }
            },
        }
        rep.update(over)
        return rep

    def _fails(self, report, baseline=None, tol=0.02):
        return gate(report, baseline or self._report(), tol, "all")

    def test_clean_report_passes(self):
        self.assertEqual(self._fails(self._report()), [])

    def test_over_redacting_detector_is_caught(self):
        """The failure the old gate could not see.

        Perfect recall, collapsed precision. Old gate: micro F1 checked, recall
        checked, degraded checked — all fine. With Node defaulting to
        fail_closed + action=block, this ships as an outage.
        """
        cats = {
            c: {
                "tp": 60,
                "fp": 400,
                "fn": 0,
                "precision": 0.13,
                "recall": 1.0,
                "f1": 0.23,
                "f2": 0.44,
            }
            for c in HIGH_RISK
        }
        bad = self._report(
            overall=self._scope(f1=0.23, precision=0.13, recall=1.0, per_category=cats)
        )
        fails = self._fails(bad)
        self.assertTrue(any("precision" in f for f in fails), fails)

    def test_redaction_recall_regression_is_caught(self):
        bad = self._report(
            leak={
                "overall": {
                    "redaction_recall": 0.80,
                    "partial_leak_rate": 0.02,
                    "over_redaction_rate": 0.001,
                }
            }
        )
        self.assertTrue(any("redaction_recall" in f for f in self._fails(bad)))

    def test_partial_leak_regression_is_caught(self):
        """Clipped spans score as true positives in overlap mode."""
        bad = self._report(
            leak={
                "overall": {
                    "redaction_recall": 0.95,
                    "partial_leak_rate": 0.30,
                    "over_redaction_rate": 0.001,
                }
            }
        )
        self.assertTrue(any("partial_leak_rate" in f for f in self._fails(bad)))

    def test_over_redaction_rate_regression_is_caught(self):
        bad = self._report(
            leak={
                "overall": {
                    "redaction_recall": 0.95,
                    "partial_leak_rate": 0.02,
                    "over_redaction_rate": 0.40,
                }
            }
        )
        self.assertTrue(any("over_redaction_rate" in f for f in self._fails(bad)))

    def test_cover_mode_regression_is_caught(self):
        bad = self._report(
            mode_micro={
                "cover": {"recall": 0.50, "precision": 0.9, "f1": 0.6, "f2": 0.6}
            }
        )
        self.assertTrue(any("cover-mode" in f for f in self._fails(bad)))

    def test_control_group_drift_is_caught_in_BOTH_directions(self):
        """An unexplained improvement invalidates the experiment too.

        The control group is the categories the change was not supposed to
        touch. If they moved, the chunking moved underneath the run (label
        groups -> prompt length -> text token budget), and no other row means
        anything until that is explained.
        """
        for f1 in (0.60, 0.99):
            bad = self._report(
                control_group={
                    "micro": {"f1": f1, "precision": f1, "recall": f1, "f2": f1}
                }
            )
            fails = self._fails(bad)
            self.assertTrue(
                any("CONTROL GROUP" in f for f in fails),
                f"drift to {f1} not caught: {fails}",
            )

    def test_thin_categories_are_skipped_loudly_not_silently(self):
        """Refusing to gate is correct at n=15; doing it silently is not."""
        import io
        import contextlib

        thin = {
            c: {
                "tp": 14,
                "fp": 1,
                "fn": 1,
                "precision": 0.93,
                "recall": 0.93,
                "f1": 0.93,
                "f2": 0.93,
            }
            for c in HIGH_RISK
        }
        base = self._report(overall=self._scope(per_category=thin))
        # A recall collapse in a thin category must NOT fail the gate...
        broken = {
            c: dict(m, tp=0, fn=15, recall=0.0, precision=0.0, f1=0.0, f2=0.0)
            for c, m in thin.items()
        }
        cur = self._report(overall=self._scope(per_category=broken))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            fails = gate(cur, base, 0.02, "all")
        self.assertFalse(any(c in f for f in fails for c in HIGH_RISK), fails)
        # ...but it must be reported, with the number, on stderr.
        self.assertIn("NOT GATED", err.getvalue())
        self.assertIn("15 gold spans", err.getvalue())

    def test_degraded_run_never_passes(self):
        self.assertTrue(
            any(
                "degraded_rate" in f
                for f in self._fails(self._report(degraded_rate=0.01))
            )
        )

    def test_corpus_lock_mismatch_fails_before_any_metric(self):
        """The stale-hybrid-baseline failure mode, made structurally impossible.

        A baseline measured on a different corpus invalidates every delta, so
        the gate must refuse the comparison outright — a single failure that
        names the locks, not a pile of misleading metric rows.
        """
        cur = self._report(
            meta={
                "corpus_lock": {
                    "large.jsonl": "NEW",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                }
            }
        )
        fails = self._fails(cur)
        self.assertEqual(len(fails), 1, fails)
        self.assertIn("corpus_lock mismatch", fails[0])

    def test_gating_dev_against_a_held_out_baseline_is_refused(self):
        """The lock cannot catch this — both splits share one corpus lock.

        Gating `--split dev` against the held-out baseline produced eight
        confident, entirely spurious regression rows (2026-08-01), cost a wrong
        diagnosis and a code change made for a reason that did not exist.
        """
        base = self._report(
            meta={
                "corpus_lock": {
                    "large.jsonl": "aa",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                },
                "split": "held-out",
                "tier": "hybrid",
            }
        )
        cur = self._report(
            meta={
                "corpus_lock": {
                    "large.jsonl": "aa",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                },
                "split": "dev",
                "tier": "hybrid",
            }
        )
        fails = self._fails(cur, base)
        self.assertEqual(len(fails), 1, fails)
        self.assertIn("split mismatch", fails[0])

    def test_gating_hybrid_against_an_off_baseline_is_refused(self):
        base = self._report(
            meta={
                "corpus_lock": {
                    "large.jsonl": "aa",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                },
                "split": "dev",
                "tier": "off",
            }
        )
        cur = self._report(
            meta={
                "corpus_lock": {
                    "large.jsonl": "aa",
                    "short.jsonl": "bb",
                    "negatives.jsonl": "cc",
                },
                "split": "dev",
                "tier": "hybrid",
            }
        )
        fails = self._fails(cur, base)
        self.assertEqual(len(fails), 1, fails)
        self.assertIn("tier mismatch", fails[0])

    def test_matching_split_and_tier_still_pass(self):
        meta = {
            "corpus_lock": {
                "large.jsonl": "aa",
                "short.jsonl": "bb",
                "negatives.jsonl": "cc",
            },
            "split": "dev",
            "tier": "hybrid",
        }
        self.assertEqual(
            self._fails(self._report(meta=meta), self._report(meta=meta)), []
        )

    def test_baseline_without_corpus_lock_is_refused(self):
        """A pre-lock baseline proves nothing about this corpus."""
        base = self._report()
        del base["meta"]
        fails = self._fails(self._report(), baseline=base)
        self.assertEqual(len(fails), 1, fails)
        self.assertIn("no meta.corpus_lock", fails[0])


class ClassBreakdownTests(unittest.TestCase):
    """by_class / control_group were designed, documented, and never emitted.

    eval/categories.py:CLASS_MAPS carried a docstring claiming evaluate()
    consumed it; metrics.py never took the parameter. The cutover decision is
    read off by_structure (structured vs fuzzy), so an unwired breakdown meant
    re-bucketing 21 rows by hand at the go/no-go.
    """

    def _run(self, **kw):
        text = "Bel 0612345678 of mail a@b.nl"
        rec = Record(
            id="r1",
            text=text,
            lang="nl",
            size_class="short",
            spans=(
                Span(4, 14, "PhoneNumber", text[4:14]),
                Span(23, 29, "Email", text[23:29]),
            ),
        )
        preds = [[SpanTuple(4, 14, "PhoneNumber"), SpanTuple(23, 29, "Email")]]
        return evaluate([rec], preds, regex_categories=WAS_REGEX, **kw)

    def test_by_class_is_emitted_for_every_grouping(self):
        rep = self._run(class_maps=CLASS_MAPS)
        self.assertEqual(set(rep["by_class"]), set(CLASS_MAPS))
        self.assertIn("structured", rep["by_class"]["by_structure"])

    def test_class_totals_agree_with_overall(self):
        """A breakdown that doesn't reconcile is worse than none."""
        rep = self._run(class_maps=CLASS_MAPS)
        for grouping, classes in rep["by_class"].items():
            tp = sum(c["micro"]["tp"] for c in classes.values())
            self.assertEqual(tp, rep["overall"]["micro"]["tp"], grouping)

    def test_control_group_is_restricted_to_its_categories(self):
        rep = self._run(control_group=CONTROL_GROUP)
        # PhoneNumber and Email are both WAS_REGEX, so neither is in the
        # control group (= WAS_GLINER) and it must be empty, not absent.
        self.assertIsNotNone(rep["control_group"])
        self.assertEqual(rep["control_group"]["per_category"], {})

    def test_absent_by_default_so_old_baselines_still_compare(self):
        rep = self._run()
        self.assertEqual(rep["by_class"], {})
        self.assertIsNone(rep["control_group"])


if __name__ == "__main__":
    unittest.main()
