"""The service classifies customer text; its logs must never carry any of it.

Every path a request can take (scored, invalid, not ready, failed, busy, too
large) is driven with a distinctive text and label, and no log record may
contain either: not in the message, not in its args, not in a traceback.
"""

from __future__ import annotations

import logging

import pytest

SECRET_TEXT = "Zorgdossier van Wilhelmina Oosterveld-Brakman, BSN 999994529"
SECRET_LABEL = "Oosterveld-Brakman dossier"
NEEDLES = ("Wilhelmina", "Oosterveld", "999994529", "Zorgdossier")


def _assert_clean(caplog):
    assert caplog.records, "expected the request to log something"
    for record in caplog.records:
        rendered = " ".join(
            str(part)
            for part in (
                record.getMessage(),
                record.args,
                record.exc_text,
                record.exc_info,
            )
        )
        for needle in NEEDLES:
            assert needle not in rendered, f"{record.name} logged {needle!r}"


@pytest.fixture
def capture(caplog):
    caplog.set_level(logging.DEBUG)
    return caplog


def test_a_scored_request_logs_counts_only(client, capture):
    r = client.post(
        "/classify", json={"texts": [SECRET_TEXT], "labels": [SECRET_LABEL]}
    )
    assert r.status_code == 200
    _assert_clean(capture)
    assert any("texts=1 labels=1" in rec.getMessage() for rec in capture.records)


def test_an_inference_error_logs_the_class_not_the_message(client, fake, capture):
    fake.raises = ValueError(f"could not tokenize {SECRET_TEXT!r}")
    r = client.post(
        "/classify", json={"texts": [SECRET_TEXT], "labels": [SECRET_LABEL]}
    )
    assert r.status_code == 500
    _assert_clean(capture)
    assert any("error=ValueError" in rec.getMessage() for rec in capture.records)


@pytest.mark.parametrize("load_error", [None, "OSError: weights missing"])
def test_a_refused_request_logs_counts_only(client, fake, capture, load_error):
    fake.ready, fake.load_error = False, load_error
    r = client.post(
        "/classify", json={"texts": [SECRET_TEXT], "labels": [SECRET_LABEL]}
    )
    assert r.status_code == 503
    _assert_clean(capture)


def test_a_busy_refusal_logs_counts_only(client, fake, capture, tune):
    tune(max_concurrency=1, max_queue=0)
    from app.routers import classify as classify_router

    classify_router.get_gate().admitted = 1  # as if one request were running
    r = client.post(
        "/classify", json={"texts": [SECRET_TEXT], "labels": [SECRET_LABEL]}
    )
    assert r.status_code == 429
    _assert_clean(capture)


def test_invalid_and_oversize_requests_log_nothing_of_the_body(client, capture):
    bad = client.post(
        "/classify",
        json={"texts": [SECRET_TEXT], "labels": [SECRET_LABEL, SECRET_LABEL]},
    )
    assert bad.status_code == 422
    big = client.post(
        "/classify",
        json={"texts": [SECRET_TEXT * 5000], "labels": [SECRET_LABEL]},
    )
    assert big.status_code == 413
    for record in capture.records:
        for needle in NEEDLES:
            assert needle not in record.getMessage()


def test_the_real_classifier_never_logs_text(capture):
    """The adapter around gliclass, driven by a stand-in pipeline."""
    from test_classifier import loaded_service

    service = loaded_service()
    service.classify([SECRET_TEXT], [SECRET_LABEL], "joint")
    service.classify([SECRET_TEXT], [SECRET_LABEL], "independent")
    for record in capture.records:
        for needle in NEEDLES:
            assert needle not in record.getMessage()
