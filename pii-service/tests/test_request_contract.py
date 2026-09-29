"""Contract tests for the /pii request model (U9).

The request contract must be LOUD: a field this build does not know yields a
validation error / HTTP 422, never a silent drop (a dropped narrowing filter
from a newer Node server would read as "scan everything"). Wire-parity is
pinned against the only Node caller,
server/core/privacy/piiDetection/guardClient.js:62-66, plus the
``enabled_regions`` field the guard-service already accepts — the same
PII_SERVICE_URL can point at either service, so the two /pii contracts must
not skew.

No model load: validation happens before the handler runs, so torch is never
imported. Run: pytest pii-service/tests/test_request_contract.py
(CI installs pytest + fastapi + pydantic; the HTTP-layer tests also need
httpx for TestClient and skip without it.)
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

pytest.importorskip("pydantic", reason="pydantic not installed")
pytest.importorskip("fastapi", reason="fastapi not installed")

from pydantic import ValidationError  # noqa: E402

from app.main import SERVICE_VERSION, PiiRequest, app  # noqa: E402

# Exactly what guardClient.js:62-66 puts on the wire today.
GUARDCLIENT_PAYLOAD = {
    "text": "Contact julia@example.com",
    "confidence_threshold": 0.7,
    "enabled_categories": None,
}


def _assert_extra_forbidden(exc: ValidationError, field: str) -> None:
    errors = exc.errors()
    assert any(e.get("type") == "extra_forbidden" for e in errors), errors
    assert any(field in (e.get("loc") or ()) for e in errors), errors


def test_guardclient_payload_is_accepted():
    req = PiiRequest(**GUARDCLIENT_PAYLOAD)
    assert req.text == GUARDCLIENT_PAYLOAD["text"]
    assert req.enabled_categories is None
    assert req.enabled_regions is None


def test_enabled_regions_matches_guard_service_contract():
    # Accepted-and-ignored here; the guard-service implements it. Without the
    # declaration, extra="forbid" would 422 the day the server sends it.
    req = PiiRequest(text="x", enabled_regions=["NL"])
    assert req.enabled_regions == ["NL"]


def test_unknown_field_is_rejected():
    with pytest.raises(ValidationError) as exc_info:
        PiiRequest(**{**GUARDCLIENT_PAYLOAD, "redaction_mode": "strict"})
    _assert_extra_forbidden(exc_info.value, "redaction_mode")


def test_unknown_request_field_yields_422():
    # TestClient WITHOUT the context manager: lifespan never runs, so the
    # model is never loaded — FastAPI rejects the body before the handler.
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    from fastapi.testclient import TestClient

    client = TestClient(app)
    res = client.post("/pii", json={**GUARDCLIENT_PAYLOAD, "bogus": 1})
    assert res.status_code == 422, res.text
    assert "bogus" in res.text


def test_health_reports_contract_version():
    # The server's pre-flight probe: `version` present == this build rejects
    # unknown fields and knows enabled_regions; absent == pre-1.1 contract.
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    from fastapi.testclient import TestClient

    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200, res.text
    assert res.json().get("version") == SERVICE_VERSION
