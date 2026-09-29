"""Tests for the guard-service PII detection pipeline.

Regression coverage for BFSF-269 ("only the last person name is redacted"):
the root cause was the GLiNER tier silently contributing nothing (model not
ready → regex-only) with no signal to the caller. These tests pin:

  * multi-name detection returns EVERY distinct name (not just the last),
  * a not-ready model returns ``degraded=True`` (so Node can fail closed),
  * the confidence slider is effective (shifts per-category floors),
  * chunking preserves names past the first chunk,
  * the regex tier catches the deterministic BFSF-269 sample data.

Runs on stdlib only (no model download): the GLiNER model is replaced with a
lightweight fake. Run with either::

    python -m unittest discover -s tests        # no extra deps
    pytest tests/                                # in the container
"""

from __future__ import annotations

import unittest

from app.services.pii import (
    PiiService,
    _chunk_text,
    _chunk_text_tokens,
    _model_limits,
    _snap_boundary,
    _token_index_at_char,
    _is_noise_person_org,
    _is_skippable,
    _pick_label,
    _postprocess_entities,
    _precision_filter,
    _snap_start_to_word,
    get_pii_service,
    _UI_DEFAULT_THRESHOLD,
)
from app.services.pii_regex import detect_regex_pii


class FakeTokenizer:
    """Whitespace tokenizer with HF-style offset mapping — for token chunking.

    Mimics the subset of the fast-tokenizer API the chunker uses:
    ``tok(text, add_special_tokens=False, return_offsets_mapping=True)`` ->
    ``{"input_ids": [...], "offset_mapping": [(start, end), ...]}``.
    """

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):
        import re as _re

        toks = list(_re.finditer(r"\S+", text))
        out = {"input_ids": [1] * len(toks)}
        if return_offsets_mapping:
            out["offset_mapping"] = [(m.start(), m.end()) for m in toks]
        return out


class FakeGliner:
    """Stand-in for the GLiNER model.

    ``predict_entities`` finds each configured name in the chunk and returns a
    span dict shaped like the real model's output. It deliberately IGNORES the
    ``threshold`` argument so the detector's own per-category floor logic (the
    thing we're testing) is what filters results.
    """

    def __init__(self, names, score=0.9, label="person", prompts=None):
        self.names = names
        self.score = score
        self.label = label
        # Custom label sets: {prompt: [(name, score), ...]}. A Mapping label
        # set ({id: prompt}) is answered with the mapping's KEYS as labels,
        # exactly like gliner 0.2.29 (the prompt is what the model reads, the
        # key is what it returns).
        self.prompts = prompts or {}
        # Every inference call: (texts, labels), in call order.
        self.calls = []

    def _predict_mapping(self, text, mapping):
        out = []
        for key, prompt in mapping.items():
            for name, score in self.prompts.get(prompt, ()):
                idx = text.find(name)
                while idx != -1:
                    out.append(
                        {
                            "label": key,
                            "score": score,
                            "start": idx,
                            "end": idx + len(name),
                            "text": name,
                        }
                    )
                    idx = text.find(name, idx + 1)
        return out

    def predict_entities(self, text, labels, threshold=0.0):
        from collections.abc import Mapping

        if isinstance(labels, Mapping):
            return self._predict_mapping(text, labels)
        if self.label not in labels:
            return []
        out = []
        for name in self.names:
            idx = text.find(name)
            while idx != -1:
                out.append(
                    {
                        "label": self.label,
                        "score": self.score,
                        "start": idx,
                        "end": idx + len(name),
                        "text": name,
                    }
                )
                idx = text.find(name, idx + 1)
        return out

    def inference(self, texts, labels, threshold=0.0, **kwargs):
        # The service batches chunks per label group; mirror that by running
        # the single-text logic over each chunk and returning a list-per-text.
        self.last_inference_kwargs = kwargs
        self.calls.append((list(texts), labels))
        return [self.predict_entities(t, labels, threshold) for t in texts]


def _install_fake(names, score=0.9):
    """Force the singleton into a ready state backed by a fake model."""
    svc = get_pii_service()
    svc._model = FakeGliner(names, score=score)
    svc._ready = True
    svc._load_error = None
    svc._backend = "fake"
    return svc


def _names(result):
    return [e["text"] for e in result["entities"] if e["category"] == "Person"]


def _ent(offset, length, category, confidence):
    return {
        "offset": offset,
        "length": length,
        "category": category,
        "confidence": confidence,
        "text": "x",
        "label": category,
    }


# _finalise now REQUIRES the source text whenever a cluster has to be merged,
# so entity["text"] can be kept consistent with the widened offset/length.
# These tests exercise offsets/labels, not text, so any filler long enough to
# contain every synthetic span will do — but it must be long enough, otherwise
# _retext() clamps the span and the offset assertions silently test the clamp
# instead of the resolution rule. The widest span any test below builds is
# offset<=80 plus length<=25.
_FILLER = "x" * 256


def _finalise(entities, **kwargs):
    """_finalise with the source text supplied (see _FILLER)."""
    kwargs.setdefault("text", _FILLER)
    return PiiService._finalise(entities, **kwargs)


class LabelCasingTests(unittest.TestCase):
    """Every label in a group must be reachable under BOTH casings.

    detect() reads GLINER_LABELS_TO_CATEGORY two different ways:

      * active_groups filters on the label EXACTLY as written in _LABEL_GROUPS,
      * _accept() looks it up as (ent["label"] or "").lower(), because that is
        what the model echoes back.

    Register only one casing and the label is silently dead: the group is
    dropped before inference (raw-case miss) or every returned span is
    discarded (lower-case miss). Either way the category reports clean, which
    in a privacy filter reads as "no PII here".

    This is not hypothetical — "IBAN" is in the shipped label set precisely
    because casing is a measured, per-label fact, and it only works today
    because "iban" happens to be registered alongside it.
    """

    def test_every_grouped_label_maps_under_both_casings(self):
        from app.services.pii import _LABEL_GROUPS, GLINER_LABELS_TO_CATEGORY as M

        for group in _LABEL_GROUPS:
            for label in group:
                self.assertIn(
                    label,
                    M,
                    f"{label!r} is in a label group but not in the "
                    f"category map — active_groups drops the whole "
                    f"group before inference",
                )
                self.assertIn(
                    label.lower(),
                    M,
                    f"{label!r} has no lower-case entry — the model "
                    f"echoes the label back and _accept() lowercases "
                    f"it, so every span it finds is discarded",
                )
                self.assertEqual(
                    M[label],
                    M[label.lower()],
                    f"{label!r} maps to a different category depending on casing",
                )


class ValidatorContractTests(unittest.TestCase):
    """pii_validators.py must be structurally incapable of detecting.

    The owner's rule is "no pattern may propose or suppress a span; only the
    model proposes spans". Arithmetic on a span the model already produced is
    permitted; searching the document is not. That distinction is worth nothing
    as a comment — someone will add `re.finditer` here in six months and the
    model-only claim becomes false without anyone noticing.

    These assert it against the module SOURCE and SIGNATURE, following the
    precedent set by test_module_cannot_grow_into_a_regex_tier for pii_bsn.py.
    """

    def _tree(self):
        import ast
        import inspect
        from app.services import pii_validators

        return ast.parse(inspect.getsource(pii_validators))

    def test_module_imports_no_regex_engine(self):
        """Checked on the AST, not the text.

        A source-text scan would trip on this module's own docstring, which
        has to be able to *explain* the rule. Only real import statements count.
        """
        import ast

        banned = {"re", "regex", "re2"}
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Import):
                for a in node.names:
                    self.assertNotIn(
                        a.name.split(".")[0],
                        banned,
                        f"pii_validators.py imports {a.name!r}",
                    )
            elif isinstance(node, ast.ImportFrom):
                self.assertNotIn(
                    (node.module or "").split(".")[0],
                    banned,
                    f"pii_validators.py imports from {node.module!r}",
                )

    def test_module_calls_no_search_primitive(self):
        """No finditer/search/match/findall, however it was imported.

        A validator that can scan a string for occurrences is a detector, and
        the moment one appears here the model-only claim stops being true.
        """
        import ast

        banned = {"finditer", "search", "findall", "fullmatch", "compile"}
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(
                    node.func.attr,
                    banned,
                    f"pii_validators.py calls .{node.func.attr}()",
                )

    def test_validate_takes_a_span_not_a_document(self):
        """Two parameters, forever.

        A third (`full_text`, `offset`, `context`…) is how a validator grows
        into an anchored regex tier: given the document it can look 40 chars
        left for "KVK" and start proposing.
        """
        import inspect
        from app.services.pii_validators import validate

        params = list(inspect.signature(validate).parameters)
        self.assertEqual(params, ["category", "text"])

    def test_validate_is_the_only_exported_entry_point(self):
        from app.services import pii_validators

        exported = [
            n
            for n in pii_validators.__all__
            if callable(getattr(pii_validators, n, None))
        ]
        self.assertEqual(exported, ["validate"])

    def test_no_opinion_on_categories_without_a_checksum(self):
        from app.services.pii_validators import validate

        for cat in (
            "Person",
            "Address",
            "Email",
            "MedicalCondition",
            "PhoneNumber",
            "ApiKeyOrSecret",
        ):
            self.assertIsNone(validate(cat, "whatever"), cat)

    def test_confirms_and_refutes_real_checksums(self):
        from app.services.pii_validators import validate

        # Reserved/documentation values only — see eval/README.md.
        self.assertIs(
            validate("InternationalBankingAccountNumber", "NL91ABNA0417164300"), True
        )
        self.assertIs(
            validate("InternationalBankingAccountNumber", "NL91ABNA0417164301"), False
        )
        self.assertIs(validate("CreditCardNumber", "4111 1111 1111 1111"), True)
        self.assertIs(validate("CreditCardNumber", "4111 1111 1111 1112"), False)
        self.assertIs(validate("IPAddress", "192.0.2.1"), True)
        self.assertIs(validate("IPAddress", "999.0.2.1"), False)

    def test_non_dutch_national_ids_are_never_refuted(self):
        """27 of 85 gold NationalIdentificationNumber spans are not Dutch.

        Refuting them would demote correct model detections for the crime of
        not satisfying an elfproef they were never supposed to satisfy.

        This used to assert None specifically, on the premise that there WAS no
        algorithm for anything but a BSN. There now is, for six countries, so a
        valid foreign ID gets confirmed instead of ignored. The invariant that
        actually protects recall is unchanged and is what this pins: never False.
        Several of these shapes collide — eleven bare digits is a Belgian
        national number, a German Steuer-IdNr AND a Polish PESEL — so failing one
        country's arithmetic can never mean the span is not an identifier.
        """
        from app.services.pii_validators import validate

        for foreign in (
            "85073003-129",  # 11 digits, no country's check
            "12345678901",  # DE-shaped, wrong check digit
            "RSSMRA85T10A562S",  # IT codice fiscale (no checksum)
            "AB-1234-XY",
        ):  # not an identifier shape at all
            self.assertIsNot(
                validate("NationalIdentificationNumber", foreign), False, foreign
            )

    def test_valid_foreign_national_ids_are_confirmed(self):
        """The point of adding the checksums: a real foreign ID gains confidence.

        Every value here is a published valid number, so a failure means the
        algorithm is wrong rather than the input.
        """
        from app.services.pii_validators import validate

        for foreign in (
            "85.07.30-033.28",  # BE rijksregisternummer
            "86095742719",  # DE Steuer-IdNr (BZSt test no.)
            "44051401359",  # PL PESEL
            "12345678Z",  # ES DNI
            "X1234567L",  # ES NIE
            "811218-9876",  # SE personnummer
            "1237 010180",  # AT SVNR
            "2 69 05 49 588 157 80",
        ):  # FR NIR
            self.assertTrue(validate("NationalIdentificationNumber", foreign), foreign)

    def test_ipv6_is_decided_but_cidr_and_endpoints_are_not(self):
        """IPv6 used to get no opinion. That was a gap, not a policy.

        The non-Dutch-ID case above is a real reason to stay silent: an
        elfproef is Dutch, so a Belgian ID failing it says nothing. RFC 4291 is
        not like that — it is universal, and there is no valid IPv6 address
        that fails an IPv6 parse. So arithmetic can and should decide, which is
        what refutes the `12:30:45` spans the model labels IPAddress.

        Network and endpoint notations stay exempt: they are not bare
        addresses, and refuting them would demote a correct detection.
        """
        from app.services.pii_validators import validate

        self.assertTrue(validate("IPAddress", "2001:db8::1"))
        self.assertTrue(validate("IPAddress", "::ffff:192.0.2.1"))
        self.assertFalse(validate("IPAddress", "12:30:45"))
        self.assertFalse(validate("IPAddress", "aa:bb:cc:dd:ee:ff"))
        for exempt in ("2001:db8::/32", "[2001:db8::1]:443", "192.0.2.0/24"):
            self.assertIsNone(validate("IPAddress", exempt), exempt)


