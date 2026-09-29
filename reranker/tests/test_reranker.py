"""The reranker without a model: request validation, the sigmoid and the
ranking helper, the settings, and the endpoint over a fake ONNX backend.
Run: pytest reranker/tests
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
from pydantic import ValidationError  # noqa: E402

import reranker  # noqa: E402
from reranker import RerankRequest, Settings, _rank, _sigmoid, app  # noqa: E402

# ── settings ─────────────────────────────────────────────────────────

ENV = ("RERANK_MODEL", "PORT", "MODEL_DIR", "ORT_THREADS")


def _settings(monkeypatch, **env):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings()


def test_defaults_match_the_dockerfile(monkeypatch):
    s = _settings(monkeypatch)
    assert s.rerank_model == "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
    assert (s.port, s.model_dir, s.ort_threads) == (8000, "/app/model", 0)


def test_the_environment_overrides_every_setting(monkeypatch):
    s = _settings(
        monkeypatch, RERANK_MODEL="x/y", PORT="9000", MODEL_DIR="/m", ORT_THREADS="4"
    )
    assert (s.rerank_model, s.port, s.model_dir, s.ort_threads) == (
        "x/y",
        9000,
        "/m",
        4,
    )


# ── the maths ────────────────────────────────────────────────────────


def test_sigmoid_is_centred_symmetric_and_stable():
    assert _sigmoid(0.0) == 0.5
    assert _sigmoid(2.0) + _sigmoid(-2.0) == pytest.approx(1.0)
    assert _sigmoid(1000.0) == 1.0
    assert _sigmoid(-1000.0) == 0.0


def test_rank_sorts_best_first_rounds_and_cuts():
    results = _rank([0.123456, 0.9, 0.5], ["a", "b", "c"], top_n=2)
    assert [(r.index, r.document) for r in results] == [(1, "b"), (2, "c")]
    everything = _rank([0.123456, 0.9], ["a", "b"], top_n=None)
    assert everything[-1].relevance_score == 0.1235
    assert _rank([], [], None) == []


# ── the request contract ─────────────────────────────────────────────


def _errors(**payload):
    with pytest.raises(ValidationError) as exc_info:
        RerankRequest(**payload)
    return [e["type"] for e in exc_info.value.errors()]


def test_a_minimal_request_is_valid():
    req = RerankRequest(query="q", documents=["d"])
    assert req.top_n is None


def test_unknown_fields_are_refused():
    assert "extra_forbidden" in _errors(query="q", documents=["d"], model="x")


def test_the_limits_hold():
    assert "string_too_long" in _errors(query="q" * 10_001, documents=["d"])
    assert "too_long" in _errors(query="q", documents=["d"] * 201)
    assert "greater_than_equal" in _errors(query="q", documents=["d"], top_n=0)


# ── the endpoint ─────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    from fastapi.testclient import TestClient

    monkeypatch.setattr(reranker, "_backend", "onnx")
    monkeypatch.setattr(reranker, "_infer_onnx", lambda query, docs: [0.1, 0.9, 0.5])
    # TestClient without the context manager: the lifespan never runs, so no
    # model is loaded and the fake above is the whole backend.
    return TestClient(app)


def test_rerank_answers_sorted_results_from_the_backend(client):
    res = client.post(
        "/rerank", json={"query": "q", "documents": ["a", "b", "c"], "top_n": 2}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert [(r["index"], r["document"]) for r in body["results"]] == [
        (1, "b"),
        (2, "c"),
    ]
    assert body["backend"] == "onnx"
    assert body["model"] == reranker.settings.rerank_model
    assert body["latency_ms"] >= 0


def test_no_documents_means_no_inference(client, monkeypatch):
    def boom(query, docs):
        raise AssertionError("must not infer")

    monkeypatch.setattr(reranker, "_infer_onnx", boom)
    res = client.post("/rerank", json={"query": "q", "documents": []})
    assert res.status_code == 200
    assert res.json()["results"] == []


def test_an_unknown_field_is_a_422(client):
    res = client.post("/rerank", json={"query": "q", "documents": ["a"], "bogus": 1})
    assert res.status_code == 422


def test_the_sentence_transformers_backend_is_used_when_selected(client, monkeypatch):
    monkeypatch.setattr(reranker, "_backend", "sentence-transformers")
    monkeypatch.setattr(reranker, "_infer_st", lambda query, docs: [0.2])
    res = client.post("/rerank", json={"query": "q", "documents": ["a"]})
    assert res.json()["results"][0]["relevance_score"] == 0.2
    assert res.json()["backend"] == "sentence-transformers"


def test_health_reports_the_model_and_backend(client):
    body = client.get("/health").json()
    assert body == {
        "status": "ok",
        "model": reranker.settings.rerank_model,
        "backend": "onnx",
    }
