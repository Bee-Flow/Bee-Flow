"""POST /classify: request bounds, response shape, status codes."""

from __future__ import annotations

import pytest

from app.models import MAX_LABEL_CHARS, MAX_LABELS, MAX_TEXTS, ClassifyRequest
from app.services.classifier import Scored

TEXTS = ["Mijn factuur klopt niet", "Question about the invoice and shipping"]
LABELS = ["invoice", "shipping", "complaint"]


def post(client, **body):
    return client.post("/classify", json=body)


def test_scores_every_label_for_every_text_in_order(client, fake):
    r = post(client, texts=TEXTS, labels=LABELS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["labels"] == LABELS
    assert len(body["results"]) == len(TEXTS)
    first, second = body["results"]
    assert list(first["scores"]) == LABELS
    assert first["scores"] == {
        "invoice": 0.0877,
        "shipping": 0.0877,
        "complaint": 0.0877,
    }
    assert second["scores"] == {
        "invoice": 0.9123,
        "shipping": 0.9123,
        "complaint": 0.0877,
    }
    assert first["truncated"] is False
    assert "matched" not in first
    assert fake.calls == [(TEXTS, LABELS, "joint")]


def test_response_carries_identity_and_timing(client, fake):
    body = post(client, texts=["x"], labels=["a"]).json()
    assert body["model"] == fake.model_id
    assert body["revision"] == fake.revision
    assert body["engine"].startswith(
        "gliclass-multilang-mini@0bd888b6c3ef/gliclass-0.1.20/"
    )
    assert body["default_threshold"] == 0.75
    assert isinstance(body["ms"], float)


def test_threshold_adds_matched_labels(client):
    body = post(client, texts=TEXTS, labels=LABELS, threshold=0.5).json()
    assert [r["matched"] for r in body["results"]] == [[], ["invoice", "shipping"]]


def test_matched_uses_the_rounded_score_the_caller_sees(client, fake):
    fake.classify = lambda texts, labels, mode: [Scored({"a": 0.49996}, False)]
    body = post(client, texts=["x"], labels=["a"], threshold=0.5).json()
    assert body["results"][0] == {
        "scores": {"a": 0.5},
        "truncated": False,
        "matched": ["a"],
    }


def test_labels_are_trimmed_before_scoring(client, fake):
    body = post(client, texts=["x"], labels=["  invoice ", "complaint"]).json()
    assert body["labels"] == ["invoice", "complaint"]
    assert fake.calls[0][1] == ["invoice", "complaint"]


def test_label_mode_is_passed_through(client, fake, tune):
    tune(label_mode="independent")
    assert post(client, texts=["x"], labels=["a"]).status_code == 200
    assert fake.calls[0][2] == "independent"


def test_long_text_is_cut_and_flagged(client, fake, tune):
    tune(max_chars=10)
    body = post(client, texts=["0123456789abc", "short"], labels=["a"]).json()
    # The start and the end survive the cut, with a gap between them.
    assert fake.calls[0][0] == ["01234\n…\nbc", "short"]
    assert [r["truncated"] for r in body["results"]] == [True, False]


def test_token_window_truncation_is_reported(client, fake):
    fake.truncate = True
    body = post(client, texts=["short"], labels=["a"]).json()
    assert body["results"][0]["truncated"] is True


@pytest.mark.parametrize(
    "body",
    [
        {"texts": [], "labels": ["a"]},
        {"texts": ["x"] * (MAX_TEXTS + 1), "labels": ["a"]},
        {"texts": ["x"], "labels": []},
        {"texts": ["x"], "labels": [f"l{i}" for i in range(MAX_LABELS + 1)]},
        {"texts": ["x"], "labels": ["   "]},
        {"texts": ["x"], "labels": ["a" * (MAX_LABEL_CHARS + 1)]},
        {"texts": ["x"], "labels": ["invoice", " invoice "]},
        {"texts": ["x"], "labels": ["a<<LABEL>>b"]},
        {"texts": ["x"], "labels": ["a"], "threshold": 0},
        {"texts": ["x"], "labels": ["a"], "threshold": 1},
        {"texts": ["x"], "labels": ["a"], "threshold": 1.5},
        {"texts": ["x"], "labels": ["a"], "top_k": 3},
        {"texts": "x", "labels": ["a"]},
        {"labels": ["a"]},
    ],
)
def test_invalid_requests_are_422(client, fake, body):
    r = client.post("/classify", json=body)
    assert r.status_code == 422, r.text
    assert fake.calls == []


def test_limits_are_inclusive(client):
    body = {
        "texts": ["x"] * MAX_TEXTS,
        "labels": [f"l{i}" for i in range(MAX_LABELS - 1)] + ["a" * MAX_LABEL_CHARS],
    }
    assert post(client, **body).status_code == 200


def test_unknown_field_is_extra_forbidden():
    with pytest.raises(ValueError) as exc:
        ClassifyRequest(texts=["x"], labels=["a"], top_k=3)
    assert "extra_forbidden" in str(exc.value)


@pytest.mark.parametrize(
    ("ready", "load_error", "detail"),
    [(False, None, "model_loading"), (False, "OSError: no weights", "model_error")],
)
def test_503_until_the_model_is_ready(client, fake, ready, load_error, detail):
    fake.ready, fake.load_error = ready, load_error
    r = post(client, texts=["x"], labels=["a"])
    assert r.status_code == 503
    assert r.json() == {"detail": detail}
    assert fake.calls == []


def test_inference_failure_is_a_bare_500(client, fake):
    fake.raises = RuntimeError("tokenizer choked on: secret words")
    r = post(client, texts=["x"], labels=["a"])
    assert r.status_code == 500
    assert r.json() == {"detail": "inference_error"}


def test_misaligned_classifier_output_is_a_500(client, fake):
    fake.classify = lambda texts, labels, mode: []
    r = post(client, texts=["x"], labels=["a"])
    assert r.status_code == 500
    assert r.json() == {"detail": "inference_error"}
