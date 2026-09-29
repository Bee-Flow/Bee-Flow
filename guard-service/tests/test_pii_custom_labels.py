"""Custom labels (organisation-defined data types) and POST /pii/probe.

The contract these pin, in order of how badly it would hurt to lose it:

  * built-in ``entities`` are BYTE-IDENTICAL with or without custom labels —
    the Node side merges the two lists itself, and a built-in result that
    moved when an org added a type would silently change every other org's
    redaction of the same text through the shared cache;
  * no request may write to a process-wide table (label map, floors,
    groupings, ranking) and no log line may carry a prompt;
  * a custom label group that fails degrades exactly its own ids;
  * the custom group's chunks leave room for its (wider) prompt;
  * the cache key and engine fingerprint change with the labels, and do not
    change at all without them.

Model-free, like test_pii.py: FakeGliner answers a ``{id: prompt}`` mapping
with the mapping's KEYS, which is what gliner 0.2.29 does (verified against
the shipped ONNX graph; see eval/MODEL-DECISIONS.md).
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
import types
import unittest
from unittest.mock import patch

import app.services.pii as pii
from app.services.pii import (
    ProbeUnavailable,
    ScanRequest,
    _CustomSpec,
    _finalise_custom,
    custom_label_digest,
    engine_fingerprint_digest,
    get_pii_service,
)
from app.services.pii.cache import _cache_key

try:  # `python -m unittest discover -s tests` imports test modules top-level
    from test_pii import FakeGliner, FakeTokenizer
except ImportError:  # pragma: no cover - pytest imports them as a package
    from tests.test_pii import FakeGliner, FakeTokenizer

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers.pii import _engine_fp
    from app.routers.pii import router as _pii_router

    _HTTP_IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    FastAPI = TestClient = _pii_router = _engine_fp = None  # type: ignore[assignment]
    _HTTP_IMPORT_ERROR = _exc


ID_A = "cdt_0a1b2c3d4e"
ID_B = "cdt_ffeeddccbb"
PROMPT_A = "internal project code name"
PROMPT_B = "customer contract number"
LABELS = [
    # Deliberately NOT in id order: the service canonicalises.
    {"id": ID_B, "prompt": PROMPT_B, "floor": 0.6},
    {"id": ID_A, "prompt": PROMPT_A, "floor": 0.5},
]
FINDS = {PROMPT_A: [("Falcon Ridge", 0.8)], PROMPT_B: [("KL-12345", 0.7)]}

FIXTURES = [
    "Beste Mark, het project Falcon Ridge loopt. Mail mark@example.com, "
    "IBAN NL91ABNA0417164300.",
    "Sanne en Mark bespreken contract KL-12345 voor Falcon Ridge.",
    "Geen namen hier, alleen Falcon Ridge en KL-12345.",
    # Long enough for several chunks, with names and codes across them.
    ("Dit is een lange zin over de zaak van de familie. " * 40)
    + "Aan het eind staan Sanne, Falcon Ridge en KL-12345.",
]


def _stable(result):
    """A result without scan_stats, whose timings differ run to run."""
    return {k: v for k, v in result.items() if k != "scan_stats"}


def _spans(result, key="custom_entities"):
    return [(e["offset"], e["length"], e["category"], e["text"]) for e in result[key]]


class _ServiceCase(unittest.TestCase):
    """Snapshot and restore every singleton field these tests touch."""

    _FIELDS = (
        "_model",
        "_ready",
        "_load_error",
        "_backend",
        "_tokenizer",
        "_text_token_budget",
        "_overlap_tokens",
        "_label_prompt_tokens_max",
        "_lock_mode",
        "_predict_workers",
        "_predict_pool",
    )

    def setUp(self):
        from app.config import settings

        self.svc = get_pii_service()
        saved = {f: getattr(self.svc, f) for f in self._FIELDS}
        saved_tier = settings.pii_regex_tier

        def restore():
            for name, value in saved.items():
                setattr(self.svc, name, value)
            settings.pii_regex_tier = saved_tier
            pii.reset_inference_semaphore()

        self.addCleanup(restore)
        self.settings = settings
        settings.pii_regex_tier = "on"
        self.svc._tokenizer = None
        self.svc._text_token_budget = None
        self.svc._overlap_tokens = None
        self.svc._label_prompt_tokens_max = None
        self.svc._lock_mode = "global"
        self.svc._predict_workers = 1
        self.svc._predict_pool = None
        pii.reset_inference_semaphore()

    def install(self, names=("Mark", "Sanne"), prompts=None, score=0.9, cls=None):
        model = (cls or FakeGliner)(list(names), score=score, prompts=prompts)
        self.svc._model = model
        self.svc._ready = True
        self.svc._load_error = None
        self.svc._backend = "fake"
        return model

    def scan(self, text, labels=None, threshold=0.7, categories=None, limit=None):
        custom = _CustomSpec.from_request(labels, threshold)
        return self.svc.detect_request(
            ScanRequest(text, threshold, categories, limit, None, custom)
        )


class BuiltInParityTests(_ServiceCase):
    """The first rule: custom labels never move a built-in result."""

    def test_entities_are_byte_identical_with_and_without_custom_labels(self):
        self.install(prompts=FINDS)
        for tier in ("on", "off"):
            self.settings.pii_regex_tier = tier
            for text in FIXTURES:
                for threshold in (0.3, 0.7, 0.95):
                    for categories in (None, ["Person"], ["Person", "Email"]):
                        with self.subTest(
                            tier=tier, text=text[:20], t=threshold, c=categories
                        ):
                            plain = self.scan(text, None, threshold, categories)
                            custom = self.scan(text, LABELS, threshold, categories)
                            self.assertEqual(
                                json.dumps(plain["entities"]),
                                json.dumps(custom["entities"]),
                            )
                            self.assertEqual(plain["hasPii"], custom["hasPii"])
                            self.assertNotIn("custom_entities", plain)

    def test_custom_spans_do_not_join_a_built_in_cluster(self):
        # "Mark" is both a Person and (here) a custom code name: the built-in
        # list still has it as a Person, the custom list as the custom id.
        self.install(prompts={PROMPT_A: [("Mark", 0.9)]})
        result = self.scan("Beste Mark, groet.", LABELS)
        self.assertEqual([e["category"] for e in result["entities"]], ["Person"])
        self.assertEqual(_spans(result), [(6, 4, ID_A, "Mark")])

    def test_detect_is_unchanged_and_carries_no_custom_key(self):
        self.install(prompts=FINDS)
        text = FIXTURES[1]
        self.assertEqual(
            _stable(self.svc.detect(text, 0.7, None)),
            _stable(self.scan(text, None, 0.7, None)),
        )


class CustomEntityTests(_ServiceCase):
    def test_custom_entities_carry_the_id_and_their_own_source(self):
        self.install(prompts=FINDS)
        result = self.scan(FIXTURES[1], LABELS)
        self.assertEqual(
            _spans(result),
            [(33, 8, ID_B, "KL-12345"), (47, 12, ID_A, "Falcon Ridge")],
        )
        for ent in result["custom_entities"]:
            self.assertEqual(ent["label"], ent["category"])
            self.assertEqual(ent["source"], "model_custom")

    def test_no_shape_filter_validator_or_noise_filter_applies(self):
        # "KWP" dies in _precision_filter as an SSN, "Het" in the Person noise
        # filter; an admin-defined kind of data has neither rule.
        self.install(prompts={PROMPT_A: [("KWP", 0.9), ("Het", 0.9)]})
        result = self.scan("Het team KWP werkt door.", LABELS)
        self.assertEqual([e["text"] for e in result["custom_entities"]], ["Het", "KWP"])

    def test_word_edge_repair_applies(self):
        self.install(prompts={PROMPT_A: [("alcon Ridge", 0.9)]})
        result = self.scan("Project Falcon Ridge, groet.", LABELS)
        self.assertEqual(_spans(result), [(8, 12, ID_A, "Falcon Ridge")])

    def test_label_order_is_canonical(self):
        model = self.install(prompts=FINDS)
        one = self.scan(FIXTURES[1], LABELS)
        two = self.scan(FIXTURES[1], list(reversed(LABELS)))
        self.assertEqual(_stable(one), _stable(two))
        mappings = [
            labels for _texts, labels in model.calls if isinstance(labels, dict)
        ]
        self.assertTrue(mappings)
        for mapping in mappings:
            self.assertEqual(list(mapping), [ID_A, ID_B])

    def test_skippable_text_still_answers_the_custom_list(self):
        self.install(prompts=FINDS)
        result = self.scan("[person_1]", LABELS)
        self.assertEqual(result["custom_entities"], [])
        self.assertFalse(result["degraded"])


class CustomFloorTests(_ServiceCase):
    """A custom floor is the floor AT the slider anchor, shifted like a
    built-in category's (detection._acceptance_floor)."""

    def _found(self, score, floor, slider):
        self.install(prompts={PROMPT_A: [("Falcon Ridge", score)]})
        labels = [{"id": ID_A, "prompt": PROMPT_A, "floor": floor}]
        return bool(
            self.scan("Project Falcon Ridge.", labels, slider)["custom_entities"]
        )

    def test_the_floor_follows_the_slider(self):
        self.assertFalse(self._found(0.45, 0.5, 0.7))  # floor 0.50
        self.assertTrue(self._found(0.45, 0.5, 0.6))  # floor 0.40
        self.assertTrue(self._found(0.55, 0.5, 0.7))  # floor 0.50
        self.assertFalse(self._found(0.55, 0.5, 0.8))  # floor 0.60

    def test_the_shift_is_clamped(self):
        low = _CustomSpec.from_request(
            [{"id": ID_A, "prompt": "p q", "floor": 0.1}], 0.1
        )
        high = _CustomSpec.from_request(
            [{"id": ID_A, "prompt": "p q", "floor": 0.99}], 1.0
        )
        self.assertEqual(low.floor_for(ID_A), 0.10)
        self.assertEqual(high.floor_for(ID_A), 0.99)

    def test_each_label_keeps_its_own_floor(self):
        self.install(prompts={PROMPT_A: [("Falcon", 0.55)], PROMPT_B: [("KL-1", 0.55)]})
        result = self.scan("Falcon en KL-1.", LABELS)  # A floor 0.5, B floor 0.6
        self.assertEqual([e["category"] for e in result["custom_entities"]], [ID_A])


