"""
WhisperX Transcription Service — FastAPI wrapper for WhisperX + pyannote.audio

Exposes POST /transcribe that accepts audio files and returns diarized transcriptions
in the same format as Voxtral, making it a drop-in alternative.
"""

import logging
import os
import tempfile
import time
from typing import Optional

import huggingface_hub
import huggingface_hub.file_download
from pydantic_settings import BaseSettings, SettingsConfigDict


def _patch_hf_hub_download_kwarg() -> None:
    """pyannote.audio passes the deprecated `use_auth_token` to hf_hub_download,
    which newer huggingface_hub only accepts as `token`. Applied before any
    import that could reach the hub."""
    orig_download = huggingface_hub.file_download.hf_hub_download

    def patched_download(*args, **kwargs):
        if "use_auth_token" in kwargs:
            kwargs["token"] = kwargs.pop("use_auth_token")
        return orig_download(*args, **kwargs)

    huggingface_hub.file_download.hf_hub_download = patched_download
    huggingface_hub.hf_hub_download = patched_download

    if hasattr(huggingface_hub, "cached_download"):
        orig_cached = huggingface_hub.cached_download

        def patched_cached(*args, **kwargs):
            if "use_auth_token" in kwargs:
                kwargs["token"] = kwargs.pop("use_auth_token")
            return orig_cached(*args, **kwargs)

        huggingface_hub.cached_download = patched_cached


_patch_hf_hub_download_kwarg()

import torch
import whisperx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisperx-service")


# ── Configuration ────────────────────────────────────────────────
class Settings(BaseSettings):
    """Read once from the environment; the names are the variables as deployed."""

    services_api_key: str = ""
    # Empty means "cuda when torch sees a GPU, else cpu" — see resolved_device.
    whisperx_device: str = ""
    # The alignment (wav2vec2) and diarization (pyannote) stages are plain
    # PyTorch; on some ROCm targets they must run on the CPU while CTranslate2
    # transcribes on the GPU. Empty means "same device as transcription".
    whisperx_torch_device: str = ""
    whisperx_batch_size: int = 4
    # medium: ~1.5GB VRAM on a shared L4, still strong for Dutch; large-v3 is 4GB.
    whisper_model: str = "medium"
    hf_token: str = ""
    whisperx_max_upload_mb: int = 500

    model_config = SettingsConfigDict(extra="ignore")

    def resolved_device(self) -> str:
        return self.whisperx_device or ("cuda" if torch.cuda.is_available() else "cpu")

    @property
    def max_upload_bytes(self) -> int:
        return self.whisperx_max_upload_mb * 1024 * 1024


settings = Settings()
DEVICE = settings.resolved_device()
COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"
TORCH_DEVICE = settings.whisperx_torch_device or DEVICE
BATCH_SIZE = settings.whisperx_batch_size
WHISPER_MODEL = settings.whisper_model
HF_TOKEN = settings.hf_token
MAX_UPLOAD_BYTES = settings.max_upload_bytes

logger.info(
    f"Device: {DEVICE}, Compute: {COMPUTE_TYPE}, Torch: {TORCH_DEVICE}, Model: {WHISPER_MODEL}"
)

app = FastAPI(title="WhisperX Transcription Service", version="1.0.0")


# ── API Key authentication middleware ────────────────────────────────
class APIKeyMiddleware(BaseHTTPMiddleware):
    """Require X-API-Key on every request except /health once a key is configured."""

    def __init__(self, app, api_key: str = "") -> None:
        super().__init__(app)
        self._api_key = api_key

    async def dispatch(self, request, call_next):
        if not self._api_key:
            return await call_next(request)
        if request.url.path.startswith("/health"):
            return await call_next(request)
        key = request.headers.get("X-API-Key", "")
        if key != self._api_key:
            return JSONResponse(
                {"error": "Invalid or missing API key"}, status_code=401
            )
        return await call_next(request)


if settings.services_api_key:
    app.add_middleware(APIKeyMiddleware, api_key=settings.services_api_key)


async def _read_bounded(file: UploadFile, max_bytes: int | None = None) -> bytes:
    """Read an upload up to ``max_bytes``; anything larger is a 413 instead of a memory spike."""
    limit = MAX_UPLOAD_BYTES if max_bytes is None else max_bytes
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds {limit // (1024 * 1024)} MB",
            )
        chunks.append(chunk)
    return b"".join(chunks)