class DetectCandidatesTests(unittest.TestCase):
    """detect_candidates(): the pre-_finalise span list.

    Threshold calibration used to sweep detect() output, which emits at most
    one entity per overlap cluster and DELETES the losers. A category that lost
    its cluster was therefore absent from its own curve at every candidate
    threshold — measured: 43 of 85 gold IBANs were emitted as
    BankAccountNumber, so the IBAN sweep was bounded far below achievable
    recall and every floor it proposed for a contested category was fitted on a
    truncated candidate set. The curves looked healthy. They were meaningless.
    """

    def test_candidates_keep_the_losers_that_finalise_deletes(self):
        svc = _install_fake(["Eva Meijer"])
        text = "Beste Mw. Eva Meijer, hallo"
        # The regex tier emits the titled span at 0.95; the model emits the
        # bare name at 0.90. They overlap, so _finalise merges them into one.
        cands = svc.detect_candidates(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        final = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )["entities"]
        self.assertEqual(len(final), 1)
        self.assertEqual(len(cands), 2)
        self.assertEqual(
            {(e["offset"], e["length"]) for e in cands}, {(6, 14), (10, 10)}
        )

    def test_candidates_and_detect_share_one_code_path(self):
        """detect() must be detect_candidates() + _finalise, not a second pipeline.

        A parallel implementation would drift, and the drift would only show up
        as a calibration that no longer describes the detector.
        """
        svc = _install_fake(["Eva Meijer"])
        text = "Beste Mw. Eva Meijer, hallo"
        cands = svc.detect_candidates(text, 0.7, ["Person"])
        direct = PiiService._finalise([dict(e) for e in cands], text=text)
        via_detect = svc.detect(text, 0.7, ["Person"])
        self.assertEqual(direct["entities"], via_detect["entities"])

    def test_skippable_text_yields_no_candidates(self):
        svc = _install_fake(["Eva Meijer"])
        self.assertEqual(svc.detect_candidates("[token_1]", 0.7, ["Person"]), [])


class OverlapResolutionTests(unittest.TestCase):
    """_finalise: specificity beats confidence in a near-tie; extent is a union.

    The old rule ("keep the higher-confidence span") only worked because regex
    hits carried 0.95-0.99 and always won. With one model in one confidence
    band it lost 43 of 85 gold IBANs to BankAccountNumber — the general label
    scoring marginally higher on the identical span.
    """

    def _cats(self, result):
        return [e["category"] for e in result["entities"]]

    def test_specific_beats_general_in_a_near_tie(self):
        r = _finalise(
            [
                _ent(0, 18, "BankAccountNumber", 0.62),
                _ent(0, 18, "InternationalBankingAccountNumber", 0.58),
            ]
        )
        self.assertEqual(self._cats(r), ["InternationalBankingAccountNumber"])

    def test_confident_general_label_still_wins(self):
        # The band is 0.10; a decisive margin must not be overridden.
        r = _finalise(
            [
                _ent(0, 18, "BankAccountNumber", 0.95),
                _ent(0, 18, "InternationalBankingAccountNumber", 0.50),
            ]
        )
        self.assertEqual(self._cats(r), ["BankAccountNumber"])

    def test_extent_is_the_union_not_the_winner(self):
        # The old code REPLACED a kept span with an overlapping one, so
        # A=[0,50) replaced by B=[45,60) silently un-redacted chars 0-45.
        r = _finalise(
            [
                _ent(0, 50, "Address", 0.55),
                _ent(45, 15, "PhoneNumber", 0.90),
            ]
        )
        self.assertEqual(len(r["entities"]), 1)
        e = r["entities"][0]
        self.assertEqual((e["offset"], e["length"]), (0, 60))

    def test_containment_never_shrinks_the_redaction(self):
        r = _finalise(
            [
                _ent(0, 40, "Address", 0.51),
                _ent(10, 12, "PhoneNumber", 0.99),
            ]
        )
        e = r["entities"][0]
        self.assertEqual((e["offset"], e["length"]), (0, 40))

    def test_non_overlapping_spans_are_all_kept(self):
        r = _finalise(
            [
                _ent(0, 5, "Person", 0.9),
                _ent(10, 5, "Email", 0.9),
                _ent(20, 5, "PhoneNumber", 0.9),
            ]
        )
        self.assertEqual(len(r["entities"]), 3)

    def test_union_of_kept_equals_union_of_input(self):
        """The anti-leak invariant, property-tested.

        No character that ANY detector flagged may become unredacted. This is
        the guarantee the whole component rests on, so it is checked over
        randomised span sets rather than a hand-picked example.
        """
        import random

        cats = [
            "Person",
            "Address",
            "PhoneNumber",
            "Email",
            "BankAccountNumber",
            "InternationalBankingAccountNumber",
        ]
        rng = random.Random(1234)
        for _ in range(300):
            ents = []
            for _ in range(rng.randint(1, 8)):
                start = rng.randint(0, 80)
                ents.append(
                    _ent(
                        start,
                        rng.randint(1, 25),
                        rng.choice(cats),
                        round(rng.uniform(0.3, 1.0), 3),
                    )
                )
            covered_in = set()
            for e in ents:
                covered_in |= set(range(e["offset"], e["offset"] + e["length"]))
            kept = _finalise([dict(e) for e in ents])["entities"]
            covered_out = set()
            for e in kept:
                covered_out |= set(range(e["offset"], e["offset"] + e["length"]))
            self.assertEqual(covered_in, covered_out, f"coverage changed for {ents}")

    def test_validated_span_beats_a_more_confident_unvalidated_one(self):
        """Stage 1: arithmetic beats opinion.

        This is the whole point of allowing validators at all. mod-97 either
        holds or it does not; a confidence is a guess from one forward pass.
        """
        iban = _ent(0, 18, "InternationalBankingAccountNumber", 0.40)
        iban["validated"] = True
        r = _finalise([_ent(0, 18, "BankAccountNumber", 0.99), iban])
        self.assertEqual(self._cats(r), ["InternationalBankingAccountNumber"])

    def test_refuted_span_does_not_lose_its_characters(self):
        """A demoted span is still redacted — that is why we never drop.

        Dropping pre-_finalise happens outside union(kept) == union(input), so
        it would un-redact silently while the property test still passed.
        """
        bad = _ent(10, 16, "CreditCardNumber", 0.30)  # already demoted
        bad["validated"] = False
        r = _finalise([bad])
        self.assertEqual(len(r["entities"]), 1)
        self.assertEqual(
            (r["entities"][0]["offset"], r["entities"][0]["length"]), (10, 16)
        )

    def test_margin_above_own_floor_beats_raw_confidence(self):
        """Stage 3: scores from different label groups are not comparable.

        Person floor 0.40, Organization floor 0.50. A 0.52 Person clears its
        floor by +0.12; a 0.58 Organization by only +0.08. Raw confidence gets
        this backwards, and raw confidence is what the old rule compared.
        """
        from app.services.pii import _PER_CATEGORY_THRESHOLD

        self.assertLess(
            _PER_CATEGORY_THRESHOLD["Person"],
            _PER_CATEGORY_THRESHOLD["Organization"],
            "test premise changed — re-derive the numbers below",
        )
        r = _finalise(
            [
                _ent(0, 12, "Organization", 0.58),
                _ent(0, 12, "Person", 0.52),
            ]
        )
        self.assertEqual(self._cats(r), ["Person"])

    def test_exact_ties_resolve_by_frozen_precedence_not_input_order(self):
        """Stage 4. Iteration order silently decided this once before."""
        from app.services.pii import _PER_CATEGORY_THRESHOLD as F

        # Construct an exact margin tie between two unrelated categories.
        a, b = "Medication", "DriversLicenseNumber"
        conf_a, conf_b = F[a] + 0.2, F[b] + 0.2
        forward = _finalise([_ent(0, 10, a, conf_a), _ent(0, 10, b, conf_b)])
        reverse = _finalise([_ent(0, 10, b, conf_b), _ent(0, 10, a, conf_a)])
        self.assertEqual(self._cats(forward), self._cats(reverse))

    def test_label_choice_is_order_independent_over_every_permutation(self):
        """The property the hand-written tie test can only sample.

        Order-dependence here is not cosmetic: the emitted label would depend
        on which chunk the model happened to see first, so the same document
        could tokenise as [iban_1] or [bank_account_number_1] between runs.
        That already cost TaxIdentificationNumber 7.7pp once. Permutations
        rather than a shuffle, so a 3-way cycle cannot hide.
        """
        import itertools
        import random
        from app.services.pii import ALL_CATEGORIES

        rng = random.Random(7)
        cats = sorted(ALL_CATEGORIES)
        for _ in range(150):
            chosen = rng.sample(cats, rng.randint(2, 4))
            ents = [_ent(0, 12, c, round(rng.uniform(0.35, 0.99), 2)) for c in chosen]
            outs = {
                tuple(
                    e["category"]
                    for e in _finalise([dict(x) for x in perm])["entities"]
                )
                for perm in itertools.permutations(ents)
            }
            self.assertEqual(
                len(outs),
                1,
                f"label depends on input order for "
                f"{[(e['category'], e['confidence']) for e in ents]}: {outs}",
            )

    def test_specificity_relation_is_acyclic(self):
        """A cycle makes the winner depend on iteration order.

        Regression test for a real bug: TaxIdentificationNumber and
        NationalIdentificationNumber were each declared more specific than the
        other. A 9-digit RSIN and a BSN are arithmetically identical, so the
        tie resolved differently depending on cluster order and
        TaxIdentificationNumber recall fell 7.7pp. Siblings must not override
        each other — only a genuine is-a relationship belongs here.
        """
        from app.services.pii import _SPECIFIC_OVER_GENERAL as REL

        def reaches(start, target, seen=None):
            seen = seen or set()
            if start in seen:
                return False
            seen.add(start)
            for nxt in REL.get(start, ()):
                if nxt == target or reaches(nxt, target, seen):
                    return True
            return False

        for general, specifics in REL.items():
            for s in specifics:
                self.assertFalse(
                    reaches(s, general),
                    f"cycle: {general} -> {s} -> ... -> {general}",
                )

    def test_precedence_covers_every_category(self):
        """A category missing here silently falls to the bottom rank.

        That is a tie resolved by an accident of list length rather than a
        decision, which is the exact failure mode the frozen tuple exists to
        remove.
        """
        from app.services.pii import _CATEGORY_PRECEDENCE, ALL_CATEGORIES

        self.assertEqual(set(_CATEGORY_PRECEDENCE), set(ALL_CATEGORIES))
        self.assertEqual(len(_CATEGORY_PRECEDENCE), len(set(_CATEGORY_PRECEDENCE)))

    def test_specificity_targets_are_real_categories(self):
        from app.services.pii import _SPECIFIC_OVER_GENERAL as REL, ALL_CATEGORIES

        names = set(REL) | {s for v in REL.values() for s in v}
        self.assertEqual(names - ALL_CATEGORIES, set())

    def test_result_spans_are_disjoint_and_sorted(self):
        import random

        rng = random.Random(99)
        for _ in range(200):
            ents = [
                _ent(
                    rng.randint(0, 60),
                    rng.randint(1, 20),
                    "Person",
                    round(rng.uniform(0.3, 1.0), 3),
                )
                for _ in range(rng.randint(2, 7))
            ]
            kept = _finalise(ents)["entities"]
            offs = [e["offset"] for e in kept]
            self.assertEqual(offs, sorted(offs))
            for a, b in zip(kept, kept[1:]):
                self.assertLessEqual(a["offset"] + a["length"], b["offset"])


class BsnChecksumExceptionTests(unittest.TestCase):
    """The single documented non-GLiNER detector."""

    def test_elfproef_accepts_and_rejects(self):
        from app.services.pii_bsn import is_valid_bsn

        self.assertTrue(is_valid_bsn("123456782"))
        self.assertFalse(is_valid_bsn("123456789"))
        self.assertFalse(is_valid_bsn("000000000"))  # sum == 0 is rejected
        self.assertFalse(is_valid_bsn("12345678"))  # too short
        self.assertFalse(is_valid_bsn("abcdefghi"))

    def test_detects_only_checksum_valid_runs(self):
        from app.services.pii_bsn import detect_bsn

        text = "geldig 123456782 ongeldig 123456789 kort 12345678"
        found = [e["text"] for e in detect_bsn(text)]
        self.assertEqual(found, ["123456782"])

    def test_respects_the_category_toggle(self):
        from app.services.pii_bsn import detect_bsn

        self.assertEqual(
            detect_bsn("123456782", enabled_categories=frozenset({"Email"})), []
        )
        self.assertTrue(
            detect_bsn(
                "123456782",
                enabled_categories=frozenset({"NationalIdentificationNumber"}),
            )
        )

    def test_module_cannot_grow_into_a_regex_tier(self):
        # Structural guard: this is ONE category by checksum, not a pattern
        # tier by another name. If it ever exports more detectors, the
        # "GLiNER does all detection" claim quietly stops being true.
        import app.services.pii_bsn as m

        detectors = [n for n in m.__all__ if n.startswith("detect_")]
        self.assertEqual(detectors, ["detect_bsn"])
        self.assertEqual(m.CATEGORY, "NationalIdentificationNumber")