class ScopeTests(_ServiceCase):
    """enabled_categories=[] beside custom labels means "no built-ins"."""

    TEXT = "Beste Mark, mail mark@example.com over Falcon Ridge."

    def test_empty_categories_with_custom_labels_scan_no_built_ins(self):
        model = self.install(prompts=FINDS)
        result = self.scan(self.TEXT, LABELS, categories=[])
        self.assertEqual(result["entities"], [])
        self.assertEqual(_spans(result), [(39, 12, ID_A, "Falcon Ridge")])
        # Only the custom group was asked; no shipped group ran.
        self.assertTrue(model.calls)
        self.assertTrue(all(isinstance(labels, dict) for _t, labels in model.calls))

    def test_empty_categories_without_custom_labels_still_mean_all(self):
        self.install(prompts=FINDS)
        everything = self.scan(self.TEXT, None, categories=None)["entities"]
        self.assertTrue({"Person", "Email"} <= {e["category"] for e in everything})
        self.assertEqual(
            self.scan(self.TEXT, None, categories=[])["entities"], everything
        )
        # An EMPTY custom list is no custom list.
        empty_custom = self.scan(self.TEXT, [], categories=[])
        self.assertEqual(empty_custom["entities"], everything)
        self.assertNotIn("custom_entities", empty_custom)

    def test_the_regex_fast_path_is_bypassed_for_custom_labels(self):
        # Email is regex-complete under tier=on: without custom labels the
        # model is never called at all.
        model = self.install(prompts=FINDS)
        plain = self.scan(self.TEXT, None, categories=["Email"])
        self.assertEqual(model.calls, [])
        custom = self.scan(self.TEXT, LABELS, categories=["Email"])
        self.assertEqual(plain["entities"], custom["entities"])
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(model.calls[0][1], {ID_A: PROMPT_A, ID_B: PROMPT_B})
        self.assertEqual(_spans(custom), [(39, 12, ID_A, "Falcon Ridge")])


