"""Contract tests for the /pii request model (U9).

The request contract must be LOUD: a field this build does not know yields a
validation error / HTTP 422, never a silent drop. A dropped narrowing filter
(``enabled_categories``/``enabled_regions`` from a newer Node server) would
otherwise read as "scan everything" or "the caller's intent ignored" — the
skew is invisible until an audit. Wire-parity is pinned against the only Node
caller, server/core/privacy/piiDetection/guardClient.js:62-66.

The model-level tests run in the model-free CI job (which installs pydantic
but not FastAPI) because the wire models live in ``app.models``. The
HTTP-layer test additionally needs fastapi + httpx and skips cleanly where
they are absent (guard CI, a bare checkout)::

    python -m unittest discover -s tests        # model layer
    pytest tests/                               # full, in the container
"""

from __future__ import annotations

import unittest

try:
    from pydantic import ValidationError

    from app.models import PiiRequest, ProbeRequest

    _IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    ValidationError = PiiRequest = ProbeRequest = None  # type: ignore[assignment]
    _IMPORT_ERROR = _exc

# The HTTP layer needs fastapi (router import) and httpx (TestClient).
try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers.pii import router as _pii_router

    _HTTP_IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    FastAPI = TestClient = _pii_router = None  # type: ignore[assignment]
    _HTTP_IMPORT_ERROR = _exc


# Exactly what guardClient.js:62-66 puts on the wire today. If this test
# starts failing, the server contract moved and the model must follow —
# never the other way around silently.
GUARDCLIENT_PAYLOAD = {
    "text": "Contact julia@example.com",
    "confidence_threshold": 0.7,
    "enabled_categories": None,
}

# What guardClient.js adds for a guard reporting version >= 2.3.0: the
# organisation's `ai` custom data types, as pinned in the "Your own data"
# contract (id `cdt_` + 10 hex, prompt 2..60, floor 0.10..0.99, <= 6).
CUSTOM_LABELS_PAYLOAD = {
    **GUARDCLIENT_PAYLOAD,
    "enabled_categories": [],
    "custom_labels": [
        {"id": "cdt_0123456789", "prompt": "internal project code name", "floor": 0.5},
        {"id": "cdt_abcdef0123", "prompt": "customer contract number", "floor": 0.95},
    ],
}

PROBE_PAYLOAD = {
    "texts": ["Het project Falcon Ridge loopt tot maart."],
    "label_set": {"cdt_0123456789": "internal project code name"},
}


def _label(i: int, **over) -> dict:
    return {
        "id": f"cdt_{i:010x}",
        "prompt": f"custom kind of data {i}",
        "floor": 0.5,
        **over,
    }


@unittest.skipIf(PiiRequest is None, f"pydantic unavailable: {_IMPORT_ERROR}")
class PiiRequestContractTests(unittest.TestCase):
    """extra="forbid" semantics + parity with the Node caller."""

    def _assert_extra_forbidden(self, exc: ValidationError, field: str) -> None:
        errors = exc.errors()
        self.assertTrue(
            any(e.get("type") == "extra_forbidden" for e in errors),
            f"expected extra_forbidden in {errors!r}",
        )
        self.assertTrue(
            any(field in (e.get("loc") or ()) for e in errors),
            f"expected loc to name {field!r} in {errors!r}",
        )

    def test_guardclient_payload_is_accepted(self):
        req = PiiRequest(**GUARDCLIENT_PAYLOAD)
        self.assertEqual(req.text, GUARDCLIENT_PAYLOAD["text"])
        self.assertIsNone(req.enabled_categories)
        # Not sent by the server today; must default to the pod default.
        self.assertIsNone(req.enabled_regions)

    def test_enabled_regions_is_a_known_field(self):
        req = PiiRequest(text="x", enabled_regions=["NL", "DE"])
        self.assertEqual(req.enabled_regions, ["NL", "DE"])

    def test_unknown_field_is_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            PiiRequest(text="x", redaction_mode="strict")
        self._assert_extra_forbidden(ctx.exception, "redaction_mode")

    def test_unknown_field_alongside_full_payload_is_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            PiiRequest(**{**GUARDCLIENT_PAYLOAD, "enabled_languages": ["nl"]})
        self._assert_extra_forbidden(ctx.exception, "enabled_languages")

    # ── custom_labels (2.3.0) ──────────────────────────────────────────────

    def test_custom_labels_payload_is_accepted(self):
        req = PiiRequest(**CUSTOM_LABELS_PAYLOAD)
        self.assertEqual(req.enabled_categories, [])
        self.assertEqual(
            [(lbl.id, lbl.prompt, lbl.floor) for lbl in req.custom_labels],
            [
                ("cdt_0123456789", "internal project code name", 0.5),
                ("cdt_abcdef0123", "customer contract number", 0.95),
            ],
        )

    def test_custom_labels_default_to_absent(self):
        self.assertIsNone(PiiRequest(**GUARDCLIENT_PAYLOAD).custom_labels)

    def test_six_labels_and_the_range_edges_are_accepted(self):
        labels = [_label(i) for i in range(5)]
        labels.append(_label(5, prompt="ab", floor=0.10))
        labels[0]["floor"] = 0.99
        labels[1]["prompt"] = "x" * 60
        self.assertEqual(
            len(PiiRequest(text="x", custom_labels=labels).custom_labels), 6
        )

    def test_prompt_is_trimmed(self):
        req = PiiRequest(text="x", custom_labels=[_label(1, prompt="  code name  ")])
        self.assertEqual(req.custom_labels[0].prompt, "code name")

    def _rejects(self, **fields):
        with self.assertRaises(ValidationError) as ctx:
            PiiRequest(**{**GUARDCLIENT_PAYLOAD, **fields})
        return ctx.exception

    def test_every_cap_is_a_validation_error(self):
        cases = {
            "seventh label": [_label(i) for i in range(7)],
            "61-char prompt": [_label(1, prompt="x" * 61)],
            "1-char prompt": [_label(1, prompt="x")],
            "blank prompt": [_label(1, prompt="   ")],
            "duplicate prompt": [
                _label(1, prompt="Code Name"),
                _label(2, prompt=" code name "),
            ],
            "duplicate id": [_label(1), _label(1, prompt="another prompt")],
            "opening framing": [_label(1, prompt="code <<ENT>> name")],
            "closing framing": [_label(1, prompt="code name >>")],
            "control character": [_label(1, prompt="code\nname")],
            "id without prefix": [_label(1, id="0123456789")],
            "id with uppercase hex": [_label(1, id="cdt_01234567AB")],
            "id too short": [_label(1, id="cdt_012345678")],
            "id too long": [_label(1, id="cdt_01234567890")],
            "id with trailing newline": [_label(1, id="cdt_0123456789\n")],
            "floor below range": [_label(1, floor=0.09)],
            "floor above range": [_label(1, floor=1.0)],
            "floor missing": [{"id": "cdt_0123456789", "prompt": "code name"}],
            "unknown item field": [_label(1, category="Person")],
        }
        for name, labels in cases.items():
            with self.subTest(case=name):
                self._rejects(custom_labels=labels)

    def test_unknown_label_item_field_is_extra_forbidden(self):
        exc = self._rejects(custom_labels=[_label(1, label="x")])
        self._assert_extra_forbidden(exc, "label")


