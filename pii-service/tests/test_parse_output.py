"""Unit tests for PiiService._parse_output offset handling.

These exercise the pure parsing path only (no model load), so they run without
torch/transformers. Run: pytest pii-service/tests/test_parse_output.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.service import get_pii_service  # noqa: E402


def _parse(pii_output, original_text, threshold=0.3):
    return get_pii_service()._parse_output(pii_output, original_text, threshold)


def test_duplicate_values_get_distinct_offsets():
    text = "Jack Smith and Jack Brown"
    out = "<name> : ['Jack', 'Jack']"
    ents = _parse(out, text)
    offsets = sorted(e["offset"] for e in ents)
    assert offsets == [0, 15], f"expected distinct offsets, got {offsets}"
    # Each offset must actually point at the value in the original text.
    for e in ents:
        assert text[e["offset"] : e["offset"] + e["length"]] == "Jack"


def test_single_value_offset_is_correct():
    text = "Contact julia@example.com today"
    out = "<email> : ['julia@example.com']"
    ents = _parse(out, text)
    assert len(ents) == 1
    e = ents[0]
    assert text[e["offset"] : e["offset"] + e["length"]] == "julia@example.com"


def test_threshold_above_fixed_confidence_returns_nothing():
    text = "Jack Smith"
    out = "<name> : ['Jack']"
    # Fixed backend confidence is 0.95; a threshold above it must suppress all.
    assert _parse(out, text, threshold=0.99) == []
    # ... and below it keeps detections.
    assert len(_parse(out, text, threshold=0.7)) == 1


def test_value_missing_from_text_falls_back_to_offset_zero():
    text = "no personal data here"
    out = "<name> : ['Zoltan']"
    ents = _parse(out, text)
    assert len(ents) == 1
    assert ents[0]["offset"] == 0
    assert ents[0]["text"] == "Zoltan"