class _MappingFails(FakeGliner):
    """Raises on the custom group only, quoting the prompt in the message."""

    def inference(self, texts, labels, threshold=0.0, **kwargs):
        if isinstance(labels, dict):
            raise RuntimeError(f"cannot score {sorted(labels.values())}")
        return super().inference(texts, labels, threshold, **kwargs)


class DegradationTests(_ServiceCase):
    def test_a_failed_custom_group_degrades_only_its_ids(self):
        self.install(prompts=FINDS)
        plain = self.scan(FIXTURES[0], None)
        self.install(prompts=FINDS, cls=_MappingFails)
        with self.assertLogs("guard", level="ERROR"):
            failed = self.scan(FIXTURES[0], LABELS)
        self.assertTrue(failed["degraded"])
        self.assertEqual(failed["degraded_categories"], [ID_A, ID_B])
        self.assertEqual(
            failed["degraded_reason"], f"gliner_group_failed:{ID_A},{ID_B}"
        )
        self.assertEqual(failed["custom_entities"], [])
        self.assertEqual(json.dumps(plain["entities"]), json.dumps(failed["entities"]))

    def test_a_custom_only_request_whose_group_fails_is_fully_degraded(self):
        self.install(prompts=FINDS, cls=_MappingFails)
        with self.assertLogs("guard", level="ERROR"):
            result = self.scan(FIXTURES[0], LABELS, categories=[])
        self.assertEqual(result["degraded_reason"], "gliner_predict_failed")
        self.assertEqual(result["degraded_categories"], [ID_A, ID_B])

    def test_model_not_ready_lists_what_lost_coverage(self):
        svc = self.svc
        svc._model, svc._ready, svc._load_error = None, False, "OSError: nope"
        with self.assertLogs("guard", level="WARNING"):
            result = self.scan(
                "mail me at a@b.com please", LABELS, categories=["Email"]
            )
        self.assertTrue(result["degraded"])
        self.assertIn("model_not_ready", result["degraded_reason"])
        # Email is regex-complete under tier=on and was covered; only the
        # custom ids depended on the model.
        self.assertEqual(result["degraded_categories"], [ID_A, ID_B])
        self.assertEqual(result["custom_entities"], [])
        self.assertTrue(any(e["category"] == "Email" for e in result["entities"]))

    def test_model_not_ready_without_custom_labels_is_unchanged(self):
        svc = self.svc
        svc._model, svc._ready, svc._load_error = None, False, "OSError: nope"
        with self.assertLogs("guard", level="WARNING"):
            result = self.scan("Beste Mark en Sanne", None, categories=["Person"])
        self.assertTrue(result["degraded"])
        self.assertNotIn("degraded_categories", result)


