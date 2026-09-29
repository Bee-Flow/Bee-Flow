# WhisperX Transcription Service

Self-hosted transcription using **WhisperX + pyannote.audio 3.1**.

## Prerequisites
- Docker with NVIDIA Container Toolkit (for GPU) or plain Docker (CPU mode)
- Hugging Face token with access to `pyannote/speaker-diarization-3.1`

## Quick Start

```bash
# Set your Hugging Face token
export HF_TOKEN=hf_your_token_here

# Build and start (GPU)
docker compose up --build -d

# Or for CPU-only (edit docker-compose.yml — remove the deploy.resources section)
docker compose up --build -d
```

## Endpoints

- `GET /health` — Check service status
- `POST /transcribe` — Transcribe audio file
  - `file`: audio file (multipart)
  - `language`: language code (default: `nl`)
  - `diarize`: enable speaker diarization (default: `true`)
  - `context_terms`: comma-separated terms for better accuracy
  - `min_speakers` / `max_speakers`: optional speaker count hints

## Performance

| Setup | Speed (vs real-time) |
|-------|---------------------|
| GPU (RTX 3090+) | ~0.1-0.3x (3-10x faster than real-time) |
| CPU (8 cores) | ~4-10x real-time |
