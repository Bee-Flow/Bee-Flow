FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04@sha256:8bbc6e304b193e84327fa30d93eea70ec0213b808239a46602a919a479a73b12

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip \
    ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

# Make python3.11 the default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

WORKDIR /app

# Install Python dependencies from the lock, with hashes: a rebuild of this
# Dockerfile a year from now resolves to the same wheels. `--locked` fails
# the build when pyproject.toml and uv.lock disagree, so the pins can never
# have two answers. uv rides in on a bind mount, keeping the binary out of
# the shipped image. The interpreter is named outright because the base
# image also carries Ubuntu's own python3.10, and the model pre-download
# below runs under python3.11.
COPY pyproject.toml uv.lock ./
RUN --mount=type=bind,from=ghcr.io/astral-sh/uv:0.8.17@sha256:e4644cb5bd56fdc2c5ea3ee0525d9d21eed1603bccd6a21f887a938be7e85be1,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv export --locked --no-dev --format requirements-txt -o /tmp/requirements.txt \
    && uv pip install --system --python python3.11 --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Every model cache lives under /cache, outside any home directory: the
# build-time download below fills it, and the runtime user (who has no home)
# writes the alignment and diarization models there on first use.
# Mount the persistent volume at /cache (formerly /root/.cache).
ENV HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    XDG_CACHE_HOME=/cache \
    MPLCONFIGDIR=/cache/matplotlib

# Runtime user: uid 1000, no home directory. /cache is the only path it owns.
# Created HERE, while /cache is still empty, so the pre-download below writes
# it in ONE layer, already owned by app. A `chown -R /cache` after the download
# copies every file it touches into a new layer — with large-v3 that was a
# second ~3 GB copy of the model baked into the image.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /cache/huggingface /cache/torch /cache/matplotlib \
    && chown -R app:app /cache

# Pre-download Whisper model at build time (saves startup time). Runs as the
# runtime user so the cache lands owned by app with no chown pass at all.
ARG WHISPER_MODEL=large-v3
USER app
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')" || true

COPY app.py .

EXPOSE 8787

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8787"]
