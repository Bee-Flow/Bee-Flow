FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

WORKDIR /app

# CPU ONLY. This service runs on CPU everywhere; there is no GPU variant.
# torch comes from PyTorch's CPU wheel index and ONLY from there
# (--index-url, not --extra-index-url), so no CUDA wheel can ever resolve.
# Pinned to the version guard-service ships.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.14.0+cpu --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# The Hugging Face cache sits in /tmp: the bake below only passes through it
# (the snapshot lands in /opt/model), and at runtime /tmp is the one writable
# path (compose runs this image read_only with a tmpfs there).
ENV HF_HOME=/tmp/huggingface

# Runtime user: uid 1000, no home directory. /opt/model stays root-owned and
# read-only to it.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app

# Bake the model into the image. Production pods are egress-blocked, so the
# weights are never fetched at runtime; this layer is the only download.
#
# TODO(Phase 0): the eval (eval/MODEL-DECISIONS.md) confirms this revision.
# If it adopts another sha, change the default here and in app/config.py
# (DEFAULT_REVISION) together.
ARG CLASSIFY_MODEL=knowledgator/gliclass-multilang-mini
ARG CLASSIFY_MODEL_REVISION=0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b
COPY scripts/bake_model.py /tmp/bake_model.py
RUN CLASSIFY_MODEL_DIR=/opt/model python /tmp/bake_model.py \
    && rm -rf /tmp/bake_model.py /tmp/huggingface

COPY . .

# Image identity, mixed into the engine fingerprint callers key score caches
# on. CI passes the git sha. Declared AFTER `COPY . .` on purpose: a
# per-commit value above the bake would invalidate that layer and re-download
# the model on every build.
ARG CLASSIFY_BUILD_ID=dev
ENV CLASSIFY_BUILD_ID=${CLASSIFY_BUILD_ID}

# Offline from here on: a missing file is a load error, never a download.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CLASSIFY_MODEL_DIR=/opt/model

USER app

EXPOSE 8300

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8300/health')" || exit 1

# One worker: the model is loaded once per process, and the admission gate in
# app/limits.py is per process too.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8300", "--workers", "1"]
