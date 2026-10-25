"""X-API-Key: required everywhere but /health once a key is configured."""

from __future__ import annotations

import pytest
from app.config import Settings, effective_api_key
from fastapi.testclient import TestClient

BODY = {"texts": ["x"], "labels": ["a"]}


@pytest.fixture
def locked(fake, make_app):
    return TestClient(make_app(api_key="s3cret"))


def test_missing_key_is_refused(locked, fake):
    assert locked.post("/classify", json=BODY).status_code == 401
    assert fake.calls == []


def test_forwarded_for_does_not_make_a_request_internal(locked):
    r = locked.post("/classify", json=BODY, headers={"X-Forwarded-For": "10.0.0.1"})
    assert r.status_code == 401


def test_wrong_key_is_refused(locked):
    r = locked.post("/classify", json=BODY, headers={"X-API-Key": "nope"})
    assert r.status_code == 401
    assert r.json() == {"error": "Invalid or missing API key"}


def test_right_key_passes(locked):
    r = locked.post("/classify", json=BODY, headers={"X-API-Key": "s3cret"})
    assert r.status_code == 200


def test_health_stays_open(locked):
    assert locked.get("/health").status_code == 200


def test_ready_needs_the_key_as_in_guard_service(locked):
    assert locked.get("/ready").status_code == 401
    assert locked.get("/ready", headers={"X-API-Key": "s3cret"}).status_code == 200


def test_unauthenticated_body_is_refused_before_the_size_check(locked):
    r = locked.post("/classify", content=b"x" * (300 * 1024))
    assert r.status_code == 401


def test_no_key_configured_means_open(client):
    assert client.post("/classify", json=BODY).status_code == 200


@pytest.mark.parametrize(
    ("classify_key", "services_key", "expected"),
    [("own", "shared", "own"), ("", "shared", "shared"), ("", None, "")],
)
def test_effective_key_prefers_classify_over_services(
    monkeypatch, classify_key, services_key, expected
):
    if services_key is None:
        monkeypatch.delenv("SERVICES_API_KEY", raising=False)
    else:
        monkeypatch.setenv("SERVICES_API_KEY", services_key)
    assert effective_api_key(Settings(api_key=classify_key)) == expected


def test_create_app_reads_the_environment_by_default(monkeypatch, fake):
    from app.main import create_app

    monkeypatch.setenv("SERVICES_API_KEY", "from-env")
    c = TestClient(create_app())
    assert c.post("/classify", json=BODY).status_code == 401
    assert (
        c.post("/classify", json=BODY, headers={"X-API-Key": "from-env"}).status_code
        == 200
    )


# --- fail closed -----------------------------------------------------------


def test_no_key_refuses_to_start(monkeypatch):
    from app.main import create_app
    from app.shared.startup import ApiKeyRequired

    for name in ("SERVICES_API_KEY", "CLASSIFY_ALLOW_OPEN", "SERVICES_ALLOW_OPEN"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ApiKeyRequired, match="CLASSIFY_API_KEY"):
        create_app()
    with pytest.raises(ApiKeyRequired):
        create_app(api_key="")


@pytest.mark.parametrize("name", ["CLASSIFY_ALLOW_OPEN", "SERVICES_ALLOW_OPEN"])
def test_allow_open_lets_it_start_without_a_key(monkeypatch, fake, name):
    from app.main import create_app

    for n in ("SERVICES_API_KEY", "CLASSIFY_ALLOW_OPEN", "SERVICES_ALLOW_OPEN"):
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setenv(name, "1")
    assert (
        TestClient(create_app(api_key="")).post("/classify", json=BODY).status_code
        == 200
    )


def test_there_is_no_cors_so_no_origin_is_allowed(fake, make_app):
    c = TestClient(make_app(api_key="s3cret"))
    r = c.options(
        "/classify",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in r.headers
    r = c.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers
