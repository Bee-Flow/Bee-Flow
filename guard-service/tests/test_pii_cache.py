"""The PII result cache holds no personal data and is keyed by an HMAC.

* An entry carries offsets, lengths, categories, labels and scores only; the
  span text is rebuilt from the request text on a hit, so a hit equals a miss.
* The key is an HMAC with GUARD_PII_CACHE_KEY_SECRET (else a per-process random
  secret), not a bare sha256 anyone can recompute from a guessed text.
* GUARD_PII_CACHE_TTL_SECONDS sets the lifetime; 0 turns the cache off.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import types
import unittest
from unittest.mock import patch

from app.services.pii import ScanRequest, cache as pii_cache
from app.services.pii.cache import (
    _cache_key,
    _from_cache_entry,
    _to_cache_entry,
    reset_cache_key_secret,
)
from fakes import FakeRedis
from test_pii_custom_labels import FINDS, LABELS, _ServiceCase

TEXT = (
    "Beste Mark, het project Falcon Ridge loopt. Mail mark@example.com, "
    "IBAN NL91ABNA0417164300, contract KL-12345."
)
SPANS = ("Mark", "mark@example.com", "NL91ABNA0417164300", "Falcon Ridge", "KL-12345")


class RecordingRedis(FakeRedis):
    def __init__(self):
        super().__init__()
        self.gets = 0
        self.ttls = []

    async def get(self, key):
        self.gets += 1
        return await super().get(key)

    async def set(self, key, value, ex=None):
        self.ttls.append(ex)
        await super().set(key, value, ex=ex)


def _stable(result):
    return {k: v for k, v in result.items() if k != "scan_stats"}


class _CacheCase(_ServiceCase):
    def setUp(self):
        super().setUp()
        self.redis = RecordingRedis()
        deps = types.ModuleType("app.dependencies")
        deps.get_redis = lambda: self.redis
        patcher = patch.dict(sys.modules, {"app.dependencies": deps})
        patcher.start()
        self.addCleanup(patcher.stop)
        reset_cache_key_secret()
        self.addCleanup(reset_cache_key_secret)

    def detect(self, text=TEXT, labels=LABELS):
        return asyncio.run(self.svc.detect_async(text, 0.7, None, None, labels))


class NoSpanTextInTheCacheTests(_CacheCase):
    def test_the_stored_entry_holds_no_span_text(self):
        self.install(prompts=FINDS)
        result = self.detect()
        found = {e["text"] for e in result["entities"] + result["custom_entities"]}
        self.assertTrue(
            {"Mark", "Falcon Ridge", "KL-12345"} <= found,
            "the fixture must actually find PII, or this test proves nothing",
        )
        self.assertEqual(len(self.redis.store), 1)
        (raw,) = self.redis.store.values()
        for span in SPANS:
            self.assertNotIn(span, raw)
        stored = json.loads(raw)
        for list_key in ("entities", "custom_entities"):
            for ent in stored[list_key]:
                self.assertNotIn("text", ent)
                self.assertLessEqual(set(ent), set(pii_cache._CACHED_ENTITY_FIELDS))

    def test_a_hit_rebuilds_the_text_and_equals_the_miss(self):
        self.install(prompts=FINDS)
        miss = self.detect()
        hit = self.detect()
        self.assertEqual(miss["scan_stats"]["cache"], "miss")
        self.assertEqual(hit["scan_stats"]["cache"], "hit")
        self.assertEqual(_stable(hit), _stable(miss))
        for ent in hit["entities"] + hit["custom_entities"]:
            self.assertEqual(
                ent["text"], TEXT[ent["offset"] : ent["offset"] + ent["length"]]
            )

    def test_a_cached_span_outside_the_text_is_a_miss_not_a_hit(self):
        self.install(prompts=FINDS)
        self.detect()
        (key,) = self.redis.store
        entry = json.loads(self.redis.store[key])
        entry["entities"][0]["offset"] = len(TEXT) + 5
        self.redis.store[key] = json.dumps(entry)
        again = self.detect()
        self.assertNotEqual(again["scan_stats"]["cache"], "hit")
        self.assertIn("Mark", {e["text"] for e in again["entities"]})

    def test_the_entry_is_built_from_an_allow_list(self):
        result = {
            "hasPii": True,
            "entities": [
                {
                    "text": "Mark",
                    "category": "Person",
                    "label": "person",
                    "confidence": 0.9,
                    "offset": 6,
                    "length": 4,
                    "source": "model",
                    "raw_match": "Mark",  # a field nobody has added yet
                }
            ],
            "degraded": False,
            "degraded_reason": None,
            "debug_input": TEXT,  # an envelope field nobody has added yet
        }
        entry = _to_cache_entry(result)
        self.assertNotIn("Mark", json.dumps(entry))
        self.assertNotIn("debug_input", entry)
        rebuilt = _from_cache_entry(entry, TEXT)
        self.assertEqual(rebuilt["entities"][0]["text"], "Mark")


class HmacKeyTests(_CacheCase):
    def _req(self, text=TEXT):
        return ScanRequest(text, 0.7, None, None, None, None)

    def test_the_key_is_not_a_bare_sha256_of_the_inputs(self):
        key = _cache_key(self._req())
        self.assertTrue(
            key.startswith(f"guard:pii:v{pii_cache._CACHE_SCHEMA_VERSION}:")
        )
        self.assertGreaterEqual(pii_cache._CACHE_SCHEMA_VERSION, 6)
        digest = key.rsplit(":", 1)[1]
        # The v5 derivation: sha256 over the same payload, no secret.
        with patch.object(pii_cache, "_cache_key_secret", return_value=b""):
            unsalted = _cache_key(self._req()).rsplit(":", 1)[1]
        self.assertNotEqual(digest, unsalted)
        self.assertNotEqual(digest, hashlib.sha256(TEXT.encode()).hexdigest())

    def test_the_per_process_secret_is_stable_until_reset(self):
        with patch.object(self.settings, "pii_cache_key_secret", ""):
            first = _cache_key(self._req())
            self.assertEqual(first, _cache_key(self._req()))
            reset_cache_key_secret()
            self.assertNotEqual(first, _cache_key(self._req()))

    def test_a_configured_secret_is_shared_and_decides_the_key(self):
        with patch.object(self.settings, "pii_cache_key_secret", "replica-shared"):
            a = _cache_key(self._req())
            reset_cache_key_secret()
            self.assertEqual(a, _cache_key(self._req()), "replicas share entries")
        with patch.object(self.settings, "pii_cache_key_secret", "another"):
            self.assertNotEqual(a, _cache_key(self._req()))


class TtlTests(_CacheCase):
    def test_the_ttl_comes_from_the_setting(self):
        self.install(prompts=FINDS)
        with patch.object(self.settings, "pii_cache_ttl_seconds", 42):
            self.detect()
        self.assertEqual(self.redis.ttls, [42])

    def test_the_default_ttl_is_ten_minutes(self):
        from app.config import Settings

        self.assertEqual(Settings().pii_cache_ttl_seconds, 600)

    def test_zero_turns_the_cache_off(self):
        self.install(prompts=FINDS)
        with patch.object(self.settings, "pii_cache_ttl_seconds", 0):
            first = self.detect()
            second = self.detect()
        self.assertEqual(self.redis.store, {})
        self.assertEqual(self.redis.gets, 0)
        self.assertEqual(first["scan_stats"]["cache"], "bypass")
        self.assertEqual(second["scan_stats"]["cache"], "bypass")


if __name__ == "__main__":
    unittest.main()
