"""GET /health and /ready, and the warm-load loop behind them."""

from __future__ import annotations

import pytest

from app import main
from app.models import MAX_LABELS, MAX_TEXTS


def test_health_reports_identity_and_limits_when_ready(client, fake):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "status": "ok",
        "service": "classify-service",
        "version": main.SERVICE_VERSION,
        "backend": "torch-cpu",
        "model": fake.model_id,
        "revision": fake.revision,
        "engine": body["engine"],
        "default_threshold": 0.75,
        "max_labels": MAX_LABELS,
        "max_texts": MAX_TEXTS,
        "max_chars": 4000,
        "label_mode": "joint",
        "load_error": None,
    }
    assert body["engine"].startswith(
        "gliclass-multilang-mini@0bd888b6c3ef/gliclass-0.1.20/"
    )


@pytest.mark.parametrize(
    ("load_error", "status"),
    [(None, "loading"), ("OSError: /opt/model is empty", "error")],
)
@pytest.mark.parametrize("path", ["/health", "/ready"])
def test_503_until_loaded(client, fake, path, load_error, status):
    fake.ready, fake.load_error = False, load_error
    r = client.get(path)
    assert r.status_code == 503
    assert r.json()["status"] == status
    assert r.json()["load_error"] == load_error


def test_ready_is_200_once_loaded(client):
    assert client.get("/ready").status_code == 200


def test_engine_changes_with_a_scoring_knob(client, tune):
    before = client.get("/health").json()["engine"]
    tune(label_mode="independent")
    after = client.get("/health").json()
    assert after["label_mode"] == "independent"
    assert after["engine"] != before


def test_warm_load_retries_until_the_model_loads(fake):
    fake.ready = False
    outcomes = iter([False, False, True])
    fake.load = lambda cfg: next(outcomes)
    slept: list[float] = []
    main.warm_load(sleep=slept.append)
    assert slept == [5, 15]


def test_warm_load_keeps_trying_after_the_backoff(fake):
    fake.ready = False
    outcomes = iter([False] * 7 + [True])
    fake.load = lambda cfg: next(outcomes)
    slept: list[float] = []
    main.warm_load(sleep=slept.append)
    assert slept == [5, 15, 30, 60, 120, 300, 300]


def test_lifespan_starts_the_warm_load(fake, make_app):
    from fastapi.testclient import TestClient

    fake.ready = False
    with TestClient(make_app()) as c:
        for _ in range(200):
            if fake.ready:
                break
            import time

            time.sleep(0.01)
        assert c.get("/ready").status_code == 200