class TierModeTests(unittest.TestCase):
    """GUARD_PII_REGEX_TIER — the rollout switch for the GLiNER-only cutover.

    This is a privacy control, so the contract is pinned rather than assumed:
    the default must be byte-identical to the historical two-tier behaviour,
    an unrecognised value must fail loudly rather than be coerced, and `off`
    must genuinely stop the regex tier (a mode that is accepted but silently
    not honoured is worse than no mode at all).
    """

    def setUp(self):
        from app.config import settings

        self._saved = settings.pii_regex_tier
        self.addCleanup(setattr, settings, "pii_regex_tier", self._saved)

    def _set(self, mode):
        from app.config import settings

        settings.pii_regex_tier = mode

    def test_default_is_on(self):
        from app.services.pii import resolve_tier_mode

        self._set("on")
        self.assertEqual(resolve_tier_mode(), "on")

    def test_unknown_mode_raises(self):
        from app.services.pii import resolve_tier_mode

        for bad in ("ON!", "disabled", "true", "0"):
            self._set(bad)
            with self.subTest(mode=bad):
                with self.assertRaises(ValueError):
                    resolve_tier_mode()

    def test_unset_and_blank_mean_the_default(self):
        """envsubst renders an undefined variable as the empty string.

        A k8s manifest that references ${GUARD_PII_REGEX_TIER} while
        .env.scaleway does not define it produces "" — and a template can
        just as easily yield "   ". Both must mean "unset" and fall back to
        `on`. An earlier version defaulted before stripping, so a
        whitespace-only value crashed the pod at startup: the validation
        intended to prevent a silent misconfiguration would instead have
        caused a deploy-time outage.
        """
        from app.services.pii import resolve_tier_mode

        for blank in ("", "   ", "\t", None):
            self._set(blank)
            with self.subTest(value=blank):
                self.assertEqual(resolve_tier_mode(), "on")

    def test_mode_is_case_and_space_insensitive(self):
        from app.services.pii import resolve_tier_mode

        self._set("  OFF  ")
        self.assertEqual(resolve_tier_mode(), "off")

    def test_on_runs_the_regex_tier(self):
        self._set("on")
        svc = _install_fake([])
        # An email is regex-complete: with the tier on it must be detected
        # even though the fake model reports nothing.
        res = svc.detect(
            "mail mij op jan@example.nl",
            confidence_threshold=0.7,
            enabled_categories=["Email"],
        )
        self.assertTrue(res["hasPii"])
        self.assertEqual(res["tier_mode"], "on")

    def test_off_disables_the_regex_tier(self):
        self._set("off")
        svc = _install_fake([])
        res = svc.detect(
            "mail mij op jan@example.nl",
            confidence_threshold=0.7,
            enabled_categories=["Email"],
        )
        # Regex is gone and the fake model has no email label -> nothing.
        self.assertFalse(res["hasPii"])
        self.assertEqual(res["entities"], [])
        self.assertEqual(res["tier_mode"], "off")

    def test_shadow_returns_the_same_union_as_on(self):
        # shadow must be user-visibly identical to on: both tiers run and the
        # union is returned. Only the observability differs.
        text = "mail mij op jan@example.nl"
        self._set("on")
        on = _install_fake([]).detect(
            text, confidence_threshold=0.7, enabled_categories=["Email"]
        )
        self._set("shadow")
        shadow = _install_fake([]).detect(
            text, confidence_threshold=0.7, enabled_categories=["Email"]
        )
        self.assertEqual(
            [(e["offset"], e["length"], e["category"]) for e in on["entities"]],
            [(e["offset"], e["length"], e["category"]) for e in shadow["entities"]],
        )
        self.assertEqual(shadow["tier_mode"], "shadow")

    def test_every_category_is_reachable_through_a_label_group(self):
        """No canonical category may be undetectable by construction.

        A label can exist in GLINER_LABELS_TO_CATEGORY and still be
        unreachable, because detect() only asks the model about labels that
        appear in _LABEL_GROUPS. Before the cutover TEN categories were in
        exactly that state — invisible, because the regex tier happened to
        cover precisely those categories. The moment it doesn't, an unreachable
        category returns "clean" rather than an error, which in a privacy
        product is the worst possible failure mode.

        This is the structural guard: a new category cannot ship detectable-on-
        paper and undetectable in fact.
        """
        from app.services.pii import (
            _grouped_categories,
            ALL_CATEGORIES,
            _PER_CATEGORY_THRESHOLD,
        )

        unreachable = ALL_CATEGORIES - _grouped_categories()
        self.assertEqual(
            unreachable,
            set(),
            f"categories with no label in any _LABEL_GROUPS entry: {sorted(unreachable)}",
        )
        # Same class of bug one layer down: a category with no tuned floor
        # falls through _final_floor to the RAW slider (0.70), which silently
        # drops every borderline span — how the low-context phone number was
        # being missed at the production default.
        self.assertEqual(
            set(_PER_CATEGORY_THRESHOLD),
            set(ALL_CATEGORIES),
            "every category needs an explicit floor; untuned ones track the "
            "raw slider and silently under-detect",
        )

    def test_label_groups_stay_within_the_chunk_budget(self):
        # _label_prompt_tokens sizes the per-chunk TEXT budget from the WIDEST
        # group, so widening one group shrinks chunks for every group and
        # increases total inference. 6 was the historical maximum; staying at
        # or below it keeps chunking unchanged across the cutover.
        from app.services.pii import _LABEL_GROUPS

        widest = max(len(g) for g in _LABEL_GROUPS)
        self.assertLessEqual(
            widest,
            6,
            "widest label group grew — this shrinks the text budget for every chunk",
        )

    def test_no_label_is_orphaned_from_the_category_map(self):
        from app.services.pii import _LABEL_GROUPS, GLINER_LABELS_TO_CATEGORY

        orphans = [
            lbl
            for g in _LABEL_GROUPS
            for lbl in g
            if lbl not in GLINER_LABELS_TO_CATEGORY
        ]
        self.assertEqual(
            orphans,
            [],
            "labels in a group but not in the category "
            "map are silently dropped by _accept",
        )


class MultiNameDetectionTests(unittest.TestCase):
    def test_all_distinct_names_returned(self):
        # BFSF-269: three names, only the last got redacted. Assert all three.
        svc = _install_fake(["Mark", "Sanne", "Eva Meijer"])
        text = "Beste Mark en Sanne, met vriendelijke groet, Mr. Eva Meijer"
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertTrue(result["hasPii"])
        self.assertFalse(result["degraded"])
        found = set(_names(result))
        self.assertIn("Mark", found)
        self.assertIn("Sanne", found)
        # "Eva Meijer" is caught by BOTH the regex (titled) and GLiNER; overlap
        # resolution keeps one. Either way the name must be present.
        self.assertTrue(any("Eva" in n for n in found))

    def test_repeated_name_yields_multiple_spans(self):
        svc = _install_fake(["Sanne"])
        text = "Sanne wil dit. Later zei Sanne iets anders."
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        offsets = [
            (e["offset"], e["text"])
            for e in result["entities"]
            if e["category"] == "Person"
        ]
        self.assertEqual(len(offsets), 2, offsets)


class FalsePositiveFilterTests(unittest.TestCase):
    def test_common_nouns_are_dropped(self):
        # Observed BFSF-269 noise: lowercase common nouns / pronouns / roles.
        for noise in [
            "ouders",
            "kinderen",
            "ik",
            "school",
            "bank",
            "notaris",
            "mediator",
            "van de kinderen",
            "de heer",
            "woning",
        ]:
            self.assertTrue(_is_noise_person_org(noise), noise)

    def test_capitalised_common_nouns_are_dropped(self):
        for noise in ["Ouders", "School", "Bank", "MEDIATOR", "Mediator"]:
            self.assertTrue(_is_noise_person_org(noise), noise)

    def test_real_names_are_kept(self):
        for name in [
            "Mark van Dalen",
            "Sanne de Wit",
            "Mr. Eva Meijer",
            "notaris Van Beek",
            "Tim",
            "Noor",
        ]:
            self.assertFalse(_is_noise_person_org(name), name)

    def test_lowercase_multiword_names_are_kept(self):
        # Informal lowercase chat names must NOT be filtered (privacy recall).
        for name in ["jan jansen", "muhammad al-sayed", "sanne de wit"]:
            self.assertFalse(_is_noise_person_org(name), name)

    def test_single_lowercase_word_is_dropped(self):
        for noise in ["schoolactiviteiten", "woning", "kantoor"]:
            self.assertTrue(_is_noise_person_org(noise), noise)

    def test_noise_filtered_end_to_end(self):
        # A ready model returns both a real name and lowercase noise; only the
        # real name survives detection.
        svc = _install_fake(["Sanne", "bank", "ouders"])
        r = svc.detect(
            "Beste Sanne, de bank en de ouders.",
            confidence_threshold=0.7,
            enabled_categories=["Person", "Organization"],
        )
        found = {e["text"] for e in r["entities"]}
        self.assertIn("Sanne", found)
        self.assertNotIn("bank", found)
        self.assertNotIn("ouders", found)


