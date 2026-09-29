# Guard Service — PII Detection

CPU-based PII detection sidecar for Bee Flow's Privacy Shield. Detects
personal data in text with **GLiNER** (default model
`E3-JSI/gliner-multi-pii-domains-v1`, run via ONNX Runtime), backed by a
region-aware regex/validator tier for structured identifiers (IBAN, BSN, …).
The Bee Flow server calls it through `PII_SERVICE_URL`
(`server/core/privacy/piiDetection.js`) and probes its health through
`GUARD_SERVICE_URL`.

Stack: Python 3.12 / FastAPI. No GPU required.

## Endpoints

- `GET /health` — liveness + model state
- `GET /ready` — readiness (model loaded)
- `POST /pii` — detect PII in text
  - Request: `text`, optional `confidence_threshold` (default 0.7),
    `enabled_categories`, `enabled_regions` (ISO 3166-1 alpha-2)
  - Response: `hasPii`, `entities[]` (`text`, `category`, `label`,
    `confidence`, `offset`, `length`), plus `degraded` / `degraded_reason`
    when the result may be incomplete
  - Optional `custom_labels` (since 2.3.0): up to 6 organisation-defined
    kinds of data, `[{ "id": "cdt_<10 hex>", "prompt": "internal project code
    name", "floor": 0.5 }]`. The prompt (2 to 60 printable characters, no
    `<<` or `>>`, unique case-insensitively) is what GLiNER reads; the id is
    what comes back. `floor` (0.10 to 0.99) is the acceptance floor at the
    default slider, shifted by `confidence_threshold` like a built-in one.
    Their spans come back in a separate `custom_entities[]` (same shape, with
    `category` = `label` = the id and `source: "model_custom"`), resolved
    among themselves; `entities` is byte-identical with or without them, and
    `custom_entities` is absent from the response when none were sent. A failed
    custom pass lists its ids in `degraded_categories`. With custom labels,
    `enabled_categories: []` means "no built-in categories"; on its own `[]`
    still means all of them. Prompts are never logged; ids and counts are.
- `POST /pii/probe` — raw candidates for tuning custom labels
  - Request: `texts` (1 to 8, each at most 4,000 characters) and `label_set`
    (`{ "cdt_…": "prompt" }`, 1 to 6, same rules as above). Nothing else.
  - Response: `candidates[]` (`text_idx`, `label`, `start`, `end`, `score`)
    at the model's query floor (0.10) after word-edge repair, and
    `model_ready`. No floors, no overlap resolution, no cache, no global
    state: the caller fits a floor to these scores. 503 when the model is not
    ready or a pass failed.
- `POST /disclosure` — does this text tell its reader that AI was involved?
  - Request: `text`. Nothing else is accepted (422) — no agent id, no
    organisation, nothing that says whose text it is.
  - Response: `disclosed` (**three-valued**: `true` / `false` / `null`),
    `similarity`, `margin`, `matched_anchor` (an id of one of the service's
    own anchor sentences, never a fragment of the input), `segments`,
    `degraded` / `degraded_reason`, `engine_fingerprint`
  - **`null` is "no opinion", never "no disclosure"** — it is what an unbaked
    encoder, an oversize input, a failed encode and a too-close-to-call
    comparison all return, and the Node client
    (`server/core/privacy/disclosureClassifier.js`) leaves the Art. 50 keyword
    rule untouched on every one of them.

When `SERVICES_API_KEY` is set, every request must send it as an `X-API-Key`
header; `/health` stays open.

## Configuration

Settings live in `app/config.py` (pydantic-settings, env prefix `GUARD_`).
The most commonly set ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `GUARD_PII_MODEL` | `E3-JSI/gliner-multi-pii-domains-v1` | GLiNER model id |
| `GUARD_REDIS_URL` | `redis://localhost:6379/1` | Decision cache |
| `GUARD_PII_MAX_CONCURRENCY` | `2` | Concurrent `/pii` requests admitted |
| `GUARD_PII_REGIONS` | `*` | Active country patterns for the regex tier |
| `GUARD_PII_REGEX_TIER` | `on` | Regex tier on/off |
| `SERVICES_API_KEY` | empty | API key (empty = no auth) |
| `GUARD_DISCLOSURE_MODEL_DIR` | `/opt/disclosure-encoder` | Where the optional disclosure encoder is baked |
| `GUARD_DISCLOSURE_ENABLED` | `true` | Whether `/disclosure` may answer at all |
| `GUARD_DISCLOSURE_FLOOR` / `_MARGIN` | `0.45` / `0.06` | Verdict thresholds (see `services/disclosure/similarity.py`) |

### The AI-disclosure classifier is OPT-IN and absent by default

`/disclosure` exists in every build, but **the default image bakes no sentence
encoder**, so it answers `disclosed: null` on every call. That is the intended
resting state: the EU AI Act Art. 50 check on the Node side keeps using its
keyword rule, exactly as it did before this endpoint existed, and a self-hosted
workspace with no guard at all behaves identically.

Bake the encoder only if you want it — it adds ~470MB to the image:

```bash
docker build \
  --build-arg GUARD_DISCLOSURE_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \
  -t guard:with-disclosure .
```

The classifier is an embedding nearest-neighbour over a fixed bank of labelled
sentences (`app/services/disclosure/anchors.py`) — deterministic, no
generation, no prompt. Its verdict may only ever **withdraw** a keyword match
on the Node side, never grant one; the reasoning is in the header of
`server/core/privacy/disclosureClassifier.js`.

## Run

```bash
cd guard-service
docker compose up --build     # API on :8100 + guard-redis
```

In the full stack it runs as the `guard` compose profile
(`ghcr.io/bee-flow/guard`, container `beeflow-guard`, port 8100) — see
`docker-compose.from-registry.yml` at the repo root. The Dockerfile bakes the
ONNX graph into the image at build time, so there is no model download at
runtime.

## Tests and eval

Model-free unit tests (mirrors the guard job in `.github/workflows/ci.yml`):

```bash
cd guard-service
pip install 'pydantic>=2' 'pydantic-settings>=2'
python -m unittest discover -s tests
```

The PII eval harness (corpus generation, regex-tier gate, model eval) is
documented in [eval/README.md](./eval/README.md); CI runs it on every PR that
touches `guard-service/`.

## Layout

```
app/
├── main.py            FastAPI app, health/ready, API-key middleware
├── config.py          Settings (GUARD_ env prefix)
├── routers/pii.py     POST /pii, POST /pii/probe
├── routers/disclosure.py  POST /disclosure
└── services/          pii/ (GLiNER pipeline), pii_regex/ (regex tier, per country), pii_bsn.py,
                       pii_validators.py, disclosure/ (anchors + encoder)
tests/                 Model-free unit tests (unittest, FakeGliner)
eval/                  PII eval harness + corpus (see eval/README.md)
scripts/               ONNX export/quantize, benchmarks
tools/                 Maintenance checks
```