# ── Load models at startup ───────────────────────────────────────
whisper_model = None
diarize_model = None


def _load_diarization_pipeline(token: str, device: str):
    """whisperx's own DiarizationPipeline loads the pyannote model, places it
    on the device and handles auth; its location and auth kwarg have drifted
    across releases, so probe for the supported shape."""
    try:
        from whisperx.diarize import DiarizationPipeline
    except ImportError:
        DiarizationPipeline = whisperx.DiarizationPipeline
    try:
        return DiarizationPipeline(token=token, device=device)
    except TypeError:
        return DiarizationPipeline(use_auth_token=token, device=device)


@app.on_event("startup")
async def load_models():
    global whisper_model, diarize_model
    logger.info(f"Loading Whisper model '{WHISPER_MODEL}' on {DEVICE}...")
    load_kwargs = {"device": DEVICE, "compute_type": COMPUTE_TYPE}
    # WhisperX's default VAD is a pyannote model placed on the transcription
    # device; when the torch stages are pinned elsewhere, build it there too
    # (vad_model takes priority over vad_method). The token rides along explicitly.
    if TORCH_DEVICE != DEVICE:
        from whisperx.vads import Pyannote

        load_kwargs["vad_model"] = Pyannote(
            torch.device(TORCH_DEVICE),
            token=HF_TOKEN or None,
            vad_onset=0.500,
            vad_offset=0.363,
        )
        logger.info(f"VAD pinned to {TORCH_DEVICE} (gfx1151 torch fallback).")
    whisper_model = whisperx.load_model(WHISPER_MODEL, **load_kwargs)
    logger.info("Whisper model loaded.")

    if HF_TOKEN:
        logger.info("Loading pyannote diarization pipeline...")
        try:
            diarize_model = _load_diarization_pipeline(HF_TOKEN, TORCH_DEVICE)
            logger.info("Diarization pipeline loaded.")
        except Exception as e:
            logger.error(f"Failed to load diarization: {e}")
            logger.warning("Continuing without diarization.")
    else:
        logger.warning("HF_TOKEN not set — diarization disabled.")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "torch_device": TORCH_DEVICE,
        "model": WHISPER_MODEL,
        "diarization": diarize_model is not None,
    }


