FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

WORKDIR /app

# Debian security updates published after the pinned base digest (openssl,
# pcre2, ...). The release container gate (.github/security/) fails on any
# fixable HIGH/CRITICAL finding, so a stale base blocks the release.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# CPU ONLY. This service runs on CPU everywhere; there is no GPU variant.
# torch comes from PyTorch's CPU wheel index and ONLY from there
# (--index-url, not --extra-index-url), so no CUDA wheel can ever resolve.
# Pinned to the version guard-service ships.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.14.0+cpu --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# The base image's setuptools 78.1.0 carries its own CVE plus vendored copies
# of wheel 0.45.1 and jaraco.context 5.3.0 that have theirs. 84.0.0 vendors
# wheel 0.46.3 and jaraco.context 6.1.0, the fixed versions.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install setuptools==84.0.0

# The Hugging Face cache sits in /tmp: the bake below only passes through it
# (the snapshot lands in /opt/model), and at runtime /tmp is the one writable
# path (compose runs this image read_only with a tmpfs there).
ENV HF_HOME=/tmp/huggingface

# Runtime user: uid 1000, no home directory. /opt/model stays root-owned and
# read-only to it.
# Then the hardening server/Dockerfile does, for the same Debian advisories
# without a trixie fix: remove the CLIs they are reached through and every
# SUID/SGID bit. The reviews in .github/security/container-exceptions.json
# rely on this, and scripts/check-release-container.sh asserts it on the
# exact release digest.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && rm -f /usr/bin/mount /usr/bin/umount /usr/bin/nsenter /usr/bin/infocmp \
    && find /usr -type f -path '*/Archive/Tar*' -delete \
    && find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +

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
