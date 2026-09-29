"""The services key reaches this service under the name the compose files use.
Every other setting carries the SEARCH_ prefix; the key is shared with the
Node server and the inference sidecar and arrives as plain SERVICES_API_KEY.
Run: pytest search-service/tests
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
from app.config import Settings  # noqa: E402


def _settings(monkeypatch, **env):
    for name in ("SERVICES_API_KEY", "SEARCH_SERVICES_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings(_env_file=None)


def test_the_unprefixed_name_the_compose_files_set_is_read(monkeypatch):
    assert (
        _settings(monkeypatch, SERVICES_API_KEY="shared").services_api_key == "shared"
    )


def test_the_prefixed_spelling_still_works(monkeypatch):
    assert (
        _settings(monkeypatch, SEARCH_SERVICES_API_KEY="prefixed").services_api_key
        == "prefixed"
    )


def test_no_key_means_open_endpoints(monkeypatch):
    assert _settings(monkeypatch).services_api_key == ""


def test_other_settings_keep_their_prefix(monkeypatch):
    monkeypatch.setenv("SEARCH_SERPER_TIMEOUT", "9.5")
    assert _settings(monkeypatch).serper_timeout == 9.5
