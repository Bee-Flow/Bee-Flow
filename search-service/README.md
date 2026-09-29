# Agent Search Engine

A standalone, low-latency **Search Tool API** for AI agents. Returns clean, structured markdown with citations from:

1. **Web** — Serper.dev (Google Search API) + fetch + extract + AI cleanup
2. **Internal Knowledge Bases** — PostgreSQL hybrid search (vector + keyword + rerank)

## Quick Start

```bash
# 1. Copy environment config
cp .env.example .env

# 2. Start services (without GPU/inference)
docker compose up -d

# 3. Check health
curl http://localhost:8000/health

# 4. Search the web
curl -X POST http://localhost:8000/tools/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "python fastapi best practices", "mode": "web"}'
```

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Serper.dev  │     │  PostgreSQL  │     │    Redis     │
│ (Google API) │     │  (pgvector)  │     │   (cache)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────┬───────┴────────────────────┘
                    │
            ┌───────┴───────┐
            │  Search API   │
            │   (FastAPI)   │
            └───────┬───────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
   ┌────┴────┐ ┌────┴────┐ ┌───┴────┐
   │Embeddings│ │Reranker │ │Cleanup │
   │ bge-m3  │ │bge-rerank││Qwen2.5 │
   └─────────┘ └─────────┘ └────────┘
        (optional vLLM inference)
```

## API

### `POST /tools/search`

Main search endpoint. See `app/models.py` for full request/response schema.

### `POST /kb/ingest`

Ingest documents (PDF or text) into the knowledge base.

### `GET /health`

Basic health check.

### `GET /health/detailed`

Health check with dependency status and p95 latency stats.

## Configuration

All config is via environment variables with `SEARCH_` prefix.
See `.env.example` for all available options.

## Dev console (`ui/`)

`ui/` is an optional Vite/vanilla-JS test console for exercising the API by
hand — it is not part of any Docker image or deployment.

```bash
cd ui
npm install
npm run dev     # http://localhost:5180, proxies /api → http://localhost:8000
```

## Enabling GPU Inference

1. Uncomment the inference services in `docker-compose.yml`
2. Set `SEARCH_INFERENCE_ENABLED=true` in `.env`
3. Ensure NVIDIA Container Toolkit is installed on the host
4. Run `docker compose up -d`