class ChunkBudgetTests(_ServiceCase):
    """GLiNER prepends the label prompt to every chunk: a custom group wider
    than the widest shipped group needs smaller chunks, or its tail is cut."""

    WIDE = [
        {
            "id": f"cdt_{i:010x}",
            "prompt": f"name number {i} of a very confidential internal thing",
            "floor": 0.5,
        }
        for i in range(6)
    ]

    def _tokens(self):
        self.svc._tokenizer = FakeTokenizer()
        self.svc._text_token_budget = 120
        self.svc._overlap_tokens = 20

    def _chunks(self, model, custom: bool):
        return [
            text
            for texts, labels in model.calls
            if isinstance(labels, dict) == custom
            for text in texts
        ]

    def test_a_wide_custom_group_gets_its_own_smaller_chunks(self):
        self._tokens()
        text = " ".join(f"woord{i}" for i in range(600)) + " Falcon Ridge."
        model = self.install(prompts={self.WIDE[0]["prompt"]: [("Falcon Ridge", 0.9)]})
        result = self.scan(text, self.WIDE, categories=["Person"])

        shipped_width = max(
            pii._label_prompt_width(FakeTokenizer(), g) for g in pii.label_groups()
        )
        custom_width = pii._label_prompt_width(
            FakeTokenizer(), [lbl["prompt"] for lbl in self.WIDE]
        )
        self.assertGreater(custom_width, shipped_width)
        custom_chunks = self._chunks(model, True)
        shipped_chunks = self._chunks(model, False)
        self.assertGreater(len(custom_chunks), len(shipped_chunks))
        for chunk in custom_chunks:
            # Prompt plus text never needs more room than the shipped chunks got.
            self.assertLessEqual(
                len(chunk.split()) + custom_width, 120 + shipped_width, chunk[:30]
            )
        # And coverage holds: the code name at the very end is found.
        self.assertEqual(
            [e["text"] for e in result["custom_entities"]], ["Falcon Ridge"]
        )
        self.assertEqual(result["scan_stats"]["custom_chunks"], len(custom_chunks))

    def test_a_narrow_custom_group_shares_the_shipped_chunks(self):
        self._tokens()
        text = " ".join(f"woord{i}" for i in range(600))
        model = self.install(prompts=FINDS)
        self.scan(text, LABELS, categories=["Person"])
        self.assertEqual(self._chunks(model, True), self._chunks(model, False))

    def test_the_width_measured_at_load_is_used(self):
        self._tokens()
        self.svc._label_prompt_tokens_max = 10_000  # nothing is wider
        text = " ".join(f"woord{i}" for i in range(600))
        model = self.install(prompts=FINDS)
        self.scan(text, self.WIDE, categories=["Person"])
        self.assertEqual(self._chunks(model, True), self._chunks(model, False))

    def test_without_a_tokenizer_the_custom_fallback_is_narrower(self):
        text = "Dit is een lange zin over de zaak van de familie. " * 40
        model = self.install(prompts=FINDS)
        self.scan(text, LABELS, categories=["Person"])
        custom_chunks = self._chunks(model, True)
        self.assertTrue(
            all(len(c) <= pii._CUSTOM_CHUNK_CHAR_LIMIT for c in custom_chunks)
        )
        self.assertTrue(
            any(
                len(c) > pii._CUSTOM_CHUNK_CHAR_LIMIT
                for c in self._chunks(model, False)
            )
        )

    def test_an_unmeasurable_prompt_falls_back_to_char_chunks(self):
        class Flaky(FakeTokenizer):
            def __call__(
                self, text, add_special_tokens=False, return_offsets_mapping=False
            ):
                if not return_offsets_mapping:
                    raise RuntimeError("Already borrowed")
                return super().__call__(
                    text, add_special_tokens, return_offsets_mapping
                )

        self.svc._tokenizer = Flaky()
        self.svc._text_token_budget = 120
        self.svc._overlap_tokens = 20
        model = self.install(prompts=FINDS)
        text = "Dit is een lange zin over de zaak van de familie. " * 40
        with self.assertLogs("guard", level="ERROR") as logs:
            self.scan(text, LABELS, categories=["Person"])
        self.assertTrue(
            all(
                len(c) <= pii._CUSTOM_CHUNK_CHAR_LIMIT
                for c in self._chunks(model, True)
            )
        )
        self.assertNotIn(PROMPT_A, "\n".join(logs.output))


