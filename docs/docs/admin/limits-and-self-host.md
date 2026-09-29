---
title: Limits & Self-host
---

# Limits & Self-host

Admin → AI Configuratie → **Limits & Self-host** is the home for runtime caps and self-hosting routing decisions. Use it to:

- Cap how many tool-call rounds a chat turn may consume.
- Choose between in-process (local) and remote (search-service) knowledge-base storage.
- Toggle the in-process CPU cross-encoder reranker.

A **Setup status** card at the top of the page shows what's currently configured — embedding model, web-search provider, KB provider, CPU reranker — and offers one-click links to the tabs that control each.

## Tool calls per chat turn

Single integer (1–50, default per-surface). Caps the number of tool-call **rounds** the model may run before it must produce a final answer. A round is one model turn that emits tool calls; the model can call multiple tools in parallel within a round.

| Surface | Built-in default (when input is empty) |
|---|---|
| Direct chat | 5 |
| Notebook chat | 5 |
| Webpage chat | 10 |
| Native streaming loop | 10 |

When the input has a value, **all four surfaces use that value uniformly**. Background agents (AI tasks, swarm workers, browser agent, automation builder) keep their own internal limits — they're out of scope here.

When the cap is hit, the run is logged as a `max_iterations` termination and the model is forced to write its final answer.

## Knowledge-base provider

Where KB chunk ingestion + retrieval happens.

| Setting | Behavior |
|---|---|
| **Auto** (default) | Local in-process pipeline if no `SEARCH_SERVICE_URL` env var is set, remote service if it is. Safe default for both fresh installs and upgrades. |
| **Local (in-process)** | Chunk + embed + store + retrieve all happen inside the Node server using pgvector. Embeddings come from your configured global Embeddings model (or the in-process CPU embedder as fallback). Reranking uses Azure Cohere if configured, then the CPU cross-encoder, then RRF. |
| **Remote search-service** | Forward `/kb/ingest/json` and `/tools/kb-search` to an external `SEARCH_SERVICE_URL` (e.g. `https://services.beeflow.nl`). Required for legacy GPU-backed deployments. |

### Switching providers when KBs already have data

KB chunks live in different stores depending on which provider was active when they were ingested:

- Chunks ingested under **Local** live in the local Postgres `kb_chunks` table (`vector(N)` matching the embedding model dim).
- Chunks ingested under **Remote** live on the remote search-service's database.

Switching provider does **not** migrate data automatically. To use existing remote-ingested KBs locally, re-upload the source documents while `kb_provider = local`. The 64-chunk-per-doc default keeps re-ingest fast.

### Vector dim reconciliation

When the configured embedding model changes (e.g. mistral-embed at 1024-dim → text-embedding-3-small at 1536-dim), the local pipeline auto-detects the dim from the first batch and reconciles `kb_chunks.embedding`:

- Empty table → `ALTER COLUMN embedding TYPE VECTOR(N)` + recreate HNSW index.
- Populated table at a different dim → log a warning and let the INSERT fail with a clear pgvector error. Fix: truncate the table and re-ingest.

## In-process CPU cross-encoder reranker

Checkbox. Default **on** for fresh installs.

When enabled, KB search and the cloud-only web search use [`Xenova/bge-reranker-base`](https://huggingface.co/BAAI/bge-reranker-base) (MIT, ~280 MB, in-process via `@huggingface/transformers`). First call downloads the model (~5–10 s); subsequent calls run locally with no network round-trip (~50–200 ms for 5–10 docs on a 4-core box).

Order of preference inside KB search:

1. **Azure Cohere reranker** — if `azure_reranker_endpoint` + key are configured, used exclusively.
2. **CPU cross-encoder** — when this toggle is enabled and Azure is not.
3. **Local GPU vLLM sidecar** — if `RERANKER_URL` env var is set, used after CPU.
4. **RRF passthrough** — if all of the above are unavailable.

Disabling this toggle skips step 2 entirely; useful when you have a faster GPU sidecar or when CPU pressure on the host is a concern.

## Setup status card

The status block at the top of the page rolls up four indicators:

| Row | Source | Click target |
|---|---|---|
| **Embedding model (global)** | `ai.embeddingProviderId` / `ai.embeddingModel` | → Embeddings tab |
| **Web search provider** | `search_provider` | → Web Search Inference tab. Warns in amber when the chosen provider's prerequisites are missing (e.g. Serper key for cloud-only). |
| **KB provider** | `kb_provider` | (display only) |
| **CPU cross-encoder reranker** | `cpu_reranker_enabled` | (display only) |

Use it to verify a self-hosted deployment in one glance: all rows green = ready to ingest and chat without any GPU service.

## Underlying config keys

For SRE / ops who want to set these via SQL or scripts:

| Admin field | configStore key | Type | Range |
|---|---|---|---|
| Tool calls per chat turn | `max_tool_rounds_chat` | integer or null | 1–50 |
| KB provider | `kb_provider` | `'local'` / `'remote'` / null (auto) | — |
| CPU reranker enabled | `cpu_reranker_enabled` | boolean | default true |
