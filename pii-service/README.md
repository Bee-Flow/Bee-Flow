# PII Detection Service

Standalone PII detection service using the Hugging Face model
`betterdataai/PII_DETECTION_MODEL` — a generative model (Qwen2-0.5B) that
tags PII categories such as `<iban>`, `<email>`, `<name>`, `<phone_number>`
in a structured prompt/response format. CPU-only by default; a GPU variant
ships as `Dockerfile.gpu` + `requirements.gpu.txt`.

This is the generic-model alternative to [`../guard-service`](../guard-service/README.md)
(GLiNER + regex tiers), which is the primary Privacy Shield detector.

Stack: Python 3.11 / FastAPI.

## Endpoints

- `GET /health` — status + `model_ready`
- `POST /pii` — detect PII in text
  - Request: `text`, optional `confidence_threshold` (default 0.7),
    `enabled_categories` (null = all)
  - Response: `hasPii`, `entities[]` (`text`, `category`, `label`,
    `confidence`, `offset`, `length`)

When `SERVICES_API_KEY` is set, `POST /pii` requires it as an `X-API-Key`
header (empty = no auth).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PII_MODEL` | `betterdataai/PII_DETECTION_MODEL` | Hugging Face model id |
| `SERVICES_API_KEY` | empty | API key for `POST /pii` (empty = no auth) |

See [.env.example](./.env.example).

## Run

In the full stack it runs as the `pii` compose profile
(`ghcr.io/bee-flow/pii`, container `beeflow-pii`, port 8200) — see
`docker-compose.from-registry.yml` at the repo root. The model weights are
cached in the `pii-model-cache` volume.

## Tests

The parser tests exercise the pure output-parsing path only (no model load,
no torch), so they run anywhere:

```bash
pip install pytest
pytest pii-service/tests/test_parse_output.py    # from the repo root
```

## Layout

```
app/
├── main.py       FastAPI app: /health, /pii, API-key check
└── service.py    Model load + prompt/parse pipeline
tests/            pytest (parser offsets, no model required)
Dockerfile        CPU image (port 8200)
Dockerfile.gpu    CUDA image + requirements.gpu.txt
```