class PartialScanTests(_ServiceCase):
    def test_the_scan_limit_applies_to_the_custom_chunks(self):
        early = "Project Falcon Ridge, "
        filler = "Dit is filler tekst zonder namen. " * 80
        text = early + filler + " En hier staat Falcon Ridge nogmaals."
        limit = len(early) + 500
        for categories in (["Person"], []):
            with self.subTest(categories=categories):
                model = self.install(prompts=FINDS)
                result = self.scan(text, LABELS, categories=categories, limit=limit)
                self.assertTrue(result["degraded"])
                self.assertEqual(result["degraded_reason"], "input_too_large_partial")
                self.assertEqual(result["total_chars"], len(text))
                self.assertLess(result["processed_chars"], len(text))
                self.assertEqual(_spans(result), [(8, 12, ID_A, "Falcon Ridge")])
                custom_texts = [
                    t for ts, lbl in model.calls if isinstance(lbl, dict) for t in ts
                ]
                self.assertLessEqual(
                    sum(len(t) for t in custom_texts),
                    limit + 2 * pii._CUSTOM_CHUNK_CHAR_LIMIT,
                )


class FinaliseCustomTests(unittest.TestCase):
    TEXT = "x" * 64

    def _ent(self, offset, length, label, confidence):
        return {
            "text": "?",
            "category": label,
            "label": label,
            "confidence": confidence,
            "offset": offset,
            "length": length,
            "source": "model_custom",
        }

    def test_union_extent_and_margin_above_the_own_floor(self):
        spec = _CustomSpec.from_request(LABELS, 0.7)  # A 0.5, B 0.6
        out = _finalise_custom(
            [self._ent(0, 10, ID_A, 0.60), self._ent(5, 10, ID_B, 0.65)],
            self.TEXT,
            spec,
        )
        # A clears its floor by 0.10, B by 0.05: A names the union.
        self.assertEqual(
            [(e["offset"], e["length"], e["category"]) for e in out], [(0, 15, ID_A)]
        )
        self.assertEqual(out[0]["text"], self.TEXT[0:15])

    def test_an_exact_tie_goes_to_the_canonical_order(self):
        spec = _CustomSpec.from_request(
            [
                {"id": ID_B, "prompt": "b b", "floor": 0.5},
                {"id": ID_A, "prompt": "a a", "floor": 0.5},
            ],
            0.7,
        )
        out = _finalise_custom(
            [self._ent(3, 4, ID_B, 0.8), self._ent(3, 4, ID_A, 0.8)], self.TEXT, spec
        )
        self.assertEqual([e["category"] for e in out], [ID_A])

    def test_disjoint_spans_stay_apart_in_offset_order(self):
        spec = _CustomSpec.from_request(LABELS, 0.7)
        out = _finalise_custom(
            [
                self._ent(20, 3, ID_B, 0.9),
                self._ent(0, 3, ID_A, 0.9),
                self._ent(2, 4, ID_A, 0.7),
            ],
            self.TEXT,
            spec,
        )
        self.assertEqual([(e["offset"], e["length"]) for e in out], [(0, 6), (20, 3)])

    def test_nothing_in_nothing_out(self):
        self.assertEqual(
            _finalise_custom([], self.TEXT, _CustomSpec.from_request(LABELS, 0.7)), []
        )


