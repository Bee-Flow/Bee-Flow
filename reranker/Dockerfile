# ── Stage 1: Export model to ONNX ────────────────────────────────────
FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9 AS builder

WORKDIR /build

# Install export toolchain (torch is needed only here for conversion)
RUN pip install --no-cache-dir \
    optimum[onnxruntime] \
    transformers \
    torch --extra-index-url https://download.pytorch.org/whl/cpu

# Export the cross-encoder to ONNX format
ARG MODEL_NAME=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
RUN --mount=type=secret,id=HF_TOKEN \
    HF_TOKEN=$(cat /run/secrets/HF_TOKEN 2>/dev/null || echo "") \
    optimum-cli export onnx \
    --model "${MODEL_NAME}" \
    --task text-classification \
    /build/model

# ── Stage 2: Lightweight runtime ────────────────────────────────────
FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9

WORKDIR /app

# Install only runtime dependencies (no torch!) from the lock, with hashes:
# a rebuild of this Dockerfile a year from now resolves to the same wheels.
# `--locked` fails the build when pyproject.toml and uv.lock disagree, so the
# pins can never have two answers. uv rides in on a bind mount, keeping the
# binary out of the shipped image.
COPY pyproject.toml uv.lock ./
RUN --mount=type=bind,from=ghcr.io/astral-sh/uv:0.8.17@sha256:e4644cb5bd56fdc2c5ea3ee0525d9d21eed1603bccd6a21f887a938be7e85be1,source=/uv,target=/usr/local/bin/uv \
    uv export --locked --no-dev --format requirements-txt -o /tmp/requirements.txt \
    && uv pip install --system --no-cache --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Copy the pre-exported ONNX model + tokenizer from builder
COPY --from=builder /build/model /app/model

# Copy the server
COPY reranker.py .

# Non-root user
RUN useradd -m appuser
USER appuser

EXPOSE 8000

CMD ["python", "reranker.py"]
