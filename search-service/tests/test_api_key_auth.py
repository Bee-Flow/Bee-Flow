"""The service key is required on every request except /health once it is set.
A request without X-Forwarded-For is not "internal"; that header is the
caller's to send or omit. Run: pytest search-service/tests
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api_key_auth import APIKeyMiddleware  # noqa: E402


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(APIKeyMiddleware, api_key="s3cret")

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/tools/thing")
    def thing():
        return {"ok": True}

    return TestClient(app)


def test_missing_key_without_forwarded_for_is_refused(client):
    assert client.get("/tools/thing").status_code == 401


def test_wrong_key_is_refused(client):
    assert client.get("/tools/thing", headers={"X-API-Key": "nope"}).status_code == 401


def test_right_key_passes(client):
    assert (
        client.get("/tools/thing", headers={"X-API-Key": "s3cret"}).status_code == 200
    )


def test_health_stays_open(client):
    assert client.get("/health").status_code == 200