class BatchingTests(unittest.TestCase):
    def test_offsets_correct_across_chunks(self):
        # A name in a LATER chunk — past the fixed sub-batch size, so it lands
        # in a second model batch — must still map to its absolute offset in
        # the full text (regression guard for the batched chunk_offset math
        # and the OOM-safe sub-batching).
        from app.services.pii import _MODEL_BATCH_SIZE, _CHUNK_CHAR_LIMIT

        svc = _install_fake(["Sanne"])
        # Enough filler to produce well more than _MODEL_BATCH_SIZE chunks.
        filler = "Dit is een lange zin over de zaak van de familie. " * (
            (_MODEL_BATCH_SIZE + 4) * (_CHUNK_CHAR_LIMIT // 50 + 1)
        )
        text = filler + " Aan het eind staat Sanne."
        r = svc.detect(text, confidence_threshold=0.7, enabled_categories=["Person"])
        persons = [e for e in r["entities"] if e["category"] == "Person"]
        self.assertTrue(persons, "name in a late sub-batch was not detected")
        for e in persons:
            # The reported offset/length must actually point at the name.
            self.assertEqual(text[e["offset"] : e["offset"] + e["length"]], e["text"])

    def test_every_call_is_one_padded_pass(self):
        # GLiNER.inference defaults to batch_size=8 and splits a longer list
        # into several passes; _MODEL_BATCH_SIZE promises one pass per call.
        svc = _install_fake(["Sanne"])
        svc.detect(
            "Beste Sanne", confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertEqual(
            svc._model.last_inference_kwargs,
            {"flat_ner": True, "batch_size": 1},
        )


class DegradedSignalTests(unittest.TestCase):
    def test_model_not_ready_is_degraded(self):
        svc = get_pii_service()
        svc._model = None
        svc._ready = False
        svc._load_error = "OSError: model download blocked"
        # A GLiNER category (Person) is requested but the model can't run.
        result = svc.detect(
            "Beste Mark en Sanne",
            confidence_threshold=0.7,
            enabled_categories=["Person"],
        )
        self.assertTrue(result["degraded"])
        self.assertIn("model_not_ready", result["degraded_reason"])

    def test_regex_only_request_not_degraded(self):
        # Email is regex-complete — GLiNER never needed, so not degraded even
        # when the model is down.
        svc = get_pii_service()
        svc._model = None
        svc._ready = False
        result = svc.detect(
            "mail me at a@b.com", confidence_threshold=0.7, enabled_categories=["Email"]
        )
        self.assertFalse(result["degraded"])
        self.assertTrue(result["hasPii"])

    def test_ready_model_not_degraded(self):
        svc = _install_fake(["Mark"])
        result = svc.detect(
            "Beste Mark", confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertFalse(result["degraded"])
        self.assertIsNone(result["degraded_reason"])


class SliderEffectivenessTests(unittest.TestCase):
    """The slider must shift the Person floor (BFSF-269 quality fix)."""

    def _detect_at(self, slider, score):
        svc = _install_fake(["Mark"], score=score)
        return svc.detect(
            "Beste Mark", confidence_threshold=slider, enabled_categories=["Person"]
        )

    def test_low_confidence_name_passes_at_detect_more(self):
        # score 0.42 would be dropped by the old hard 0.45 floor; at the
        # default slider the floor is 0.40, and "Detect more" lowers it further.
        r = self._detect_at(slider=0.10, score=0.42)
        self.assertIn("Mark", _names(r))

    def test_low_confidence_name_filtered_at_detect_less(self):
        # Dragging toward "Detect less" (1.0) raises the Person floor to ~0.70,
        # so a 0.42 span is now filtered out.
        r = self._detect_at(slider=1.0, score=0.42)
        self.assertNotIn("Mark", _names(r))

    def test_default_slider_keeps_tuned_floor(self):
        # At the anchor slider the tuned Person floor (0.40) applies verbatim.
        # (The 2026-07-31 calibrated raise to 0.77 was applied and REVERTED by
        # the hybrid gate — see the _PER_CATEGORY_THRESHOLD block comment.)
        self.assertIn(
            "Mark", _names(self._detect_at(slider=_UI_DEFAULT_THRESHOLD, score=0.41))
        )
        self.assertNotIn(
            "Mark", _names(self._detect_at(slider=_UI_DEFAULT_THRESHOLD, score=0.39))
        )


class ChunkingTests(unittest.TestCase):
    def test_chunk_helper_splits_long_text(self):
        short = "x" * 100
        self.assertEqual(len(_chunk_text(short)), 1)
        long = "word " * 800  # 4000 chars → multiple chunks
        self.assertGreater(len(_chunk_text(long)), 1)

    def test_name_past_first_chunk_is_detected(self):
        # A name well beyond the 1500-char first-chunk limit must still be
        # found — the detector accumulates across chunks (BFSF-269 legal docs).
        svc = _install_fake(["Sanne"])
        filler = "Dit is een lange zin over de zaak. " * 60  # > 1500 chars
        text = filler + " Met vriendelijke groet, Sanne."
        self.assertGreater(len(text), 1500)
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertIn("Sanne", _names(result))


class TokenChunkingTests(unittest.TestCase):
    """Token-aware chunking: the headline recall fix (BFSF token truncation)."""

    def test_snap_boundary_prefers_sentence_end(self):
        text = "Zin een. Zin twee gaat verder en verder"
        # end mid-second-sentence -> snaps back to after "Zin een. "
        self.assertEqual(_snap_boundary(text, 0, 20), len("Zin een. "))

    def test_token_index_at_char(self):
        offs = [(0, 3), (4, 7), (8, 11)]
        self.assertEqual(_token_index_at_char(offs, 0), 0)
        self.assertEqual(_token_index_at_char(offs, 4), 1)
        self.assertEqual(_token_index_at_char(offs, 5), 2)

    def test_model_limits_reads_config_and_tokenizer(self):
        class Cfg:
            max_len = 512

        class Model:
            config = Cfg()
            tokenizer = FakeTokenizer()

        tok, max_len = _model_limits(Model())
        self.assertEqual(max_len, 512)
        self.assertIsInstance(tok, FakeTokenizer)

    def test_chunks_are_verbatim_slices_with_exact_offsets(self):
        words = [f"woord{i}" for i in range(40)]
        text = " ".join(words)
        chunks = _chunk_text_tokens(
            text, FakeTokenizer(), budget_tokens=8, overlap_tokens=2
        )
        self.assertGreater(len(chunks), 1)
        for off, ch in chunks:
            self.assertEqual(text[off : off + len(ch)], ch)  # verbatim slice

    def test_full_coverage_no_dead_zone(self):
        # Every character of the text must be covered by at least one chunk —
        # the OLD char/overlap scheme left a token-space dead zone.
        words = [f"w{i:03d}" for i in range(60)]
        text = " ".join(words)
        chunks = _chunk_text_tokens(
            text, FakeTokenizer(), budget_tokens=7, overlap_tokens=2
        )
        covered = [False] * len(text)
        for off, ch in chunks:
            for k in range(off, off + len(ch)):
                covered[k] = True
        # Allow the single spaces between tokens to be uncovered; assert every
        # non-space char is covered.
        for k, c in enumerate(text):
            if c != " ":
                self.assertTrue(
                    covered[k], f"char {k} ({c!r}) not covered by any chunk"
                )

    def test_dispatcher_falls_back_to_chars_without_tokenizer(self):
        text = "x" * 100
        self.assertEqual(len(_chunk_text(text)), 1)  # no tokenizer -> char path
        self.assertEqual(len(_chunk_text(text, None, None)), 1)

    def test_transcript_text_does_not_explode_the_chunk_count(self):
        """The 78-chunks-for-8k-chars pathology, pinned (prod log 2026-07-31).

        Meeting transcripts are windows of short "Speaker (12:34): text.\\n"
        lines with ONE ". " sentence early on. _snap_boundary tried separators
        best-first across the whole window, so that lone ". " beat every
        nearby newline, the cut snapped back near the window START, and the
        net advance shrank below the overlap: an 8,000-char window became 78
        chunks and 61 seconds of model time. The bounded snap keeps the cut in
        the last 15% of the window; the chunk count must stay ~tokens/step.
        """
        # One early real sentence, then hundreds of short transcript lines
        # whose only separators are ".\n" (never ". ").
        lines = ["Intro zin een. Verder gaat het gesprek over planning"]
        lines += [
            f"Spreker{i % 3} ({i // 60:02d}:{i % 60:02d}): Helemaal goed hoor.\n"
            for i in range(400)
        ]
        text = " ".join(lines)
        budget, overlap = 100, 15
        chunks = _chunk_text_tokens(
            text, FakeTokenizer(), budget_tokens=budget, overlap_tokens=overlap
        )
        n_tokens = len(text.split())
        worst_case = (n_tokens // (budget - overlap)) * 2 + 2
        self.assertLess(
            len(chunks),
            worst_case,
            f"{len(chunks)} chunks for ~{n_tokens} tokens — the snap pathology is back",
        )
        # The bound must not cost coverage: every non-space char stays covered.
        covered = [False] * len(text)
        for off, ch in chunks:
            for k in range(off, off + len(ch)):
                covered[k] = True
        for k, c in enumerate(text):
            if not c.isspace():
                self.assertTrue(covered[k], f"char {k} ({c!r}) lost coverage")

    def test_tail_entity_past_token_budget_is_detected(self):
        # THE regression: a name far past the model's per-chunk token budget was
        # silently truncated under char chunking. With token-aware chunking +
        # overlap it must be found. Install a fake tokenizer + fake model.
        svc = _install_fake(["Sanne"])
        svc._tokenizer = FakeTokenizer()
        svc._text_token_budget = 12
        svc._overlap_tokens = 3
        try:
            filler = " ".join(f"woord{i}" for i in range(200))  # ~200 tokens
            text = filler + " Aan het einde staat Sanne hier."
            r = svc.detect(
                text, confidence_threshold=0.7, enabled_categories=["Person"]
            )
            names = [e for e in r["entities"] if e["category"] == "Person"]
            self.assertTrue(names, "deep-tail name past the token budget was missed")
            for e in names:
                self.assertEqual(
                    text[e["offset"] : e["offset"] + e["length"]], e["text"]
                )
        finally:
            svc._tokenizer = None
            svc._text_token_budget = None
            svc._overlap_tokens = None


class PartialScanTests(unittest.TestCase):
    """Oversize input yields a bounded partial scan, not all-or-nothing."""

    def test_scan_char_limit_bounds_the_gliner_scan(self):
        svc = _install_fake(["Sanne"])
        early = "Beste Sanne, "  # a name in the prefix
        filler = "Dit is filler tekst zonder namen. " * 80  # ~2700 chars
        tail = " En hier staat Sanne nogmaals."  # a name in the tail
        text = early + filler + tail
        limit = len(early) + 500  # cut well before the tail
        r = svc.detect(text, 0.7, ["Person"], scan_char_limit=limit)
        self.assertTrue(r["degraded"])
        self.assertEqual(r["degraded_reason"], "input_too_large_partial")
        self.assertIn("processed_chars", r)
        self.assertLess(r["processed_chars"], r["total_chars"])
        self.assertEqual(r["total_chars"], len(text))
        # The prefix name is found; the tail (past processed_chars) is not.
        persons = [e for e in r["entities"] if e["category"] == "Person"]
        self.assertTrue(persons)
        self.assertTrue(all(e["offset"] < r["processed_chars"] for e in persons))


class RegexTierTests(unittest.TestCase):
    def test_bfsf_sample_deterministic_pii(self):
        # Deterministic patterns must be caught by the regex tier alone.
        entities = detect_regex_pii(
            "IBAN NL91ABNA0417164300, plaat 12-AB-34, mail x@y.nl",
        )
        cats = {e["category"] for e in entities}
        self.assertIn("InternationalBankingAccountNumber", cats)
        self.assertIn("LicensePlateNumber", cats)
        self.assertIn("Email", cats)

    def test_titled_name_caught_by_regex(self):
        entities = detect_regex_pii("Met vriendelijke groet, Mr. Eva Meijer")
        persons = [e for e in entities if e["category"] == "Person"]
        self.assertTrue(persons)
        self.assertIn("Eva", persons[0]["text"])


class CacheKeyFingerprintTests(unittest.TestCase):
    """The cache key must identify the CONFIGURATION, not just the text.

    It hashed only (text, threshold, categories). GUARD_PII_REGEX_TIER is
    documented as a restart-not-rebuild rollout knob, so `on` and `off` pods
    coexist against one Redis for the 600 s TTL during a staged rollout — each
    serving the other's results for exactly the configurations the rollout
    exists to compare. The cached blob also carries the WRITER's tier_mode, so
    the log line attributes a result to a mode that did not produce it.
    """

    def _fp(self):
        from app.services.pii import _engine_fingerprint

        return _engine_fingerprint()

    def test_tier_mode_is_part_of_the_fingerprint(self):
        from app.config import settings
        from unittest.mock import patch

        with patch.object(settings, "pii_regex_tier", "on"):
            on = self._fp()
        with patch.object(settings, "pii_regex_tier", "off"):
            off = self._fp()
        self.assertNotEqual(
            on, off, "an `off` pod would serve an `on` pod's cached result"
        )

    def test_fingerprint_covers_model_and_grouping(self):
        import app.services.pii as pii
        from app.config import settings
        from unittest.mock import patch

        base = self._fp()
        pii.reset_engine_fingerprint()
        with patch.object(settings, "pii_model", "some/other-model"):
            other_model = self._fp()
        pii.reset_engine_fingerprint()
        self.assertNotEqual(base, other_model, "a model swap must invalidate the cache")

        # Through the seam, not by rebinding the package attribute. That used to
        # work only because the package mirrored writes onto every submodule
        # that bound the same name; with that gone, an assignment here would
        # leave the reader on the shipped grouping and this test would compare
        # a fingerprint with itself — passing while measuring nothing.
        with pii.use_label_groups([["person"]]):
            pii.reset_engine_fingerprint()
            regrouped = self._fp()
        pii.reset_engine_fingerprint()
        self.assertNotEqual(
            base,
            regrouped,
            "the grouping decides which categories are reachable at all",
        )

    def test_fingerprint_covers_the_gliner_library(self):
        # A gliner bump re-exports the ONNX graph under the same filename.
        import app.services.pii as pii
        from unittest.mock import patch

        pii.reset_engine_fingerprint()
        with patch(
            "app.services.pii.fingerprint._gliner_version", return_value="0.2.28"
        ):
            old = self._fp()
        pii.reset_engine_fingerprint()
        with patch(
            "app.services.pii.fingerprint._gliner_version", return_value="0.2.29"
        ):
            new = self._fp()
        pii.reset_engine_fingerprint()
        self.assertNotEqual(old, new, "a gliner upgrade must invalidate the cache")

    def test_gliner_version_without_the_package(self):
        # The unit-test environment has no gliner; the fingerprint must still build.
        from importlib.metadata import PackageNotFoundError
        from unittest.mock import patch

        from app.services.pii.fingerprint import _gliner_version

        with patch(
            "importlib.metadata.version", side_effect=PackageNotFoundError("gliner")
        ):
            self.assertEqual(_gliner_version(), "none")

    def test_fingerprint_is_stable_for_an_unchanged_configuration(self):
        # A key that varies run-to-run would silently disable the cache.
        self.assertEqual(self._fp(), self._fp())

    def test_cache_namespace_carries_the_schema_version(self):
        from app.services.pii import _CACHE_SCHEMA_VERSION

        self.assertGreaterEqual(
            _CACHE_SCHEMA_VERSION,
            3,
            "entries written under the old, configuration-blind "
            "derivation must not be readable under the new one",
        )


class DeterministicTieBreakTests(unittest.TestCase):
    """Equal confidence is not evidence, so it must not be ordered by floor.

    _label_margin subtracts the category's own floor so that scores drawn from
    different softmax denominators can be compared. That reasoning is about
    MODEL spans. A PatternSpec emits a fixed confidence, so between two
    deterministic candidates `margin = constant - floor` collapses to `-floor`,
    and the winner is whichever category happens to have the lowest floor —
    a number fitted to GLiNER score distributions, not a claim about which
    reading of the string is correct.

    What that cost, before this rule existed: PhoneNumber's floor (0.35) sits
    below NationalIdentificationNumber's (0.45), so every Swedish personnummer
    and every spaced Austrian SVNR was emitted as a phone number; and
    CreditCardNumber's (0.40) also sits below it, so a French NIR that happens
    to satisfy Luhn — one in ten do — came back as a credit card. The span was
    still redacted, so this never leaked; it mislabelled, which is what the
    restore token and any category-scoped policy read.
    """

    def _resolve(self, text):
        ents = detect_regex_pii(text)
        return [
            (e["category"], e["text"])
            for e in PiiService._finalise(ents, text=text)["entities"]
        ]

    def test_checksummed_national_ids_are_not_relabelled_as_phone_numbers(self):
        # Both values satisfy their own checksum AND the phone pattern.
        for text, value in (
            ("SVNR 1005 200671 hier", "1005 200671"),  # AT, mod-11
            ("personnummer 740213-1804 hier", "740213-1804"),  # SE, Luhn
        ):
            self.assertEqual(
                self._resolve(text), [("NationalIdentificationNumber", value)], text
            )

    def test_a_luhn_passing_nir_is_not_a_credit_card(self):
        # 181124482088357 satisfies the NIR mod-97 key AND Luhn.
        self.assertEqual(
            self._resolve("NIR 181124482088357 hier"),
            [("NationalIdentificationNumber", "181124482088357")],
        )

    def test_the_wider_candidate_names_the_cluster(self):
        # Precedence alone is too blunt: CreditCardNumber outranks PhoneNumber,
        # but on "+49 151 79376392" the card pattern matches only the 15
        # characters after the `+` while the phone pattern explains all 16. The
        # `+` is evidence the card reading cannot account for, and handing this
        # span to CreditCardNumber measured -3.0pp on that category's precision.
        self.assertEqual(
            self._resolve("bereikbaar op +49 151 79376392"),
            [("PhoneNumber", "+49 151 79376392")],
        )

    def test_extent_only_decides_between_equal_confidences(self):
        # A longer span must NOT be able to outvote a genuinely higher score;
        # that is the margin ordering's job and it stays untouched.
        wide_but_weak = {
            "offset": 0,
            "length": 30,
            "category": "Person",
            "confidence": 0.45,
            "text": "x",
            "label": "Person Name",
        }
        narrow_but_strong = {
            "offset": 0,
            "length": 10,
            "category": "Organization",
            "confidence": 0.95,
            "text": "y",
            "label": "Organization",
        }
        self.assertEqual(
            _pick_label([wide_but_weak, narrow_but_strong])["category"],
            "Organization",
        )

    def test_equal_confidence_and_equal_extent_falls_through_to_precedence(self):
        pair = [
            {
                "offset": 0,
                "length": 12,
                "category": "PhoneNumber",
                "confidence": 0.99,
                "text": "x",
                "label": "Phone Number",
            },
            {
                "offset": 0,
                "length": 12,
                "category": "NationalIdentificationNumber",
                "confidence": 0.99,
                "text": "x",
                "label": "National ID",
            },
        ]
        self.assertEqual(_pick_label(pair)["category"], "NationalIdentificationNumber")
        # ...and it must not depend on which order they arrived in.
        self.assertEqual(
            _pick_label(list(reversed(pair)))["category"],
            "NationalIdentificationNumber",
        )


class SiblingContextTieBreakTests(unittest.TestCase):
    """An anchored RSIN must not be labelled a personal BSN.

    pii_regex.py promised this in a comment — "If both fire on the same span we
    want RSIN to win when the anchor word is present" — and nothing implemented
    it. It could not work as written either: _finalise sorts its input so
    emission order is discarded, and both spans carry 0.99 while
    TaxIdentificationNumber's floor (0.55) is HIGHER than
    NationalIdentificationNumber's (0.45), so BSN always had the larger margin.
    RSIN would have needed a confidence of 1.09 to win.

    Measured, not hypothetical: eval/metrics.hybrid-newtiebreak.json records
    "TaxIdentificationNumber->NationalIdentificationNumber": 5 — every anchored
    RSIN in the held-out split, half of that category's misses.

    Labelling a company's fiscal number as a citizen's BSN is also a reporting
    error in the direction that matters for a privacy product: it claims
    personal data where there is none.
    """

    def _resolve(self, text):
        ents = detect_regex_pii(text)
        return [
            (e["category"], e["text"])
            for e in PiiService._finalise(ents, text=text)["entities"]
        ]

    def test_anchored_rsin_wins_over_bare_bsn(self):
        self.assertEqual(
            self._resolve("Het RSIN 123456782 van de stichting"),
            [("TaxIdentificationNumber", "123456782")],
        )
        self.assertEqual(
            self._resolve("Fiscaal nummer 123456782 hier"),
            [("TaxIdentificationNumber", "123456782")],
        )

    def test_unanchored_nine_digits_stay_a_bsn(self):
        self.assertEqual(
            self._resolve("Mijn BSN 123456782 staat erop"),
            [("NationalIdentificationNumber", "123456782")],
        )
        self.assertEqual(
            self._resolve("Nummer 123456782 zonder context"),
            [("NationalIdentificationNumber", "123456782")],
        )

    def test_outcome_is_independent_of_input_order(self):
        import itertools

        text = "Het RSIN 123456782 van de stichting"
        ents = detect_regex_pii(text)
        self.assertGreater(len(ents), 1, "expected a genuine two-candidate cluster")
        outcomes = {
            tuple(
                (e["category"], e["offset"], e["length"])
                for e in PiiService._finalise(list(perm), text=text)["entities"]
            )
            for perm in itertools.permutations(ents)
        }
        self.assertEqual(len(outcomes), 1, f"order-dependent result: {outcomes}")

    def test_rule_does_not_fire_for_non_sibling_pairs(self):
        # The escape hatch must not leak into the contests the margin ordering
        # and _SPECIFIC_OVER_GENERAL exist to settle.
        cluster = [
            {
                "offset": 0,
                "length": 18,
                "category": "InternationalBankingAccountNumber",
                "confidence": 0.90,
                "text": "x",
                "label": "IBAN",
                "context_hit": True,
            },
            {
                "offset": 0,
                "length": 18,
                "category": "BankAccountNumber",
                "confidence": 0.95,
                "text": "x",
                "label": "Bank Account",
            },
        ]
        winner = _pick_label(cluster)
        # Whatever wins here, it must be decided by the existing rules — the
        # context flag alone must not hand it to the IBAN.
        self.assertEqual(
            winner["category"],
            _pick_label(
                [
                    {**cluster[0], "context_hit": False},
                    cluster[1],
                ]
            )["category"],
        )

    def test_context_flag_never_changes_the_redacted_extent(self):
        # The rule may only change the LABEL. union(kept) == union(input) is the
        # anti-leak invariant and must survive it.
        text = "Het RSIN 123456782 van de stichting"
        ents = detect_regex_pii(text)
        covered_in = {
            i for e in ents for i in range(e["offset"], e["offset"] + e["length"])
        }
        out = PiiService._finalise(ents, text=text)["entities"]
        covered_out = {
            i for e in out for i in range(e["offset"], e["offset"] + e["length"])
        }
        self.assertEqual(covered_in, covered_out)

    def test_sibling_table_only_names_real_categories(self):
        from app.services.pii import _CONTEXT_SEPARABLE_SIBLINGS, ALL_CATEGORIES

        for sib in _CONTEXT_SEPARABLE_SIBLINGS:
            self.assertGreaterEqual(
                len(sib), 2, "a sibling set needs at least two members"
            )
            for cat in sib:
                self.assertIn(cat, ALL_CATEGORIES, f"{cat} is not a known category")


class Ipv6PatternTests(unittest.TestCase):
    """The IPv6 recognizer was wrong in both directions, and shipped.

    `\\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\\b` matched every HH:MM:SS
    timestamp and every MAC address at confidence 0.99. IPAddress is in
    REGEX_COMPLETE_CATEGORIES, so GLiNER is never asked and cannot dissent;
    regex spans skip _apply_validators; and _validate_ip returned None for
    anything without exactly three dots. With the Node-side default
    action=block, any message containing a time of day was refused.

    The same pattern could not express `::`, so a real address matched only
    PARTIALLY — the redaction covered the tail and left the prefix in cleartext.

    The corpus contains no HH:MM:SS strings, so over_redaction_rate was
    structurally blind to this. That is why the negatives below are asserted
    here rather than left to the eval gate.
    """

    def _ips(self, text):
        return [e["text"] for e in detect_regex_pii(text, {"IPAddress"})]

    def test_timestamps_are_not_ip_addresses(self):
        for text in (
            "De vergadering is om 12:30:45 afgelopen.",
            "Levering rond 09:15:00 verwacht",
            "Om 9:05:00 begint het",
            "van 12:30:45-13:00:00 duurt het",
            "tijd 23:59:59 UTC",
            "beeldverhouding 16:9:1",
        ):
            with self.subTest(text=text):
                self.assertEqual(self._ips(text), [])

    def test_mac_address_is_not_an_ip_address(self):
        self.assertEqual(self._ips("MAC aa:bb:cc:dd:ee:ff"), [])

    def test_real_ipv6_is_detected_whole(self):
        """The span must cover the WHOLE address.

        A partial span is worse than no span: it redacts some of the address
        and leaves the rest readable, while still reporting a detection.
        """
        for text, want in (
            ("Server op 2001:db8::8a2e:370:7334 draait", "2001:db8::8a2e:370:7334"),
            ("fe80::1 is link-local", "fe80::1"),
            ("loopback ::1 test", "::1"),
            (
                "vol 2001:0db8:85a3:0000:0000:8a2e:0370:7334 hier",
                "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
            ),
        ):
            with self.subTest(text=text):
                self.assertEqual(self._ips(text), [want])

    def test_ipv4_mapped_address_is_redacted_whole(self):
        """`::ffff:192.0.2.1` legitimately produces two overlapping candidates.

        The IPv4 recognizer fires on the embedded dotted quad. That is fine —
        detect_regex_pii returns PRE-resolution candidates — but the redaction
        that ships is _finalise's union, and that must cover the whole address
        rather than only the tail.
        """
        text = "mapped ::ffff:192.0.2.1 ok"
        self.assertIn("::ffff:192.0.2.1", self._ips(text))
        resolved = PiiService._finalise(
            detect_regex_pii(text, {"IPAddress"}), text=text
        )
        spans = [(e["offset"], e["length"]) for e in resolved["entities"]]
        self.assertEqual(
            len(spans), 1, "overlapping candidates must resolve to one span"
        )
        off, length = spans[0]
        self.assertEqual(text[off : off + length], "::ffff:192.0.2.1")

    def test_ipv4_still_works(self):
        self.assertEqual(self._ips("host 192.0.2.1 hier"), ["192.0.2.1"])
        self.assertEqual(self._ips("versie 999.1.1.1 bestaat niet"), [])

    def test_offsets_still_slice_back_to_the_span(self):
        # _finalise and the Node redactor both index the original string by
        # offset/length; a lookaround bug here shifts every redaction.
        text = "Ping 2001:db8::1 en 192.0.2.7 nu"
        for e in detect_regex_pii(text, {"IPAddress"}):
            self.assertEqual(text[e["offset"] : e["offset"] + e["length"]], e["text"])

    def test_model_tier_validator_now_has_an_opinion_on_ipv6(self):
        # _validate_ip used to return None for anything without three dots, so
        # a model span labelled IPAddress was never checked arithmetically.
        from app.services.pii_validators import validate

        self.assertTrue(validate("IPAddress", "2001:db8::1"))
        self.assertFalse(validate("IPAddress", "12:30:45"))
        self.assertTrue(validate("IPAddress", "192.0.2.1"))
        self.assertFalse(validate("IPAddress", "256.0.0.1"))
        self.assertIsNone(validate("IPAddress", "not an address"))


# app.config pulls pydantic_settings, which is only present in the container
# (not the stdlib-only local run). Skip cleanly when it's missing.
try:
    import pydantic_settings  # noqa: F401

    _HAS_CONFIG_DEPS = True
except Exception:
    _HAS_CONFIG_DEPS = False


@unittest.skipUnless(
    _HAS_CONFIG_DEPS, "app.config requires pydantic_settings (container only)"
)
class SizeCapTests(unittest.TestCase):
    def test_input_over_hard_cap_is_refused(self):
        # Beyond the ABSOLUTE ceiling: refuse outright (degraded) rather than
        # pin cores — the Node side then fails closed. Protects the pod.
        import asyncio
        from app.config import settings

        svc = _install_fake(["Mark"])
        big = "Mark en Sanne wonen hier. " * (
            (settings.pii_hard_max_chars // 26) + 1000
        )
        self.assertGreater(len(big), settings.pii_hard_max_chars)
        r = asyncio.run(svc.detect_async(big, 0.7, ["Person"]))
        self.assertTrue(r["degraded"])
        self.assertEqual(r["degraded_reason"], "input_too_large")
        self.assertEqual(r["entities"], [])

    def test_large_input_is_partially_scanned(self):
        # Between the scan budget and the hard cap: scan a PREFIX and return a
        # partial result (degraded + coverage) rather than dropping everything.
        # Sparse names keep _finalise's overlap resolution cheap.
        import asyncio
        from app.config import settings

        svc = _install_fake(["Mark"])
        block = "Dit is filler tekst voor de test. " * 30 + "Beste Mark, groet. "
        reps = (settings.pii_max_chars // len(block)) + 60
        big = block * reps
        self.assertGreater(len(big), settings.pii_max_chars)
        self.assertLessEqual(len(big), settings.pii_hard_max_chars)
        r = asyncio.run(svc.detect_async(big, 0.7, ["Person"]))
        self.assertTrue(r["degraded"])
        self.assertEqual(r["degraded_reason"], "input_too_large_partial")
        self.assertLess(r["processed_chars"], r["total_chars"])
        self.assertEqual(r["total_chars"], len(big))
        self.assertTrue(any(e["category"] == "Person" for e in r["entities"]))


class ScanBudgetTests(unittest.TestCase):
    """The per-request WORK budget, distinct from the memory ceilings above.

    pii_max_chars (1M) is a memory bound. It was also, accidentally, the only
    thing standing between a large paste and an unbounded scan — and the caller
    gives up after 90s. Production consequence: 52,990 chars took 278s, the Node
    client reported the guard unreachable, and a fail-closed org blocked the
    user's message. Nothing had refused the work; there was simply too much of
    it, and no ceiling shaped like time.
    """

    def setUp(self):
        from app.config import settings

        self.settings = settings
        self._saved = (settings.pii_scan_budget_chars, settings.pii_regex_tier)

    def tearDown(self):
        (self.settings.pii_scan_budget_chars, self.settings.pii_regex_tier) = (
            self._saved
        )

    def test_budget_follows_the_tier_because_the_tier_sets_the_cost(self):
        from app.services.pii import _scan_budget_chars

        self.settings.pii_scan_budget_chars = 0
        self.settings.pii_regex_tier = "on"
        on = _scan_budget_chars()
        self.settings.pii_regex_tier = "shadow"
        shadow = _scan_budget_chars()
        # shadow asks GLiNER for all 7 label groups AND pays the regex tier, so
        # it buys fewer characters for the same wall-clock.
        self.assertLess(shadow, on)

    def test_an_explicit_budget_wins(self):
        from app.services.pii import _scan_budget_chars

        self.settings.pii_scan_budget_chars = 4321
        self.assertEqual(_scan_budget_chars(), 4321)

    def test_the_budget_never_exceeds_the_memory_ceiling(self):
        from app.services.pii import _scan_budget_chars

        saved = self.settings.pii_max_chars
        try:
            self.settings.pii_max_chars = 500
            self.settings.pii_scan_budget_chars = 100_000
            self.assertEqual(_scan_budget_chars(), 500)
        finally:
            self.settings.pii_max_chars = saved

    def test_text_over_the_budget_is_partial_rather_than_slow(self):
        import asyncio
        from app.services.pii import _scan_budget_chars

        self.settings.pii_scan_budget_chars = 2_000
        svc = _install_fake(["Mark"])
        big = "Beste Mark, dit is filler tekst voor de test. " * 200
        self.assertGreater(len(big), _scan_budget_chars())
        r = asyncio.run(svc.detect_async(big, 0.7, ["Person"]))
        self.assertTrue(r["degraded"])
        self.assertEqual(r["degraded_reason"], "input_too_large_partial")
        self.assertLess(r["processed_chars"], r["total_chars"])
        # Partial must still return the redactions it DID compute — the point
        # of a partial result over a timeout.
        self.assertTrue(any(e["category"] == "Person" for e in r["entities"]))

    def test_text_within_the_budget_is_a_normal_full_scan(self):
        import asyncio

        self.settings.pii_scan_budget_chars = 100_000
        svc = _install_fake(["Mark"])
        r = asyncio.run(svc.detect_async("Beste Mark, groet.", 0.7, ["Person"]))
        self.assertFalse(r["degraded"])
        self.assertIsNone(r.get("processed_chars"))


class SkippableTests(unittest.TestCase):
    def test_empty_and_short(self):
        self.assertTrue(_is_skippable(""))
        self.assertTrue(_is_skippable("   "))
        self.assertTrue(_is_skippable("ok"))

    def test_placeholder_only_is_skippable(self):
        self.assertTrue(_is_skippable("[person_1] [email_2]"))

    def test_real_text_not_skippable(self):
        self.assertFalse(_is_skippable("Beste Mark"))


class LabelGroupFileTests(unittest.TestCase):
    """eval/label_groups/current.json must actually BE current.

    Regression test for a real methodology failure: that file went stale after
    the label map changed, still naming removed labels. A grouping A/B then
    compared a configuration against ITSELF — both files pruned to the same
    active groups — and reported "no recall change, no speedup" as if that
    were a finding rather than a broken experiment.

    A baseline file that silently stops being the baseline invalidates every
    comparison made against it, quietly.
    """

    def _load(self, name):
        import json
        import os

        path = os.path.join(
            os.path.dirname(__file__), "..", "eval", "label_groups", name
        )
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_current_json_matches_production(self):
        from app.services.pii import _LABEL_GROUPS

        self.assertEqual(
            self._load("current.json"),
            [list(g) for g in _LABEL_GROUPS],
            "eval/label_groups/current.json has drifted from _LABEL_GROUPS — "
            "any A/B run against it is measuring the wrong baseline",
        )

    def test_candidate_files_reference_only_known_labels(self):
        from app.services.pii import GLINER_LABELS_TO_CATEGORY as M

        for name in ("current.json", "merged.json"):
            for group in self._load(name):
                for label in group:
                    with self.subTest(file=name, label=label):
                        self.assertIn(
                            label,
                            M,
                            "label is not in the category "
                            "map and would be silently dropped",
                        )

    def test_candidate_files_cover_every_category(self):
        from app.services.pii import GLINER_LABELS_TO_CATEGORY as M, ALL_CATEGORIES

        for name in ("current.json", "merged.json"):
            covered = {M[l] for g in self._load(name) for l in g if l in M}
            with self.subTest(file=name):
                self.assertEqual(
                    covered,
                    set(ALL_CATEGORIES),
                    "candidate partition drops categories entirely",
                )


def _model_span(text, word, category, confidence=0.9):
    offset = text.index(word)
    return {
        "text": word,
        "category": category,
        "label": category,
        "confidence": confidence,
        "offset": offset,
        "length": len(word),
        "source": "model",
    }


class ShapeFilterTests(unittest.TestCase):
    """Every fixture here is modelled on one pasted meeting transcript.

    Names and companies are fictional; the SHAPES are the ones the model got
    wrong. They survived BOTH the "high" (0.45) and the "balanced" (0.70)
    sensitivity preset, which is the point: the confidence slider cannot
    express "a phone number contains digits". See _precision_filter.
    """

    def test_times_of_day_are_not_phone_numbers(self):
        text = "Theodorus (06:42): ik bel om 06:09 terug, uiterlijk 12:34:56."
        for clock in ("06:42", "06:09", "12:34:56"):
            ents = _precision_filter([_model_span(text, clock, "PhoneNumber")])
            self.assertEqual(ents, [], f"{clock} was kept as a PhoneNumber")

    def test_a_company_name_is_not_a_phone_number(self):
        text = "Het contract loopt via 24x7 KT4 en niet via de holding."
        ents = _precision_filter([_model_span(text, "24x7 KT4", "PhoneNumber")])
        self.assertEqual(ents, [])

    def test_an_acronym_is_not_a_social_security_number(self):
        text = "De KWP-melding staat nog open bij de leverancier."
        ents = _precision_filter([_model_span(text, "KWP", "USSocialSecurityNumber")])
        self.assertEqual(ents, [])

    def test_real_identifiers_survive(self):
        text = (
            "Bel 0612345678 of 06 12 34 56 78, kaart 4111 1111 1111 1111, "
            "IBAN NL91ABNA0417164301, BSN 123456782."
        )
        keep = [
            ("0612345678", "PhoneNumber"),
            ("06 12 34 56 78", "PhoneNumber"),
            ("4111 1111 1111 1111", "CreditCardNumber"),
            ("NL91ABNA0417164301", "InternationalBankingAccountNumber"),
            ("123456782", "NationalIdentificationNumber"),
        ]
        for word, category in keep:
            ents = _precision_filter([_model_span(text, word, category)])
            self.assertEqual(len(ents), 1, f"{category} {word!r} was dropped")

    def test_regex_spans_are_never_touched(self):
        # A regex near-miss is a DELIBERATE demotion (checksum failed but the
        # shape is distinctive). The shape filter must not undo that decision.
        text = "IBAN NL91ABNA0417164302 stond op de factuur."
        span = _model_span(
            text,
            "NL91ABNA0417164302",
            "InternationalBankingAccountNumber",
            confidence=0.693,
        )
        span["source"] = "regex"
        span["near_miss"] = "checksum_failed"
        self.assertEqual(_precision_filter([span]), [span])

    def test_the_digit_rule_covers_only_phone_and_ssn(self):
        """Scope guard — re-broadening this needs the eval gate, not an opinion.

        A first version covered ten identifier categories. Several of them carry
        real identifiers that are mostly LETTERS (foreign policy numbers,
        alphanumeric tax references), so a digit floor there drops true
        positives — and a dropped model span over a value the regex tier only
        partly covers turns a full redaction into a clipped one. The eval corpus
        cannot settle it either way (its values are well-formed), so the narrow
        scope is precautionary and stays until measurement says otherwise.
        """
        from app.services.pii import _MIN_DIGITS_BY_CATEGORY

        self.assertEqual(
            set(_MIN_DIGITS_BY_CATEGORY), {"PhoneNumber", "USSocialSecurityNumber"}
        )

    def test_letter_heavy_identifiers_are_not_dropped(self):
        text = "Polisnummer AB123CD45 en fiscaal nummer RSSMRA85T10A562S staan in het dossier."
        for word, category in (
            ("AB123CD45", "HealthInsuranceNumber"),
            ("RSSMRA85T10A562S", "TaxIdentificationNumber"),
        ):
            self.assertEqual(
                len(_precision_filter([_model_span(text, word, category)])),
                1,
                f"{category} {word!r} was dropped",
            )

    def test_opaque_identifiers_are_not_phone_numbers(self):
        """A message id clears the digit floor and still is not a number.

        Real failure: a Gmail message id is 16 hex characters, 8 of them digits,
        and GLiNER scores it 0.68-0.83 as a Phone Number. Redacting one broke the
        call it addresses — a routine reading each mail of a search result died on
        "Invalid id value" for every iteration.
        """
        for word in (
            "19fdc22de311daf4",
            "19fd5d9c1ce2c1f4",
            "19fb463a8dae39db",
            "AAMkAGI2THVSAAA0",
            "1BxiMVs0XRA5nFMdKvBdBZ",
        ):
            text = f"Bericht {word} is opgehaald."
            ents = _precision_filter([_model_span(text, word, "PhoneNumber")])
            self.assertEqual(ents, [], f"{word} was kept as a PhoneNumber")

    def test_phone_numbers_with_an_extension_survive(self):
        """The only letters a real phone number carries mark an extension."""
        text = "Bel 020-1234567 ext. 12 of 0612345678x99 voor de storingsdienst."
        for word in ("020-1234567 ext. 12", "0612345678x99"):
            ents = _precision_filter([_model_span(text, word, "PhoneNumber")])
            self.assertEqual(len(ents), 1, f"{word!r} was dropped")

    def test_a_grouped_number_is_not_read_as_an_identifier(self):
        """Separators are what tell a written number from an opaque handle."""
        text = "Nummers: +31 6 12345678, 06-12-34-56-78 en 06.12.34.56.78."
        for word in ("+31 6 12345678", "06-12-34-56-78", "06.12.34.56.78"):
            ents = _precision_filter([_model_span(text, word, "PhoneNumber")])
            self.assertEqual(len(ents), 1, f"{word!r} was dropped")

    def test_categories_without_a_digit_rule_pass_through(self):
        text = "Tom Smit werkt bij Dekker Techniek in Zeewolde."
        for word, category in (
            ("Tom Smit", "Person"),
            ("Dekker Techniek", "Organization"),
            ("Zeewolde", "Address"),
        ):
            self.assertEqual(
                len(_precision_filter([_model_span(text, word, category)])), 1
            )


class WordBoundaryRepairTests(unittest.TestCase):
    """A chunk opens on a SUBWORD token, so a name can arrive clipped.

    A clipped span of the shape `[person_5] -> "dorus van der Brug"` from
    "Theodorus van der Brug" reached production (names fictional).
    _postprocess_entities sees the FULL document, so it repairs the
    span whichever chunk (or Node window) produced it.
    """

    def test_a_clipped_name_is_grown_back_to_the_word_start(self):
        text = "Aanwezig was Theodorus van der Brug namens de klant."
        clipped = {
            "text": "dorus van der Brug",
            "category": "Person",
            "label": "Person",
            "confidence": 0.9,
            "offset": text.index("dorus van der Brug"),
            "length": len("dorus van der Brug"),
            "source": "model",
        }
        out = _postprocess_entities(text, [clipped])
        self.assertEqual(out[0]["text"], "Theodorus van der Brug")
        self.assertEqual(out[0]["offset"], text.index("Theodorus"))

    def test_a_span_clipped_at_the_end_is_grown_forward(self):
        text = "Contact is Sjoerd van Veldhuijzen, per mail."
        clipped = {
            "text": "Sjoerd van Veldhui",
            "category": "Person",
            "label": "Person",
            "confidence": 0.9,
            "offset": text.index("Sjoerd"),
            "length": len("Sjoerd van Veldhui"),
            "source": "model",
        }
        out = _postprocess_entities(text, [clipped])
        self.assertEqual(out[0]["text"], "Sjoerd van Veldhuijzen")

    def test_a_whole_word_span_is_left_alone(self):
        text = "Aanwezig was Theodorus van der Brug namens de klant."
        ent = _model_span(text, "Theodorus van der Brug", "Person")
        out = _postprocess_entities(text, [ent])
        self.assertEqual(out[0]["text"], "Theodorus van der Brug")
        self.assertEqual(out[0]["offset"], ent["offset"])

    def test_snap_start_is_bounded(self):
        # A long unbroken run must not drag the chunk start arbitrarily far back.
        text = "x" * 500 + " tail"
        self.assertEqual(_snap_start_to_word(text, 400, max_back=40), 360)

    def test_chunks_open_on_word_boundaries(self):
        # The end-to-end version: no chunk may begin mid-word.
        text = (
            "Theodorus van der Brug overlegde met Sjoerd van Veldhuijzen over "
            "de openstaande facturen van Dekker Techniek. "
        ) * 12
        chunks = _chunk_text_tokens(text, FakeTokenizer(), 40, 8)
        self.assertGreater(len(chunks), 1)
        for offset, _chunk in chunks:
            if offset == 0:
                continue
            self.assertFalse(
                text[offset - 1].isalnum() and text[offset].isalnum(),
                f"chunk at {offset} opens mid-word: {text[offset - 5 : offset + 10]!r}",
            )


def _spans(ents):
    return [(e["category"], e["text"]) for e in ents]


class CellBoundarySplitTests(unittest.TestCase):
    """BFSF-299: no span may cross a line or a table cell.

    The Node tokenizer splices every entity into ONE token, so a span over
    three cells collapsed them into one and the rest of the row shifted a
    column. Every fixture here is synthetic.
    """

    def test_a_span_over_three_lines_becomes_three_spans(self):
        text = "Adres:\nEsdoornlaan 7\n\n4321 ZX\n\nHoutdorp\nEinde"
        block = "Esdoornlaan 7\n\n4321 ZX\n\nHoutdorp"
        out = _postprocess_entities(text, [_model_span(text, block, "Address")])
        self.assertEqual(
            _spans(out),
            [
                ("Address", "Esdoornlaan 7"),
                ("Address", "4321 ZX"),
                ("Address", "Houtdorp"),
            ],
        )
        for ent in out:
            self.assertEqual(
                ent["text"], text[ent["offset"] : ent["offset"] + ent["length"]]
            )
            self.assertEqual(ent["confidence"], 0.9)

    def test_two_records_never_share_a_person_span(self):
        # A name list, one record per line: the model paired the surname of
        # record 1 with the first name of record 2. (The "Surname, First name"
        # form of this is in DisplayNameCellTests.)
        text = "Fenna Wolters\nJoost Brink\n"
        out = _postprocess_entities(
            text, [_model_span(text, "Wolters\nJoost", "Person")]
        )
        self.assertEqual(_spans(out), [("Person", "Wolters"), ("Person", "Joost")])

    def test_a_lone_particle_cell_is_not_a_name(self):
        # First name / particle / surname as three cells. The particle
        # identifies nobody, and as a token of its own it would be restored
        # into every "winter" of the conversation.
        for sep in ("\n", "\t", "\n\n", " | "):
            text = f"1{sep}Lotte{sep}van{sep}Driel{sep}Esdoornlaan 7"
            span = f"Lotte{sep}van{sep}Driel"
            out = _postprocess_entities(text, [_model_span(text, span, "Person")])
            self.assertEqual(
                _spans(out), [("Person", "Lotte"), ("Person", "Driel")], repr(sep)
            )

    def test_a_particle_on_another_line_is_not_pulled_into_the_name(self):
        text = "Lotte\nvan\nDriel"
        out = _postprocess_entities(text, [_model_span(text, "Driel", "Person")])
        self.assertEqual(_spans(out), [("Person", "Driel")])

    def test_a_particle_on_the_same_line_still_is(self):
        text = "Contact: Lotte van Driel"
        out = _postprocess_entities(text, [_model_span(text, "Driel", "Person")])
        self.assertEqual(_spans(out), [("Person", "van Driel")])

    def test_a_two_letter_surname_cell_stays_a_name(self):
        text = "Wei\nLi\n"
        out = _postprocess_entities(text, [_model_span(text, "Wei\nLi", "Person")])
        self.assertEqual(_spans(out), [("Person", "Wei"), ("Person", "Li")])

    def test_the_next_rows_number_is_not_part_of_a_phone_number(self):
        # "\n17" is the row number of the next record. The piece that is left
        # has too few digits to be a phone number and the shape filter drops it.
        text = "06 / 4827 3951\n17\nLotte"
        out = _postprocess_entities(
            text, [_model_span(text, "4827 3951\n17", "PhoneNumber")]
        )
        self.assertNotIn("17", [e["text"] for e in _precision_filter(out)])
        for ent in out:
            self.assertNotIn("\n", ent["text"])

    def test_a_bare_number_cell_is_no_value_of_its_own(self):
        # A "street | number" table, and the next row's number. As tokens of
        # their own, "7" and "12" would be replaced into every later "2027" or
        # "12:00" of the conversation. A piece with a letter, or a numeric
        # postcode, is still a value.
        for text, span, pieces in (
            (
                "Esdoornlaan\t7\t4321 ZX\tEde",
                "Esdoornlaan\t7\t4321 ZX\tEde",
                ["Esdoornlaan", "4321 ZX", "Ede"],
            ),
            ("Esdoornlaan 7\n12\nLotte", "Esdoornlaan 7\n12", ["Esdoornlaan 7"]),
            ("Esdoornlaan 7a\n12b\n", "Esdoornlaan 7a\n12b", ["Esdoornlaan 7a", "12b"]),
            (
                "Hoofdweg 5\t10115\tHoutdorp",
                "Hoofdweg 5\t10115\tHoutdorp",
                ["Hoofdweg 5", "10115", "Houtdorp"],
            ),
        ):
            out = _postprocess_entities(text, [_model_span(text, span, "Address")])
            self.assertEqual([e["text"] for e in out], pieces, repr(text))

    def test_a_span_inside_one_cell_is_left_alone(self):
        text = "Naam\tLotte van Driel\tHoutdorp"
        ent = _model_span(text, "Lotte van Driel", "Person")
        self.assertEqual(_postprocess_entities(text, [ent]), [ent])

    def test_a_titled_name_does_not_run_into_the_next_line(self):
        ents = detect_regex_pii("Mw. Fenna Wolters\nJoost Brink belt terug")
        persons = [e["text"] for e in ents if e["category"] == "Person"]
        self.assertEqual(persons, ["Mw. Fenna Wolters"])

    def test_detect_never_returns_a_span_over_a_cell_break(self):
        svc = _install_fake(["Lotte\tvan\tDriel", "Joost\nBrink"])
        text = "Lotte\tvan\tDriel\tHoutdorp\nJoost\nBrink\n"
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertEqual(sorted(_names(result)), ["Brink", "Driel", "Joost", "Lotte"])
        for ent in result["entities"]:
            for ch in "\n\t|":
                self.assertNotIn(ch, ent["text"])


# Every shape BFSF-296 reported leaking, with synthetic digits.
_REPORTED_PHONE_SHAPES = (
    "06 12 48 73 95",
    "010 - 482 73 95",
    "(078) 482 73 95",
    "06 / 4827 3951",
    "+31 (0)6 4827 3951",
    "038 482 73 95",
    "013/4827395",
    "06 (4827) 3951",
)


def _phones(text, regions=None):
    ents = detect_regex_pii(text, enabled_regions=regions)
    ents = PiiService._finalise(ents, text=text)["entities"]
    return [e["text"] for e in ents if e["category"] == "PhoneNumber"]


class PhoneRegexShapeTests(unittest.TestCase):
    """BFSF-296: the regex tier finds every reported shape as ONE span."""

    def test_every_reported_shape_is_one_whole_span(self):
        for number in _REPORTED_PHONE_SHAPES:
            for frame in ("Bel {} vandaag.", "{}", "tel: {}, of mail"):
                text = frame.format(number)
                self.assertEqual(_phones(text), [number], text)

    def test_common_shapes_stay_found(self):
        for number in (
            "06-48273951",
            "020-4827395",
            "06.48.27.39.51",
            "06-48-27-39-51",
            "+31 6 4827 3951",
            "+31648273951",
            "0031 6 48273951",
            "+49 151 48273951",
            "+44 7700 900482",
            "+32 470 48 27 39",
        ):
            self.assertEqual(_phones(f"Bel {number} nu"), [number], number)

    def test_a_number_never_takes_the_next_cell_or_line(self):
        # The row number of the next record sits after `\n` or `\t`.
        for number in _REPORTED_PHONE_SHAPES:
            for text in (f"Lotte\t{number}\t17\n", f"{number}\n17\nLotte"):
                self.assertEqual(_phones(text), [number], repr(text))

    def test_two_numbers_on_one_line_are_two_spans(self):
        self.assertEqual(
            _phones("06-48273951 / 06-51937284"), ["06-48273951", "06-51937284"]
        )
        self.assertEqual(
            _phones("06 48273951 06 51937284"), ["06 48273951", "06 51937284"]
        )
        # Grouped numbers in a list: the `/` or ` - ` between them belongs to
        # the list, so the first match may not end in the second one's "06".
        for text, numbers in (
            (
                "Tel. 020 - 482 73 95 / 06 - 12 48 73 95",
                ["020 - 482 73 95", "06 - 12 48 73 95"],
            ),
            (
                "Tel. 020 482 73 95 / 06 12 48 73 95",
                ["020 482 73 95", "06 12 48 73 95"],
            ),
            ("06 / 4827 3951 - 06 / 5193 7284", ["06 / 4827 3951", "06 / 5193 7284"]),
            (
                "+31 20 482 73 95 / +31 6 4827 3951",
                ["+31 20 482 73 95", "+31 6 4827 3951"],
            ),
        ):
            self.assertEqual(_phones(text), numbers, text)

    def test_dates_amounts_postcodes_and_times_are_not_phone_numbers(self):
        # NL only: the generic pattern is what changed. (The French one reads
        # "01-12-26 10.30" as a 10-digit number, as it did before.)
        for text in (
            "Geleverd op 01-12-2026.",
            "Geleverd op 12.03.2026.",
            "Geleverd op 01/12/2026.",
            "Afspraak op 01-12-2026 10:30 uur.",
            "Afspraak op 01-12-2026 10.30 uur.",
            "Afspraak op 01-12-26 10.30 uur.",
            "Open van 09.00 - 17.00 uur.",
            "Open 09.00 - 12.00 / 13.00 - 17.00.",
            "Totaal EUR 1.250,00 en EUR 0,50.",
            "Postcode 4321 ZX Houtdorp.",
            "Gebeld om 06:42 en 06:09.",
            "Versie 0.5.30 staat klaar.",
        ):
            self.assertEqual(_phones(text, regions=["NL"]), [], text)

    def test_the_national_patterns_stay_on_one_line(self):
        # Separators there were `\s` too; one per country.
        for text, regions in (
            ("612 345\n678", ["ES"]),
            ("01 23 45 67\n89", ["FR"]),
            ("312\n4567890", ["IT"]),
            ("512 345\n678", ["PL"]),
            ("(415)\n555-0132", ["US"]),
            ("415 555\n0132", ["US"]),
        ):
            ents = detect_regex_pii(text, enabled_regions=regions)
            self.assertEqual(
                [e["text"] for e in ents if e["category"] == "PhoneNumber"],
                [],
                text,
            )


class PhoneSpanRepairTests(unittest.TestCase):
    """BFSF-296: a model span clipped at a separator gets its digits back."""

    def _repaired(self, text, span):
        out = _postprocess_entities(text, [_model_span(text, span, "PhoneNumber")])
        return [e["text"] for e in out]

    def test_a_lost_country_code_comes_back(self):
        text = "Bel +31 (0)6 4827 3951 vandaag"
        self.assertEqual(self._repaired(text, "(0)6 4827 3951"), ["+31 (0)6 4827 3951"])
        text = "Bel +31 6 4827 3951 vandaag"
        self.assertEqual(self._repaired(text, "6 4827 3951"), ["+31 6 4827 3951"])

    def test_a_lost_area_code_comes_back(self):
        for text, span, whole in (
            ("Bel 06 / 4827 3951 vandaag", "4827 3951", "06 / 4827 3951"),
            ("Bel (078) 482 73 95 vandaag", "482 73 95", "(078) 482 73 95"),
            ("Bel 013/4827395 vandaag", "4827395", "013/4827395"),
        ):
            self.assertEqual(self._repaired(text, span), [whole], text)

    def test_a_lost_last_group_comes_back(self):
        text = "Vast: 038 482 73 95, mobiel onbekend"
        self.assertEqual(self._repaired(text, "038 482 73"), ["038 482 73 95"])

    def test_the_repair_never_crosses_a_line_or_cell(self):
        self.assertEqual(
            self._repaired("06 / 4827 3951\n17\n", "4827 3951\n17"),
            ["06 / 4827 3951"],
        )
        self.assertEqual(self._repaired("038 482 73\n95", "038 482 73"), ["038 482 73"])
        self.assertEqual(self._repaired("06\t4827 3951", "4827 3951"), ["4827 3951"])

    def test_a_whole_number_does_not_take_its_neighbours(self):
        for text, span in (
            ("Bel 06 48273951 17 keer", "06 48273951"),
            ("Klant 0123 0648273951 belt", "0648273951"),
            ("Bel 038 482 73 12:30", "038 482 73"),
            ("Bel 038 482 73 12,50", "038 482 73"),
        ):
            self.assertEqual(self._repaired(text, span), [span], text)


class AddressGrowthTests(unittest.TestCase):
    """BFSF-294: the postcode and town after an address belong to it."""

    def _grown(self, text, span="Vlierstraat 4", category="Address"):
        out = _postprocess_entities(text, [_model_span(text, span, category)])
        return [e["text"] for e in out]

    def test_the_town_after_in_or_te_is_part_of_the_address(self):
        for text, whole in (
            ("Hij woont op de Vlierstraat 4 in Houtdorp.", "Vlierstraat 4 in Houtdorp"),
            (
                "Zij woont aan de Vlierstraat 4 te Houtdorp.",
                "Vlierstraat 4 te Houtdorp",
            ),
            ("Bezorgen op Vlierstraat 4 Houtdorp graag", "Vlierstraat 4 Houtdorp"),
            ("Vlierstraat 4, Houtdorp", "Vlierstraat 4, Houtdorp"),
        ):
            self.assertEqual(self._grown(text), [whole], text)

    def test_the_postcode_and_town_after_it_are_part_of_the_address(self):
        for text, whole in (
            (
                "Adres: Vlierstraat 4, 4321 ZX Houtdorp.",
                "Vlierstraat 4, 4321 ZX Houtdorp",
            ),
            ("Adres: Vlierstraat 4, 4321ZX Houtdorp", "Vlierstraat 4, 4321ZX Houtdorp"),
            (
                "Adres: Vlierstraat 4 4321 ZX, Houtdorp",
                "Vlierstraat 4 4321 ZX, Houtdorp",
            ),
            ("Adres: Vlierstraat 4, 4321 ZX.", "Vlierstraat 4, 4321 ZX"),
            ("Adres: Vlierstraat 4, 1234 Houtdorp", "Vlierstraat 4, 1234 Houtdorp"),
        ):
            self.assertEqual(self._grown(text), [whole], text)
        text = "Address: Elm Road 4, M1 1AA Houtdorp"
        self.assertEqual(
            self._grown(text, "Elm Road 4"), ["Elm Road 4, M1 1AA Houtdorp"]
        )

    def test_town_names_of_several_words(self):
        for town in (
            "Zandwijk aan den Stroom",
            "Mosveld op Zee",
            "'s-Hoevedorp",
            "Nieuw-Veldmere",
            "Den Houtdorp",
            "IJsselveld",
        ):
            text = f"Zij woont op Vlierstraat 4 te {town}. Verder niets."
            self.assertEqual(self._grown(text), [f"Vlierstraat 4 te {town}"], town)

    def test_what_follows_that_is_no_town_stays_out(self):
        for text in (
            "Bezorgd op Vlierstraat 4 in de middag.",
            "Bezorgd op Vlierstraat 4 in het weekend.",
            "Delivered to Vlierstraat 4 in January.",
            "Bezorgd op Vlierstraat 4 en daarna verder.",
            "Bezorgd op Vlierstraat 4 om 12:00.",
        ):
            self.assertEqual(self._grown(text), ["Vlierstraat 4"], text)
        text = "Vlierstraat 4, 4321 ZX Houtdorp Tel 06 4827 3951"
        self.assertEqual(self._grown(text), ["Vlierstraat 4, 4321 ZX Houtdorp"])

    def test_growth_never_crosses_a_line_or_cell(self):
        for text in (
            "Vlierstraat 4\n4321 ZX\nHoutdorp",
            "Vlierstraat 4\t4321 ZX\tHoutdorp",
            "| Vlierstraat 4 | 4321 ZX | Houtdorp |",
        ):
            self.assertEqual(self._grown(text), ["Vlierstraat 4"], repr(text))

    def test_growth_is_capped(self):
        text = "Vlierstraat 4 Aaaaaaaaaa Bbbbbbbbbb Cccccccccc Dddddddddd"
        self.assertEqual(self._grown(text), ["Vlierstraat 4"])

    def test_only_an_address_grows(self):
        # A postcode is not a standalone identifier: nothing makes one an
        # Address, and a name before a town does not become an address.
        text = "Neem contact op met Lotte in Houtdorp, 4321 ZX."
        self.assertEqual(self._grown(text, "Lotte", "Person"), ["Lotte"])
        found = detect_regex_pii("Postcode 4321 ZX Houtdorp")
        self.assertNotIn("Address", {e["category"] for e in found})

    def test_detect_redacts_the_town_with_the_street(self):
        svc = get_pii_service()
        svc._model = FakeGliner(["Vlierstraat 4"], label="address")
        svc._ready = True
        svc._load_error = None
        text = "Hij woont op de Vlierstraat 4 in Houtdorp."
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Address"]
        )
        self.assertEqual(
            [e["text"] for e in result["entities"]], ["Vlierstraat 4 in Houtdorp"]
        )


class DisplayNameCellTests(unittest.TestCase):
    """BFSF-300: a "Surname, First name" cell of a person found elsewhere.

    A contact table carries each person split over name columns (found by
    the model) and once more as "Surname, First name" (often not found).
    """

    def _persons(self, text, spans):
        ents = [_model_span(text, s, "Person") for s in spans]
        # _model_span finds the first occurrence; the split cells come later.
        for ent, span in zip(ents, spans):
            ent["offset"] = text.rindex(span)
        out = _postprocess_entities(text, ents)
        return sorted(e["text"] for e in out if e["category"] == "Person")

    def test_the_display_cell_of_a_found_person_is_a_person(self):
        for sep in ("\n", "\t", " | "):
            text = sep.join(["1", "Wolters, Fenna", "Fenna", "", "Wolters", "Houtdorp"])
            self.assertEqual(
                self._persons(text, ["Fenna", "Wolters"]),
                ["Fenna", "Wolters", "Wolters, Fenna"],
                repr(sep),
            )

    def test_particles_and_initials(self):
        for display, first, last in (
            ("Van Driel, Lotte", "Lotte", "Driel"),
            ("Driel, Lotte van", "Lotte", "Driel"),
            ("van 't Veld, Joost", "Joost", "Veld"),
            ("Wolters, F.", "Fenna", "Wolters"),
            ("Wolters, F.J.", "Fenna", "Wolters"),
            ("Wolters, Fenna J.", "Fenna", "Wolters"),
            ("El Idrissi, Samira", "Samira", "Idrissi"),
            ("Öztürk-Brink, Joost", "Joost", "Öztürk-Brink"),
        ):
            text = f"{display}\t{first}\t{last}\n"
            self.assertIn(display, self._persons(text, [first, last]), display)

    def test_a_partly_found_display_cell_becomes_whole(self):
        text = "Contactpersoon\nWolters, Fenna\n"
        ents = _postprocess_entities(text, [_model_span(text, "Wolters", "Person")])
        resolved = PiiService._finalise(ents, text=text)["entities"]
        self.assertEqual([e["text"] for e in resolved], ["Wolters, Fenna"])

    def test_a_greeting_or_sign_off_is_no_display_name(self):
        # The same shape, but the found name is the one after the comma. As a
        # Person span "Groeten, Joost" would become the value that Joost's
        # token restores to, in every reply.
        for text in (
            "Hoi Lotte,\n\nKun je morgen bellen?\n\nGroeten, Joost",
            "Thanks for the update.\n\nCheers, Joost\n",
            "Hallo, Joost\nIk bel je morgen.",
        ):
            self.assertEqual(self._persons(text, ["Joost"]), ["Joost"], text)

    def test_two_records_split_by_the_cell_break_stay_two_people(self):
        # The model paired record 1's first name with record 2's surname. The
        # split keeps them apart; record 2, whose surname is found, is redacted
        # whole. Record 1's surname was never found, so it is no evidence.
        text = "Wolters, Fenna\nBrink, Joost\n"
        ents = _postprocess_entities(
            text, [_model_span(text, "Fenna\nBrink", "Person")]
        )
        resolved = PiiService._finalise(ents, text=text)["entities"]
        self.assertEqual([e["text"] for e in resolved], ["Fenna", "Brink, Joost"])

    def test_the_shape_alone_is_not_enough(self):
        # No word of "Brink, Joost" was found as a person.
        text = "Wolters, Fenna\nBrink, Joost\nFenna Wolters"
        self.assertEqual(
            self._persons(text, ["Fenna Wolters"]), ["Fenna Wolters", "Wolters, Fenna"]
        )
        # A company and its town, next to a person with another name.
        text = "Brink Advies, Houtdorp\nFenna Wolters"
        self.assertEqual(self._persons(text, ["Fenna Wolters"]), ["Fenna Wolters"])

    def test_only_a_whole_cell_counts(self):
        text = "Gisteren belde Wolters, Fenna en Joost over de offerte.\nFenna"
        self.assertEqual(self._persons(text, ["Fenna"]), ["Fenna"])

    def test_a_particle_is_no_shared_word(self):
        text = "Brink, Joost van\nLotte van Driel"
        self.assertEqual(self._persons(text, ["Lotte van Driel"]), ["Lotte van Driel"])

    def test_a_display_cell_already_found_is_not_added_twice(self):
        text = "Wolters, Fenna\tFenna\tWolters\n"
        ents = [
            _model_span(text, "Wolters, Fenna", "Person"),
            {**_model_span(text, "Fenna", "Person"), "offset": text.rindex("Fenna")},
        ]
        out = _postprocess_entities(text, ents)
        self.assertEqual(
            _spans(out), [("Person", "Wolters, Fenna"), ("Person", "Fenna")]
        )

    def test_no_person_no_work(self):
        text = "Wolters, Fenna\n4321 ZX"
        out = _postprocess_entities(text, [_model_span(text, "4321 ZX", "Address")])
        self.assertEqual(_spans(out), [("Address", "4321 ZX")])

    def test_detect_redacts_the_display_cell(self):
        svc = _install_fake(["Fenna\tWolters"])
        text = "Wolters, Fenna\tFenna\tWolters\tHoutdorp\n"
        result = svc.detect(
            text, confidence_threshold=0.7, enabled_categories=["Person"]
        )
        self.assertEqual(sorted(_names(result)), ["Fenna", "Wolters", "Wolters, Fenna"])


if __name__ == "__main__":
    unittest.main()