class _FakeRedis:
    def __init__(self):
        self.store = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


class CacheAndFingerprintTests(_ServiceCase):
    def _key(self, labels, categories=None, text="Beste Mark, Falcon Ridge"):
        custom = _CustomSpec.from_request(labels, 0.7)
        return _cache_key(ScanRequest(text, 0.7, categories, None, None, custom))

    def test_the_key_changes_with_prompt_and_floor_only(self):
        base = self._key(LABELS)
        self.assertTrue(base.startswith("guard:pii:v5:"))
        self.assertEqual(base, self._key(list(reversed(LABELS))))
        self.assertNotEqual(base, self._key(None))
        other_prompt = [dict(LABELS[0], prompt="customer order number"), LABELS[1]]
        self.assertNotEqual(base, self._key(other_prompt))
        other_floor = [dict(LABELS[0], floor=0.61), LABELS[1]]
        self.assertNotEqual(base, self._key(other_floor))
        # Floors are keyed at 4 decimals, like the slider.
        self.assertEqual(base, self._key([dict(LABELS[0], floor=0.60001), LABELS[1]]))

    def test_empty_categories_key_apart_from_none_only_beside_custom_labels(self):
        self.assertEqual(self._key(None, []), self._key(None, None))
        self.assertNotEqual(self._key(LABELS, []), self._key(LABELS, None))

    def test_the_fingerprint_is_unchanged_without_custom_labels(self):
        plain = engine_fingerprint_digest(["NL"])
        self.assertIsNone(custom_label_digest(None))
        self.assertIsNone(custom_label_digest([]))
        self.assertEqual(plain, engine_fingerprint_digest(["NL"], None))
        self.assertEqual(
            plain, engine_fingerprint_digest(["NL"], custom_label_digest([]))
        )
        with_custom = engine_fingerprint_digest(["NL"], custom_label_digest(LABELS))
        self.assertNotEqual(plain, with_custom)
        self.assertEqual(
            with_custom,
            engine_fingerprint_digest(
                ["NL"], custom_label_digest(list(reversed(LABELS)))
            ),
        )
        changed = [dict(LABELS[0], floor=0.7), LABELS[1]]
        self.assertNotEqual(
            with_custom, engine_fingerprint_digest(["NL"], custom_label_digest(changed))
        )

    def test_a_cached_custom_answer_is_served_whole(self):
        self.install(prompts=FINDS)
        fake = _FakeRedis()
        deps = types.ModuleType("app.dependencies")
        deps.get_redis = lambda: fake
        with patch.dict(sys.modules, {"app.dependencies": deps}):
            first = asyncio.run(
                self.svc.detect_async(FIXTURES[1], 0.7, None, None, LABELS)
            )
            plain = asyncio.run(
                self.svc.detect_async(FIXTURES[1], 0.7, None, None, None)
            )
            second = asyncio.run(
                self.svc.detect_async(FIXTURES[1], 0.7, None, None, LABELS)
            )
        self.assertEqual(len(fake.store), 2, "custom and plain answers must key apart")
        self.assertEqual(first["scan_stats"]["cache"], "miss")
        self.assertEqual(second["scan_stats"]["cache"], "hit")
        self.assertEqual(first["custom_entities"], second["custom_entities"])
        self.assertNotIn("custom_entities", plain)
        self.assertEqual(plain["entities"], second["entities"])

    def test_unscanned_input_still_answers_the_custom_list(self):
        self.install(prompts=FINDS)
        with patch.object(self.settings, "pii_hard_max_chars", 50):
            refused = asyncio.run(
                self.svc.detect_async("Beste Mark " * 20, 0.7, None, None, LABELS)
            )
        self.assertEqual(refused["degraded_reason"], "input_too_large")
        self.assertEqual(refused["custom_entities"], [])
        trivial = asyncio.run(self.svc.detect_async("ok", 0.7, None, None, LABELS))
        self.assertEqual(trivial["custom_entities"], [])
        plain = asyncio.run(self.svc.detect_async("ok", 0.7, None, None, None))
        self.assertNotIn("custom_entities", plain)


def _global_tables():
    """Every process-wide table a custom label could be tempted to extend."""
    from app.services.pii.fingerprint import _engine_fingerprint

    return copy.deepcopy(
        (
            dict(pii.GLINER_LABELS_TO_CATEGORY),
            dict(pii.CATEGORY_LABELS),
            dict(pii._PER_CATEGORY_THRESHOLD),
            [list(g) for g in pii.label_groups()],
            [list(g) for g in pii._LABEL_GROUPS],
            pii._CATEGORY_PRECEDENCE,
            dict(pii._SPECIFIC_OVER_GENERAL),
            pii._label_group_digest(),
            _engine_fingerprint(),
            engine_fingerprint_digest(),
            pii.ALL_CATEGORIES,
        )
    )


