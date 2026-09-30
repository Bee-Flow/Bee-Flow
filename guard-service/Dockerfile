FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# PyTorch CPU (lightweight — GLiNER PII NER + the fp32 PyTorch fallback path)
# Pinned like gliner in requirements.txt: the eval baselines record the torch
# version, and an unpinned install moved it underneath them. The +cpu local
# version exists only on the PyTorch index, so this can never resolve to the
# CUDA build on PyPI.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.14.0+cpu --extra-index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# The Hugging Face cache lives outside any home directory: the build-time
# export fills it, and the runtime user (who has no home) reads and, for a
# model that is not baked, writes it.
ENV HF_HOME=/cache/huggingface

# Runtime user: uid 1000, no home directory. The baked graphs under /opt are
# read-only to it; the cache is the only path it owns.
# Created HERE, while /cache is still empty, so the RUNs that fill the cache
# can hand it over in the same layer that writes it. A `chown -R /cache` in a
# later RUN copies every file it touches into a new layer: after `COPY . .`
# that was a second copy of the downloaded model (~1 GB) on every code change.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /cache/huggingface \
    && chown -R app:app /cache

# Pre-download the PII model and export the fp32 ONNX graph at build time.
# The service prefers the ONNX graph at /opt/gliner-onnx for ONNX-runtime CPU
# speed at FULL fp32 recall. We deliberately do NOT INT8-quantize — that
# collapsed person-name recall (BFSF-269); see scripts/export_onnx.py.
#
# GUARD_PII_MODEL is a build-arg so the baked ONNX and the runtime config
# reference the SAME model id. We also set it as an ENV so the runtime
# default matches what was baked — keep any deploy-time GUARD_PII_MODEL
# override in sync with this value, otherwise the runtime prefers the
# baked graph and the override is silently ignored (BFSF-269).
ARG GUARD_PII_MODEL=E3-JSI/gliner-multi-pii-domains-v1
ENV GUARD_PII_MODEL=${GUARD_PII_MODEL}
COPY scripts/export_onnx.py /tmp/export_onnx.py
# The export runs as root (it writes /opt) and downloads into the cache as
# root; the chown is in this RUN so the cache lands in ONE layer, owned by app.
RUN python /tmp/export_onnx.py && rm /tmp/export_onnx.py \
    && chown -R app:app /cache

# OPTIONAL: the AI-disclosure sentence encoder. EMPTY BY DEFAULT — the default
# image downloads nothing here and is byte-identical to what it was. Set the
# build arg to bake it (~470MB) and /disclosure starts answering; leave it and
# /disclosure answers "no opinion", which is what the Node side expects and
# what keeps the Art. 50 keyword rule the offline answer it has always been.
#   --build-arg GUARD_DISCLOSURE_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
# ARG only, NOT ENV: an empty ENV GUARD_DISCLOSURE_MODEL would shadow the
# pydantic-settings default at runtime with "", and a build arg is already
# visible as an env var to the RUN below.
ARG GUARD_DISCLOSURE_MODEL=
COPY scripts/export_disclosure_encoder.py /tmp/export_disclosure_encoder.py
# Only the files this download added are handed over: a blanket chown -R
# would copy the GLiNER cache from the layer above into this one as well.
RUN if [ -n "$GUARD_DISCLOSURE_MODEL" ]; then \
        python /tmp/export_disclosure_encoder.py \
        && find /cache \( ! -user app -o ! -group app \) -exec chown -h app:app {} +; \
    else \
        echo "[build] GUARD_DISCLOSURE_MODEL unset — no disclosure encoder baked"; \
    fi; \
    rm /tmp/export_disclosure_encoder.py

COPY . .

# Image identity, surfaced in the engine fingerprint that callers key their
# scan caches on. CI passes the git sha; a local build leaves it "dev".
# Declared AFTER `COPY . .` on purpose: a per-commit value above the model
# export would invalidate that layer (and re-download the model) every build.
ARG GUARD_BUILD_ID=dev
# Doubled prefix on purpose: Settings reads every field with env_prefix
# "GUARD_", so the field guard_build_id comes from GUARD_GUARD_BUILD_ID.
ENV GUARD_GUARD_BUILD_ID=${GUARD_BUILD_ID}

USER app

ENV PYTHONUNBUFFERED=1

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
