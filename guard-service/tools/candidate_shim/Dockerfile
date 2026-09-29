# Scratch image for measuring a GLiNER2 candidate model behind the /pii
# contract. Built FROM the guard image so app/ (regex tier, validators,
# _finalise) is importable — the fuse mode measures the candidate inside the
# REAL arbitration. The gliner2 dependency lives ONLY here: taking it into
# guard-service/requirements.txt is an adoption decision (phase CD), made with
# the measured delta in hand, never a side effect of the experiment.
#
# Build (from guard-service/):
#   docker build -t candidate-shim:fastino -f tools/candidate_shim/Dockerfile .
# Run:
#   docker run --rm -p 8199:8199 candidate-shim:fastino
# The first start downloads the model (~1.2GB) from HF into the container.

FROM ghcr.io/bee-flow/guard:dev

RUN pip install --no-cache-dir gliner2

COPY tools/candidate_shim/app.py /app/candidate_shim.py
COPY eval/candidate_maps/ /app/eval/candidate_maps/

ENV CANDIDATE_MODEL=fastino/gliner2-privacy-filter-PII-multi
ENV CANDIDATE_MAP=/app/eval/candidate_maps/fastino.json

EXPOSE 8199
CMD ["uvicorn", "candidate_shim:app", "--host", "0.0.0.0", "--port", "8199"]