@app.post("/diarize")
async def diarize_only(
    file: UploadFile = File(...),
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(None),
):
    """
    Speaker diarization only — no transcription. Returns the speaker turns for
    an audio file so a caller can attach speakers to a transcript produced
    elsewhere (e.g. a cloud Whisper). Reuses the already-loaded pyannote
    pipeline (on TORCH_DEVICE), so there is no per-request model load and no
    CTranslate2/alignment cost.
    """
    if diarize_model is None:
        raise HTTPException(
            status_code=503, detail="Diarization not available (no HF_TOKEN?)"
        )

    start_time = time.time()
    content = await _read_bounded(file)
    logger.info(
        f"[/diarize] Received '{file.filename}' ({len(content) / (1024 * 1024):.1f} MB)"
    )
    with tempfile.NamedTemporaryFile(
        suffix=os.path.splitext(file.filename or ".mp3")[1], delete=False
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        audio = whisperx.load_audio(tmp_path)
        kwargs = {}
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        diarize_df = diarize_model(audio, **kwargs)
        turns = [
            {
                "start": round(float(row.start), 2),
                "end": round(float(row.end), 2),
                "speaker": str(row.speaker).replace("SPEAKER_", "speaker_"),
            }
            for row in diarize_df.itertuples()
        ]
        elapsed = time.time() - start_time
        audio_duration = len(audio) / 16000
        logger.info(
            f"[/diarize] {len(turns)} turns in {elapsed:.1f}s "
            f"(audio: {audio_duration:.0f}s, ratio: {elapsed / max(audio_duration, 1):.2f}x)"
        )
        return JSONResponse(
            {
                "speakers": turns,
                "duration": round(audio_duration, 2),
                "processingTime": round(elapsed, 2),
            }
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.post("/transcribe")
async def transcribe(  # noqa: C901, PLR0912, PLR0913, PLR0915
    file: UploadFile = File(...),
    language: str = Form("nl"),
    diarize: bool = Form(True),
    context_terms: str = Form(""),
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(None),
):
    """
    Transcribe an audio file with optional speaker diarization.
    Returns segments with speaker IDs, timestamps, and full text.
    """
    if whisper_model is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet")

    start_time = time.time()

    # Save uploaded file to temp
    content = await _read_bounded(file)
    logger.info(
        f"Received '{file.filename}' ({len(content) / (1024 * 1024):.1f} MB), lang={language}"
    )

    with tempfile.NamedTemporaryFile(
        suffix=os.path.splitext(file.filename or ".mp3")[1], delete=False
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # 1. Load audio
        audio = whisperx.load_audio(tmp_path)
        logger.info(f"Audio loaded: {len(audio) / 16000:.1f}s")

        # 2. Transcribe with Whisper
        # whisperx >= 3.4 dropped per-call initial_prompt; the glossary now
        # lives in the model's load-time asr_options. Requests are serial
        # (single worker), so mutate the option in place per request; degrade
        # gracefully if the options object shape differs across versions.
        if context_terms:
            try:
                whisper_model.options = whisper_model.options._replace(
                    initial_prompt=context_terms
                )
            except Exception as opt_err:
                logger.warning(f"Could not set glossary initial_prompt: {opt_err}")

        try:
            result = whisper_model.transcribe(
                audio,
                batch_size=BATCH_SIZE,
                language=language,
            )
        except (IndexError, StopIteration) as e:
            # VAD found no speech segments → empty transcription (not an error)
            logger.warning(f"No speech detected in audio: {e}")
            elapsed = time.time() - start_time
            audio_duration = len(audio) / 16000
            return JSONResponse(
                {
                    "text": "",
                    "segments": [],
                    "language": language,
                    "duration": round(audio_duration, 2),
                    "processingTime": round(elapsed, 2),
                    "device": DEVICE,
                    "model": WHISPER_MODEL,
                    "warning": "No speech detected in the audio",
                }
            )
        logger.info(
            f"Transcription complete: {len(result.get('segments', []))} segments"
        )

        # 3. Align timestamps at word level
        try:
            align_model, metadata = whisperx.load_align_model(
                language_code=language,
                device=TORCH_DEVICE,
            )
            result = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                TORCH_DEVICE,
                return_char_alignments=False,
            )
            logger.info("Word-level alignment complete")
            # Free align model memory
            del align_model
            if TORCH_DEVICE == "cuda":
                torch.cuda.empty_cache()
        except Exception as align_err:
            logger.warning(f"Alignment failed (proceeding without): {align_err}")

        # 4. Speaker diarization
        if diarize and diarize_model is not None:
            try:
                diarize_kwargs = {}
                if min_speakers is not None:
                    diarize_kwargs["min_speakers"] = min_speakers
                if max_speakers is not None:
                    diarize_kwargs["max_speakers"] = max_speakers

                diarize_segments = diarize_model(audio, **diarize_kwargs)
                result = whisperx.assign_word_speakers(diarize_segments, result)
                logger.info("Speaker diarization complete")
            except Exception as diarize_err:
                logger.warning(
                    f"Diarization failed (proceeding without): {diarize_err}"
                )

        # 5. Format response to match Voxtral output shape
        segments = []
        full_text_parts = []

        for seg in result.get("segments", []):
            speaker = seg.get("speaker", "speaker_0") or "speaker_0"
            text = (seg.get("text") or "").strip()
            start = seg.get("start", 0)
            end = seg.get("end", 0)

            if text:
                segments.append(
                    {
                        "text": text,
                        "start": round(start, 2),
                        "end": round(end, 2),
                        "speakerId": speaker.replace("SPEAKER_", "speaker_"),
                    }
                )
                full_text_parts.append(text)

        elapsed = time.time() - start_time
        audio_duration = len(audio) / 16000

        logger.info(
            f"Done in {elapsed:.1f}s (audio: {audio_duration:.0f}s, "
            f"ratio: {elapsed / audio_duration:.2f}x, segments: {len(segments)})"
        )

        return JSONResponse(
            {
                "text": " ".join(full_text_parts),
                "segments": segments,
                "language": language,
                "duration": round(audio_duration, 2),
                "processingTime": round(elapsed, 2),
                "device": DEVICE,
                "model": WHISPER_MODEL,
            }
        )

    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8787)
