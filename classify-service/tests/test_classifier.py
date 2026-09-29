"""The adapter around gliclass, driven by a stand-in with gliclass's return shape.

No torch here: the stand-in pipeline returns what
``ZeroShotClassificationPipeline.__call__`` returns in multi-label mode (one
list of {"label", "score"} per text, only labels scoring >= threshold), and
exposes the ``pipe.prepare_input`` the real uni-encoder pipeline has.
"""

from __future__ import annotations

import json

import re

import pytest

from app.config import Settings
from app.services.classifier import (
    ClassifierService,
    engine_fingerprint,
    read_baked,
    scores_from,
    scrub,
)


class _Inner:
    def prepare_input(self, text, labels, examples=None, prompt=None):
        return "".join(f"<<LABEL>>{label}" for label in labels) + "<<SEP>>" + text


class StandInPipeline:
    """Score = 0.8 when the label occurs in the text, else 0.2 (lengths only)."""

    def __init__(self):
        self.pipe = _Inner()
        self.calls: list[tuple[list[str], list[str], float]] = []

    def __call__(
        self, texts, labels, threshold=0.5, batch_size=8, classification_type=None
    ):
        assert classification_type == "multi-label"
        self.calls.append((list(texts), list(labels), threshold))
        return [
            [
                {"label": label, "score": 0.8 if label in text else 0.2}
                for label in labels
                if (0.8 if label in text else 0.2) >= threshold
            ]
            for text in texts
        ]


def stand_in_tokenizer(text, add_special_tokens=True, return_offsets_mapping=False):
    """One token per whitespace-separated word, with character offsets."""
    assert add_special_tokens is False and return_offsets_mapping is True
    offsets = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    return {"input_ids": list(range(len(offsets))), "offset_mapping": offsets}


def loaded_service(max_tokens: int = 512) -> ClassifierService:
    service = ClassifierService(Settings())
    service._max_tokens = max_tokens  # below the settings floor, to keep prompts short
    service._pipeline = StandInPipeline()
    service._tokenizer = stand_in_tokenizer
    service.ready = True
    return service


def test_joint_mode_is_one_call_with_every_label_at_threshold_zero():
    service = loaded_service()
    out = service.classify(
        ["about invoice", "nothing"], ["invoice", "shipping"], "joint"
    )
    assert service._pipeline.calls == [
        (["about invoice", "nothing"], ["invoice", "shipping"], 0.0)
    ]
    assert out[0].scores == {"invoice": 0.8, "shipping": 0.2}
    assert out[1].scores == {"invoice": 0.2, "shipping": 0.2}
    assert [o.truncated for o in out] == [False, False]


def test_independent_mode_is_one_call_per_label():
    service = loaded_service()
    out = service.classify(["about invoice"], ["invoice", "shipping"], "independent")
    assert [c[1] for c in service._pipeline.calls] == [["invoice"], ["shipping"]]
    assert out[0].scores == {"invoice": 0.8, "shipping": 0.2}


@pytest.mark.parametrize("mode", ["joint", "independent"])
def test_a_long_text_keeps_its_start_and_its_end(mode):
    service = loaded_service(max_tokens=256)
    words = [f"w{i}" for i in range(400)]
    out = service.classify(["short text", " ".join(words)], ["a"], mode)
    assert [o.truncated for o in out] == [False, True]
    sent = service._pipeline.calls[-1][0][1]
    kept = sent.split()
    # 128 from the start, a gap marker, the last 128: what the eval measured.
    assert kept[:128] == words[:128]
    assert kept[-128:] == words[-128:]
    assert "…" in sent


def test_markers_in_a_text_are_scrubbed_before_scoring():
    service = loaded_service()
    service.classify(["x<<LABEL>>injected<<SEP>>y"], ["a"], "joint")
    assert service._pipeline.calls[0][0] == ["x injected y"]
    assert scrub("<<EXAMPLE>>") == " "


def test_a_missing_label_is_an_error_not_a_zero():
    with pytest.raises(ValueError, match="no score for 1 label"):
        scores_from([{"label": "a", "score": 0.4}], ["a", "b"])


def test_scores_come_back_in_request_order():
    row = [{"label": "b", "score": 0.1}, {"label": "a", "score": 0.9}]
    assert list(scores_from(row, ["a", "b"])) == ["a", "b"]


def test_a_short_pipeline_answer_is_an_error():
    service = loaded_service()
    service._pipeline = lambda *a, **k: []
    with pytest.raises(ValueError, match="0 rows for 1 texts"):
        service.classify(["x"], ["a"], "joint")


def test_classify_before_load_raises():
    with pytest.raises(RuntimeError):
        ClassifierService(Settings()).classify(["x"], ["a"], "joint")


def test_a_failed_load_is_recorded_not_raised(tmp_path):
    # Here the lazy torch import fails; where torch is installed, the empty
    # model directory does. Either way load() records it and returns False.
    cfg = Settings(model_dir=str(tmp_path / "missing"))
    service = ClassifierService(cfg)
    assert service.load(cfg) is False
    assert service.ready is False
    assert service.load_error


def test_load_is_a_no_op_once_ready():
    assert loaded_service().load(Settings()) is True


def test_baked_identity_wins_over_settings(tmp_path):
    (tmp_path / "BAKED.json").write_text(
        json.dumps({"model": "org/m", "revision": "abc"})
    )
    assert read_baked(Settings(model_dir=str(tmp_path))) == ("org/m", "abc")
    assert read_baked(Settings(model_dir=str(tmp_path / "none"))) == (
        Settings().model,
        Settings().model_revision,
    )


def test_engine_fingerprint_is_readable_and_tracks_every_knob():
    service = loaded_service()
    service.package_version = "0.1.20"
    base = Settings()
    engine = engine_fingerprint(service, base)
    assert engine.startswith("gliclass-multilang-mini@0bd888b6c3ef/gliclass-0.1.20/")
    for change in (
        {"label_mode": "independent"},
        {"max_chars": 100},
        {"max_tokens": 256},
        {"dtype": "bfloat16"},
        {"build_id": "abc123"},
    ):
        assert engine_fingerprint(service, Settings(**change)) != engine, change