class ProbeTests(_ServiceCase):
    LABEL_SET = {ID_B: PROMPT_B, ID_A: PROMPT_A}

    def test_sub_floor_candidates_are_returned_with_their_scores(self):
        self.install(prompts={PROMPT_A: [("Falcon Ridge", 0.2)]})
        text = "Project Falcon Ridge loopt."
        # /pii at a 0.5 floor drops it ...
        self.assertEqual(self.scan(text, [LABELS[1]])["custom_entities"], [])
        # ... the probe reports it, so a floor can be fitted to it.
        self.assertEqual(
            self.svc.probe([text], self.LABEL_SET),
            [{"text_idx": 0, "label": ID_A, "start": 8, "end": 20, "score": 0.2}],
        )

    def test_repair_then_one_candidate_per_extent_at_its_best_score(self):
        self.install(prompts={PROMPT_A: [("alcon Ridge", 0.3), ("Falcon Ridge", 0.6)]})
        self.assertEqual(
            self.svc.probe(["Project Falcon Ridge."], self.LABEL_SET),
            [{"text_idx": 0, "label": ID_A, "start": 8, "end": 20, "score": 0.6}],
        )

    def test_every_text_is_indexed_and_blank_ones_are_skipped(self):
        model = self.install(prompts=FINDS)
        out = self.svc.probe(["KL-12345 hier", "   ", "Falcon Ridge"], self.LABEL_SET)
        self.assertEqual(
            [(c["text_idx"], c["label"], c["start"], c["end"]) for c in out],
            [(0, ID_B, 0, 8), (2, ID_A, 0, 12)],
        )
        self.assertEqual(len(model.calls), 2)
        # The same canonical label order production uses.
        self.assertTrue(all(list(labels) == [ID_A, ID_B] for _t, labels in model.calls))

    def test_the_probe_uses_the_custom_chunk_budget(self):
        self.svc._tokenizer = FakeTokenizer()
        self.svc._text_token_budget = 120
        self.svc._overlap_tokens = 20
        wide = {lbl["id"]: lbl["prompt"] for lbl in ChunkBudgetTests.WIDE}
        model = self.install(prompts={})
        self.svc.probe([" ".join(f"woord{i}" for i in range(400))], wide)
        custom_width = pii._label_prompt_width(FakeTokenizer(), list(wide.values()))
        shipped_width = max(
            pii._label_prompt_width(FakeTokenizer(), g) for g in pii.label_groups()
        )
        for texts, _labels in model.calls:
            for chunk in texts:
                self.assertLessEqual(
                    len(chunk.split()) + custom_width, 120 + shipped_width
                )

    def test_not_ready_and_failed_passes_are_unavailable(self):
        self.svc._model, self.svc._ready = None, False
        with self.assertRaises(ProbeUnavailable) as ctx:
            self.svc.probe(["x y z"], self.LABEL_SET)
        self.assertEqual(ctx.exception.reason, "model_not_ready")
        self.install(prompts=FINDS, cls=_MappingFails)
        with self.assertLogs("guard", level="ERROR"):
            with self.assertRaises(ProbeUnavailable) as ctx:
                self.svc.probe(["Falcon Ridge"], self.LABEL_SET)
        self.assertEqual(ctx.exception.reason, "inference_failed")

    def test_the_probe_queues_on_the_inference_gate(self):
        self.install(prompts=FINDS)
        with patch.object(self.settings, "pii_max_concurrency", 1):
            pii.reset_inference_semaphore()

            async def run():
                gate = pii._get_inference_semaphore()
                await gate.acquire()
                task = asyncio.create_task(
                    self.svc.probe_async(["Falcon Ridge"], self.LABEL_SET)
                )
                await asyncio.sleep(0.05)
                waited = not task.done()
                gate.release()
                return waited, await task

            waited, out = asyncio.run(run())
        self.assertTrue(waited, "the probe ran past a held inference gate")
        self.assertEqual([c["label"] for c in out], [ID_A])

    def test_no_request_writes_a_global_table(self):
        before = _global_tables()
        self.install(prompts=FINDS)
        self.scan(FIXTURES[0], LABELS)
        self.scan(FIXTURES[1], LABELS, categories=[])
        self.svc.probe(FIXTURES[:2], self.LABEL_SET)
        asyncio.run(self.svc.detect_async(FIXTURES[2], 0.7, None, None, LABELS))
        self.assertEqual(before, _global_tables())