@unittest.skipIf(ProbeRequest is None, f"pydantic unavailable: {_IMPORT_ERROR}")
class ProbeRequestContractTests(unittest.TestCase):
    """POST /pii/probe: the same forbid contract and the same label rules."""

    def test_probe_payload_is_accepted(self):
        req = ProbeRequest(**PROBE_PAYLOAD)
        self.assertEqual(req.label_set, PROBE_PAYLOAD["label_set"])

    def test_the_caps_hold_at_their_edges(self):
        req = ProbeRequest(
            texts=["x" * 4000] * 8,
            label_set={f"cdt_{i:010x}": f"kind of data {i}" for i in range(6)},
        )
        self.assertEqual((len(req.texts), len(req.label_set)), (8, 6))

    def test_every_cap_is_a_validation_error(self):
        six = {f"cdt_{i:010x}": f"kind of data {i}" for i in range(6)}
        cases = {
            "no texts": {"texts": []},
            "nine texts": {"texts": ["x"] * 9},
            "4001-char text": {"texts": ["x" * 4001]},
            "no labels": {"label_set": {}},
            "seven labels": {"label_set": {**six, "cdt_ffffffffff": "one too many"}},
            "bad id": {"label_set": {"CDT_0123456789": "code name"}},
            "61-char prompt": {"label_set": {"cdt_0123456789": "x" * 61}},
            "framing in prompt": {"label_set": {"cdt_0123456789": "<<SEP>>"}},
            "duplicate prompts": {
                "label_set": {
                    "cdt_0123456789": "Code name",
                    "cdt_0123456788": "code NAME ",
                }
            },
            "unknown field": {"threshold": 0.5},
        }
        for name, fields in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(ValidationError):
                    ProbeRequest(**{**PROBE_PAYLOAD, **fields})


@unittest.skipIf(
    _pii_router is None, f"fastapi/httpx unavailable: {_HTTP_IMPORT_ERROR}"
)
class PiiEndpointContractTests(unittest.TestCase):
    """The forbid must surface as HTTP 422 at the endpoint.

    Mounts the router on a bare app (no lifespan, no settings/redis), and only
    sends an INVALID body — FastAPI rejects it before the handler runs, so the
    detection service (and its model) is never imported.
    """

    def _client(self):
        app = FastAPI()
        app.include_router(_pii_router)
        return TestClient(app)

    def test_unknown_request_field_yields_422(self):
        client = self._client()
        res = client.post("/pii", json={**GUARDCLIENT_PAYLOAD, "bogus": 1})
        self.assertEqual(res.status_code, 422, res.text)
        self.assertIn("bogus", res.text)

    def test_custom_label_caps_yield_422(self):
        client = self._client()
        bad = {
            "seventh label": [_label(i) for i in range(7)],
            "61-char prompt": [_label(1, prompt="x" * 61)],
            "duplicate prompt": [_label(1, prompt="a b"), _label(2, prompt="A B")],
            "framing": [_label(1, prompt="a << b")],
            "bad id": [_label(1, id="cdt_xyz")],
            "floor out of range": [_label(1, floor=0.05)],
            "unknown item field": [_label(1, extra=True)],
        }
        for name, labels in bad.items():
            with self.subTest(case=name):
                res = client.post(
                    "/pii", json={**GUARDCLIENT_PAYLOAD, "custom_labels": labels}
                )
                self.assertEqual(res.status_code, 422, res.text)

    def test_probe_caps_yield_422(self):
        client = self._client()
        for body in (
            {**PROBE_PAYLOAD, "bogus": 1},
            {**PROBE_PAYLOAD, "texts": ["x"] * 9},
            {**PROBE_PAYLOAD, "label_set": {"cdt_0123456789": "x" * 61}},
        ):
            with self.subTest(body=list(body)):
                res = client.post("/pii/probe", json=body)
                self.assertEqual(res.status_code, 422, res.text)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
