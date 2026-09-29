"""The whisperx service without a model: the bounded upload read, the key
middleware, the settings, the huggingface_hub keyword shim, and what the
endpoints answer before any model is loaded. Run: pytest whisperx-service/tests
"""

import asyncio
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
pytest.importorskip("fastapi")
from fastapi import FastAPI, HTTPException  # noqa: E402

import app as whisperx_app  # noqa: E402
from app import APIKeyMiddleware, Settings, _read_bounded  # noqa: E402


class FakeUpload:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0
        self.reads = 0

    async def read(self, size: int) -> bytes:
        self.reads += 1
        chunk = self._data[self._pos : self._pos + size]
        self._pos += size
        return chunk


# ── _read_bounded ────────────────────────────────────────────────────


def test_an_upload_under_the_cap_comes_back_whole():
    upload = FakeUpload(b"x" * (3 * 1024 * 1024 + 7))
    assert asyncio.run(_read_bounded(upload, max_bytes=4 * 1024 * 1024)) == upload._data
    assert upload.reads == 5  # four megabyte chunks and the empty read that ends it


def test_an_upload_over_the_cap_is_a_413_before_it_is_buffered():
    upload = FakeUpload(b"x" * (3 * 1024 * 1024))
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_read_bounded(upload, max_bytes=2 * 1024 * 1024))
    assert exc_info.value.status_code == 413
    assert "2 MB" in exc_info.value.detail
    assert upload.reads == 3, "the read stops at the chunk that crosses the cap"


def test_the_default_cap_is_the_configured_one(monkeypatch):
    monkeypatch.setattr(whisperx_app, "MAX_UPLOAD_BYTES", 10)
    with pytest.raises(HTTPException):
        asyncio.run(_read_bounded(FakeUpload(b"x" * 11)))
    assert asyncio.run(_read_bounded(FakeUpload(b"x" * 10))) == b"x" * 10


# ── settings ─────────────────────────────────────────────────────────

ENV = (
    "SERVICES_API_KEY",
    "WHISPERX_DEVICE",
    "WHISPERX_TORCH_DEVICE",
    "WHISPERX_BATCH_SIZE",
    "WHISPER_MODEL",
    "HF_TOKEN",
    "WHISPERX_MAX_UPLOAD_MB",
)


def _settings(monkeypatch, **env):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings()


def test_defaults_are_the_documented_ones(monkeypatch):
    s = _settings(monkeypatch)
    assert (s.whisper_model, s.whisperx_batch_size, s.hf_token) == ("medium", 4, "")
    assert s.max_upload_bytes == 500 * 1024 * 1024
    assert s.services_api_key == ""


def test_the_device_follows_torch_unless_set(monkeypatch):
    monkeypatch.setattr(whisperx_app.torch.cuda, "is_available", lambda: False)
    assert _settings(monkeypatch).resolved_device() == "cpu"
    monkeypatch.setattr(whisperx_app.torch.cuda, "is_available", lambda: True)
    assert _settings(monkeypatch).resolved_device() == "cuda"
    assert _settings(monkeypatch, WHISPERX_DEVICE="cpu").resolved_device() == "cpu"


def test_the_environment_overrides_every_setting(monkeypatch):
    s = _settings(
        monkeypatch,
        WHISPERX_BATCH_SIZE="8",
        WHISPER_MODEL="large-v3",
        HF_TOKEN="hf_x",
        WHISPERX_MAX_UPLOAD_MB="1",
        WHISPERX_TORCH_DEVICE="cpu",
        SERVICES_API_KEY="k",
    )
    assert (s.whisperx_batch_size, s.whisper_model, s.hf_token) == (
        8,
        "large-v3",
        "hf_x",
    )
    assert s.max_upload_bytes == 1024 * 1024
    assert (s.whisperx_torch_device, s.services_api_key) == ("cpu", "k")


# ── the huggingface_hub keyword shim ─────────────────────────────────


def test_use_auth_token_is_forwarded_as_token(monkeypatch):
    calls = []
    hub = whisperx_app.huggingface_hub
    monkeypatch.setattr(
        hub.file_download, "hf_hub_download", lambda *a, **k: calls.append(k)
    )
    whisperx_app._patch_hf_hub_download_kwarg()
    hub.hf_hub_download("repo", use_auth_token="secret")
    assert calls == [{"token": "secret"}]


# ── the key middleware ───────────────────────────────────────────────


def _client(api_key):
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    from fastapi.testclient import TestClient

    bare = FastAPI()
    bare.add_middleware(APIKeyMiddleware, api_key=api_key)

    @bare.get("/health")
    def health():
        return {"ok": True}

    @bare.get("/transcribe")
    def transcribe():
        return {"ok": True}

    return TestClient(bare)


def test_a_configured_key_guards_everything_but_health():
    client = _client("s3cret")
    assert client.get("/health").status_code == 200
    assert client.get("/transcribe").status_code == 401
    assert client.get("/transcribe", headers={"X-API-Key": "nope"}).status_code == 401
    assert client.get("/transcribe", headers={"X-API-Key": "s3cret"}).status_code == 200


def test_no_key_means_open():
    assert _client("").get("/transcribe").status_code == 200


# ── the endpoints before any model is loaded ─────────────────────────


@pytest.fixture
def client():
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    from fastapi.testclient import TestClient

    # No context manager: the startup hook never runs, so no model is loaded.
    return TestClient(whisperx_app.app)


def _audio():
    return {"file": ("clip.wav", io.BytesIO(b"RIFF" + b"\0" * 64), "audio/wav")}


def test_health_reports_the_configuration(client):
    body = client.get("/health").json()
    assert body == {
        "status": "ok",
        "device": whisperx_app.DEVICE,
        "torch_device": whisperx_app.TORCH_DEVICE,
        "model": whisperx_app.WHISPER_MODEL,
        "diarization": False,
    }


def test_transcribe_requires_a_file(client):
    assert client.post("/transcribe", data={"language": "nl"}).status_code == 422


def test_transcribe_rejects_a_non_integer_speaker_count(client):
    res = client.post("/transcribe", files=_audio(), data={"min_speakers": "two"})
    assert res.status_code == 422


def test_transcribe_is_a_503_until_the_model_is_loaded(client):
    res = client.post("/transcribe", files=_audio())
    assert res.status_code == 503
    assert res.json()["detail"] == "Models not loaded yet"


def test_diarize_is_a_503_without_a_diarization_pipeline(client):
    res = client.post("/diarize", files=_audio())
    assert res.status_code == 503


def test_transcribe_refuses_an_oversized_upload(client, monkeypatch):
    monkeypatch.setattr(whisperx_app, "whisper_model", object())
    monkeypatch.setattr(whisperx_app, "MAX_UPLOAD_BYTES", 8)
    res = client.post("/transcribe", files=_audio())
    assert res.status_code == 413