@unittest.skipIf(
    _pii_router is None, f"fastapi/httpx unavailable: {_HTTP_IMPORT_ERROR}"
)
class HttpTests(_ServiceCase):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(_pii_router)
        self.client = TestClient(app)

    def _pii(self, **extra):
        body = {"text": FIXTURES[1], "confidence_threshold": 0.7, **extra}
        res = self.client.post("/pii", json=body)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def test_a_response_without_custom_labels_has_no_custom_key(self):
        self.install(prompts=FINDS)
        plain = self._pii()
        self.assertEqual(
            set(plain),
            {
                "hasPii",
                "entities",
                "degraded",
                "degraded_reason",
                "degraded_categories",
                "processed_chars",
                "total_chars",
                "tier_mode",
                "engine_fingerprint",
            },
        )
        self.assertEqual(self._pii(custom_labels=[]), plain)
        self.assertEqual(self._pii(custom_labels=None), plain)

    def test_custom_entities_on_the_wire(self):
        self.install(prompts=FINDS)
        plain = self._pii()
        custom = self._pii(custom_labels=LABELS)
        self.assertEqual(plain["entities"], custom["entities"])
        self.assertNotEqual(plain["engine_fingerprint"], custom["engine_fingerprint"])
        self.assertEqual(
            custom["custom_entities"],
            [
                {
                    "text": "KL-12345",
                    "category": ID_B,
                    "label": ID_B,
                    "confidence": 0.7,
                    "offset": 33,
                    "length": 8,
                    "source": "model_custom",
                },
                {
                    "text": "Falcon Ridge",
                    "category": ID_A,
                    "label": ID_A,
                    "confidence": 0.8,
                    "offset": 47,
                    "length": 12,
                    "source": "model_custom",
                },
            ],
        )
        self.assertEqual(plain["engine_fingerprint"], _engine_fp(None, None))

    def test_probe_on_the_wire(self):
        self.install(prompts={PROMPT_A: [("Falcon Ridge", 0.2)]})
        res = self.client.post(
            "/pii/probe",
            json={"texts": ["Project Falcon Ridge."], "label_set": {ID_A: PROMPT_A}},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(
            res.json(),
            {
                "candidates": [
                    {"text_idx": 0, "label": ID_A, "start": 8, "end": 20, "score": 0.2}
                ],
                "model_ready": True,
            },
        )

    def test_probe_is_503_without_a_model(self):
        self.svc._model, self.svc._ready = None, False
        res = self.client.post(
            "/pii/probe",
            json={"texts": ["Falcon Ridge"], "label_set": {ID_A: PROMPT_A}},
        )
        self.assertEqual(res.status_code, 503, res.text)
        self.assertEqual(res.json()["detail"], "model_not_ready")

    def test_probe_is_503_when_a_pass_fails(self):
        self.install(prompts=FINDS, cls=_MappingFails)
        res = self.client.post(
            "/pii/probe",
            json={"texts": ["Falcon Ridge"], "label_set": {ID_A: PROMPT_A}},
        )
        self.assertEqual(res.status_code, 503, res.text)
        self.assertEqual(res.json()["detail"], "inference_failed")

    def test_no_log_line_carries_a_prompt(self):
        self.install(prompts=FINDS)
        with self.assertLogs("guard", level="DEBUG") as logs:
            self._pii(custom_labels=LABELS)
            self.client.post(
                "/pii/probe",
                json={
                    "texts": [FIXTURES[1]],
                    "label_set": {ID_A: PROMPT_A, ID_B: PROMPT_B},
                },
            )
            self.install(prompts=FINDS, cls=_MappingFails)
            self._pii(custom_labels=LABELS)
            self.client.post(
                "/pii/probe",
                json={"texts": [FIXTURES[1]], "label_set": {ID_A: PROMPT_A}},
            )
            self.svc._model, self.svc._ready = None, False
            self._pii(custom_labels=LABELS)
        output = "\n".join(logs.output)
        # The capture works: the ids and counts are there ...
        self.assertIn(f"custom_by_id={{'{ID_A}': 1, '{ID_B}': 1}}", output)
        self.assertIn("custom_labels=2 custom_entities=2", output)
        self.assertIn("pii.probe", output)
        # ... and no prompt, in any line, from any path.
        for prompt in (PROMPT_A, PROMPT_B):
            self.assertNotIn(prompt, output)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
