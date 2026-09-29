# classify-service

Zero-shot text classification for the Condition node's **"is about"** rule. The
Node server sends an item's text (an email body, a file name, a form answer)
together with the plain-language labels used in that node, for example
"a complaint" or "an invoice". It gets back a score between 0 and 1 for every
label.

- **Model:** [`knowledgator/gliclass-multilang-mini`](https://huggingface.co/knowledgator/gliclass-multilang-mini)
  (Apache-2.0), loaded with the [`gliclass`](https://github.com/Knowledgator/GLiClass)
  library (Apache-2.0, pinned at 0.1.20). It is multilingual, and the labels and
  the text do not have to be in the same language.
- **CPU only.** There is no GPU variant and no CUDA anywhere: torch comes from
  PyTorch's CPU wheel index, and the model is loaded with `device="cpu"`.
- **Port 8300.** 8200 is taken by pii-service.

## Where the image comes from

The image is built **only by CI**: the `classify` job in
`.github/workflows/build-push-ghcr.yml` publishes `ghcr.io/bee-flow/classify:<tag>`
(`:dev` from main, `:latest`/`:prod` on a prod release). It is never built on a
developer machine: `scripts/build-images.sh` and `.ps1` skip it and say so,
and the compose files pull it rather than build it.

The model is baked into the image when CI builds it (`scripts/bake_model.py`).
Production pods have no egress, so nothing is downloaded at runtime; the image
sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`. The bake resolves the
requested revision to a commit sha, downloads exactly that snapshot to
`/opt/model`, and classifies one sentence of its own. If the obvious label does
not win, the build fails: a checkpoint whose weights did not load still runs,
so running is not the test. The bake writes `/opt/model/BAKED.json` (model id,
resolved revision, gliclass version), and `/health` reports that file.

Build args: `CLASSIFY_MODEL` (default `knowledgator/gliclass-multilang-mini`),
`CLASSIFY_MODEL_REVISION` (default `0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b`;
the eval in `eval/` confirms or replaces it), and `CLASSIFY_BUILD_ID` (CI passes
the git sha). The model is public, so the build needs no Hugging Face token.

## Running it

```
docker compose -f docker-compose.from-registry.yml --profile classify up -d classify-service
```

Then point the server at it with `CLASSIFY_SERVICE_URL=http://classify-service:8300`
(and `CLASSIFY_SERVICE_API_KEY` when a key is set). `./selfhost.sh` does this
when the `classify` profile is on. The compose service runs with a read-only
root filesystem and a tmpfs on `/tmp`, capped at `CLASSIFY_CPUS` (default 3, what the eval measured) and
`CLASSIFY_MEM` (default 3g: peak 2.2 GB at the service's batch of 4, plus 30%;
see `eval/MODEL-DECISIONS.md`).

## On Kubernetes

The service is a plain container, so it runs as its own Deployment and Service
next to the server: give it the same CPU and memory caps as the compose service
above and point the server at it with `CLASSIFY_SERVICE_URL`. Bee Flow's own
hosted deployment of it lives in a private repository, not in this one.

## API

All request models reject unknown fields (`extra="forbid"`), so a field this
build does not know is a 422, never silently dropped.

### `POST /classify`

Request:

```json
{ "texts": ["Mijn factuur klopt niet"], "labels": ["an invoice", "a complaint"], "threshold": 0.75 }
```

| Field | Rule |
|---|---|
| `texts` | 1 to 32 strings. A long text keeps its start and its end: first cut to `CLASSIFY_MAX_CHARS` characters, then to `CLASSIFY_MAX_TOKENS` tokens (the last 128 of them from the end). |
| `labels` | 1 to 16 strings. Each is trimmed, must be 1 to 100 characters, must be unique after trimming, and may not contain the prompt markers `<<LABEL>>`, `<<SEP>>` or `<<EXAMPLE>>`. |
| `threshold` | Optional, `0 < t < 1`. When sent, every result also carries `matched`. |

Response (`200`):

```json
{
  "results": [
    { "scores": { "an invoice": 0.9412, "a complaint": 0.6021 }, "truncated": false, "matched": ["an invoice", "a complaint"] }
  ],
  "labels": ["an invoice", "a complaint"],
  "model": "knowledgator/gliclass-multilang-mini",
  "revision": "0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b",
  "engine": "gliclass-multilang-mini@0bd888b6c3ef/gliclass-0.1.20/3f9a0c1e",
  "default_threshold": 0.75,
  "ms": 184.2
}
```

- `results` is aligned with `texts`. `scores` has every label, in request order,
  rounded to 4 decimals. Each score is the label's own sigmoid, so they do not
  sum to 1 and several labels can match.
- `truncated` is true when the model saw less than the whole text: the
  character cut, or the model's 512-token window (the label prompt counts
  towards it; the tokenizer decides).
- `matched` (only when `threshold` was sent) lists the labels whose rounded
  score is at or above it, so it always agrees with `scores`.
- `engine` identifies everything that decides a score: model, revision and
  gliclass version, readable, plus a short digest of the label mode, both
  truncation limits, the dtype and the image build. Key any score cache on it.
- `default_threshold` is `CLASSIFY_DEFAULT_THRESHOLD`; the caller decides.

Errors:

| Status | Body | When |
|---|---|---|
| 401 | `{"error": "Invalid or missing API key"}` | A key is configured and `X-API-Key` does not match. |
| 413 | `{"detail": "body_too_large"}` | The body is over 256 KB (declared or streamed). |
| 422 | FastAPI validation detail | Any rule above is broken. |
| 429 | `{"detail": "busy"}` | `CLASSIFY_MAX_CONCURRENCY` requests are running and `CLASSIFY_MAX_QUEUE` more are waiting. Retry. |
| 503 | `{"detail": "model_loading"}` / `{"detail": "model_error"}` | The model is still loading, or its load failed (it keeps retrying). |
| 500 | `{"detail": "inference_error"}` | The model raised during scoring. |

### `GET /health`

Service identity and limits: `status` (`ok`, `loading` or `error`), `service`,
`version` (API contract), `backend` (`torch-cpu`), `model`, `revision`,
`engine`, `default_threshold`, `max_labels` (16), `max_texts` (32),
`max_chars`, `label_mode` and `load_error`. It answers 503 until the model is
loaded. It never needs a key.

### `GET /ready`

200 once the model is loaded, 503 before, with the same body as `/health`.
Like guard-service, it needs the key when one is configured (only `/health`
is exempt).

## Configuration

All variables carry the `CLASSIFY_` prefix.

| Variable | Default | Meaning |
|---|---|---|
| `CLASSIFY_API_KEY` | (empty) | Required `X-API-Key`. Falls back to `SERVICES_API_KEY`; with neither set the service is open (it binds to 127.0.0.1 and the compose network). |
| `CLASSIFY_LABEL_MODE` | `joint` | `joint`: all labels in one pass per text. `independent`: one pass per label, so no label's score depends on the others, at labels-times the cost. |
| `CLASSIFY_DEFAULT_THRESHOLD` | `0.75` | Reported to callers; the eval's dev best (`eval/MODEL-DECISIONS.md`). |
| `CLASSIFY_MAX_CHARS` | `4000` | Characters kept per text before tokenizing (start, plus the last 1000). |
| `CLASSIFY_MAX_TOKENS` | `512` | Tokens of text the model reads: the first 384 and the last 128. More text scored worse in the eval. |
| `CLASSIFY_MAX_LENGTH` | `1024` | The model's whole sequence: the label prompt plus the text. |
| `CLASSIFY_MAX_CONCURRENCY` | `1` | Requests scored at once. |
| `CLASSIFY_MAX_QUEUE` | `8` | Requests allowed to wait; past that, 429. |
| `CLASSIFY_MAX_BODY_BYTES` | `262144` | Body limit (413 above it). |
| `CLASSIFY_DTYPE` | `float32` | `float32` or `bfloat16`. The checkpoint is stored as bf16; float32 is the CPU default. |
| `CLASSIFY_MODEL_DIR` | `/opt/model` | Where the baked snapshot lives. |
| `CLASSIFY_LOG_LEVEL` | `INFO` | |

Threads: the BLAS/OpenMP pools and `torch.set_num_threads` are sized from the
cgroup CPU quota (`app/cpu.py`), not the node's core count, and
`torch.set_num_interop_threads(1)`. Inference runs in a worker thread, so a
long pass never blocks `/health`. One uvicorn worker: the model and the
admission gate are per process.

## Privacy

This service reads customer text. It scores it and drops it.

- Logs carry counts, lengths, timings and exception **class** names only; never
  a text, a label, a score or an exception message (a tokenizer error can quote
  its input). `tests/test_logging_privacy.py` drives every path (scored,
  invalid, not ready, failed, busy, too large) with a distinctive text and
  fails if any log record contains it.
- Nothing is stored, cached or sent anywhere. The container has no volume and
  needs no egress.
- The request carries only what the model needs: texts and labels. No user,
  organisation or item identifiers are part of the contract.

## Tests

The suite needs no torch, no gliclass and no model: `tests/conftest.py` swaps
in a FakeClassifier, and `tests/test_classifier.py` drives the real adapter
with a stand-in that returns gliclass's own result shape.

```
pip install -r classify-service/requirements-dev.txt
python -m pytest classify-service/tests --cov=classify-service/app
ruff check classify-service && ruff format --check classify-service
```

CI runs this in the `python-tests` and `python-lint` jobs of `ci.yml`, with a
line-coverage floor in `.coverage-ratchet.json`.
