# Reranker Service

Lightweight CPU cross-encoder that reranks knowledge-base search candidates
for Bee Flow. Single-file FastAPI service ([reranker.py](./reranker.py)),
default model `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`.

Two inference backends, picked at startup:

- **ONNX Runtime** — used when `MODEL_DIR/model.onnx` exists. The Dockerfile
  exports the model to ONNX in a builder stage, so the shipped image runs
  without torch.
- **sentence-transformers** — local-dev fallback that auto-downloads the
  model when no ONNX graph is present.

The Bee Flow server uses it when `RERANKER_URL` is set (optional — KB search
works without it, just without cross-encoder reranking).

## Endpoints

- `GET /health` — status + active backend
- `POST /rerank`
  - Request: `query`, `documents[]`, optional `top_n`
  - Response: `results[]` (`index`, `relevance_score`), `model`,
    `latency_ms`, `backend`

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `RERANK_MODEL` | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | Model id |
| `PORT` | `8000` | Listen port |
| `MODEL_DIR` | `/app/model` | Where the ONNX export lives |
| `ORT_THREADS` | `0` (auto) | ONNX Runtime intra/inter-op threads |

## Run

```bash
# Docker (exports the model to ONNX during the build)
docker build -t beeflow-reranker reranker/

# Local dev (sentence-transformers backend — not a declared dependency)
cd reranker
uv sync --frozen              # exactly the versions in uv.lock
uv pip install sentence-transformers torch --extra-index-url https://download.pytorch.org/whl/cpu
uv run python reranker.py     # http://localhost:8000
```

In the full stack it is built as `ghcr.io/bee-flow/reranker`
(`./scripts/build-images.sh build dev reranker` from the repo root) and runs
as the `reranker` service in the root `docker-compose.yml` (container
`beeflow-reranker`, internal port 8000, no host port).

## Tests

There is no test suite for this service yet; `GET /health` reports the loaded
model and backend for a quick smoke check.
