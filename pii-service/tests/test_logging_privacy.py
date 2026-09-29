"""The service exists to keep personal data out of other systems' logs; its own
logs must not carry the values it detects. Run: pytest pii-service/tests
"""

import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.service import get_pii_service  # noqa: E402

TEXT = "Contact Jack Smith about the invoice"
MODEL_OUTPUT = "prompt echo\nThe PII data are:\n<name> : ['Jack Smith']"


def test_detected_values_never_reach_the_log(caplog):
    with caplog.at_level(logging.INFO):
        result = get_pii_service()._postprocess(MODEL_OUTPUT, TEXT, 0.3, None)

    assert result["hasPii"] is True
    assert [e["text"] for e in result["entities"]] == ["Jack Smith"]
    for record in caplog.records:
        assert "Jack" not in record.getMessage()
        assert "Smith" not in record.getMessage()
    assert any("Detected 1 entities" in r.getMessage() for r in caplog.records)


def test_unexpected_output_is_logged_by_size_not_content(caplog):
    with caplog.at_level(logging.WARNING):
        result = get_pii_service()._postprocess(
            "Jack Smith, no marker here", TEXT, 0.3, None
        )

    assert result == {"hasPii": False, "entities": []}
    assert all("Jack" not in r.getMessage() for r in caplog.records)
