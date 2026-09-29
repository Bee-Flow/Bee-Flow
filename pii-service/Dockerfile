FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9

WORKDIR /app

# Install Python dependencies only (fast build — no model download)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Model is downloaded at first startup into the mounted cache volume:
#   docker run -v pii-model-cache:/cache/huggingface beeflow-pii:latest
ENV HF_HOME=/cache/huggingface
ENV TRANSFORMERS_CACHE=/cache/huggingface

# Runtime user: uid 1000, no home directory. The model cache is the only
# path it owns, so a first-start download still lands.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /cache/huggingface \
    && chown -R app:app /cache
USER app

EXPOSE 8200

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
