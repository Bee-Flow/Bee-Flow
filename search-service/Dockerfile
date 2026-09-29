FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9

WORKDIR /app

# System dependencies for lxml, pymupdf
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies from the lock, with hashes: a rebuild of this
# Dockerfile a year from now resolves to the same wheels. `--locked` fails
# the build when pyproject.toml and uv.lock disagree, so the pins can never
# have two answers. uv rides in on a bind mount, keeping the binary out of
# the shipped image.
COPY pyproject.toml uv.lock ./
RUN --mount=type=bind,from=ghcr.io/astral-sh/uv:0.8.17@sha256:e4644cb5bd56fdc2c5ea3ee0525d9d21eed1603bccd6a21f887a938be7e85be1,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv export --locked --no-dev --format requirements-txt -o /tmp/requirements.txt \
    && uv pip install --system --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Application code
COPY app/ app/

# Non-root user
RUN useradd -m appuser
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
