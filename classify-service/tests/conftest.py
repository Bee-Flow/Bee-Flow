"""Fixtures for the model-free suite: a FakeClassifier stands in for GLiClass.

    pytest classify-service/tests      # from the repo root, needs requirements-dev.txt

No torch, no gliclass, no model download. The fake has the same surface the
router and /health read (ready, load_error, model_id, revision,
package_version, load(), classify()).
"""

from __future__ import annotations

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app.config import settings
from app.routers import classify as classify_router
from app.services import classifier as classifier_module
from app.services.classifier import Scored


class FakeClassifier:
    """Deterministic scores: 0.91234 when the label occurs in the text, else 0.08766."""

    def __init__(self, *, ready: bool = True, load_error: str | None = None) -> None:
        self.ready = ready
        self.load_error = load_error
        self.model_id = "knowledgator/gliclass-multilang-mini"
        self.revision = "0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b"
        self.package_version = "0.1.20"
        self.calls: list[tuple[list[str], list[str], str]] = []
        self.raises: Exception | None = None
        self.truncate = False
        # When set, classify() waits on `release` (and flags `started`), so a
        # test can hold requests in flight.
        self.block = False
        self.started = threading.Event()
        self.release = threading.Event()

    def load(self, cfg) -> bool:
        self.ready = self.load_error is None
        return self.ready

    def classify(
        self, texts: list[str], labels: list[str], label_mode: str
    ) -> list[Scored]:
        self.calls.append((list(texts), list(labels), label_mode))
        if self.block:
            self.started.set()
            self.release.wait(timeout=10)
        if self.raises is not None:
            raise self.raises
        return [
            Scored(
                {
                    label: 0.91234 if label.lower() in text.lower() else 0.08766
                    for label in labels
                },
                self.truncate,
            )
            for text in texts
        ]


@pytest.fixture
def fake():
    """A ready FakeClassifier, installed as the process-wide classifier."""
    service = FakeClassifier()
    classifier_module.set_classifier(service)
    classify_router.reset_gate()
    yield service
    service.release.set()
    classifier_module.set_classifier(None)
    classify_router.reset_gate()


@pytest.fixture
def make_app():
    """Build an app with an explicit key ("" = open), so tests never read the env."""
    from app.main import create_app

    def _make(api_key: str = ""):
        return create_app(api_key=api_key)

    return _make


@pytest.fixture
def client(fake, make_app):
    from fastapi.testclient import TestClient

    return TestClient(make_app())


@pytest.fixture
def tune(monkeypatch):
    """Set settings fields for one test; the gate is rebuilt from them."""

    def _set(**values):
        for name, value in values.items():
            monkeypatch.setattr(settings, name, value)
        classify_router.reset_gate()

    return _set
