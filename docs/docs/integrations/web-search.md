---
title: Web search
---

# Web search

Bee Flow exposes a single agent tool — `agent_search` — backed by one of three providers. Pick one in **Admin → Integrations → Zoeken**:

| Provider | Where the search loop runs | Needs | Best for |
|---|---|---|---|
| **Self-hosted (Agent Search + Serper)** | A separate GPU service (`SEARCH_SERVICE_URL`) that does SERP + page fetch + embed + rerank + cleanup on its own hardware. | Serper.dev API key + a self-hosted search-service deployment | Highest throughput, full control of every inference step |
| **Cloud-only (Serper + provider APIs)** | This Node.js server. SERP via Serper, page fetch in-process, embed/rerank/cleanup via your configured providers (Mistral, OpenAI, Cohere, Azure) or the in-process CPU models. | Serper.dev API key + a configured chat/embedding provider | No GPU box required; runs on a small VPS |
| **Azure Bing Web Search** | Azure Bing v7 API. Snippet-only — no page fetch / cleanup. | Azure Bing key | Compliance-driven deployments where Microsoft is the only allowed cloud |
| **Disabled** | — | — | Lock down `agent_search` entirely |

The agent always calls the same tool name, so swapping providers is invisible to skills, agents, and routines.

## Setup — Cloud-only (recommended for self-hosted)

1. Get a Serper.dev API key at [serper.dev](https://serper.dev/).
2. **Admin → Integrations → Zoeken** → Search Provider: **Cloud-only (Serper + provider APIs)**.
3. Paste the Serper key.
4. **Admin → AI Configuratie → Web Search Inference**:
   - **Embeddings**: pick a model (or leave empty to inherit the global Embeddings setting).
   - **Reranking**: pick `Cosine similarity` (no extra model), `CPU cross-encoder` (in-process Transformers.js, recommended for self-hosted), `Provider model` (LLM-as-rerank), or `Disabled`.
   - **Webpage cleanup**: pick a chat model that converts raw scraped HTML to compact markdown (e.g. `Ministral 3B` for speed).

## Setup — Self-hosted Agent Search service

1. Set `SEARCH_SERVICE_URL` env var on the server (e.g. `https://services.beeflow.nl`).
2. **Admin → Integrations → Zoeken** → Search Provider: **Self-hosted (Agent Search + Serper)**.
3. Paste the Serper.dev API key. The search-service uses it for SERP retrieval; embeddings / reranking happen on the GPU box.

## Setup — Bing

1. Subscribe to Microsoft Bing Search v7 in Azure.
2. **Admin → Integrations → Zoeken** → Search Provider: **Azure Bing Web Search**.
3. Paste the Azure subscription key. Optionally set a market (e.g. `nl-NL` for Dutch results).

## Search modes

The `agent_search` tool accepts a `mode` argument that controls how much work the pipeline does:

| Mode | Behavior | Latency | Tokens returned |
|---|---|---|---|
| `web` (default) | Full pipeline: SERP → fetch top-N → embed → rerank → cleanup → return | ~2 s | ~2000 |
| `web_fast` | Snippet-only — no page fetch, no rerank, no cleanup | ~1 s | ~1500 |
| `kb` | Search the knowledge base only (no web call) | &lt;500 ms | varies |
| `auto` | KB first, fall back to web if no high-confidence match | varies | varies |

`web_fast` is intended for trivial single-fact lookups. The agent picks the mode automatically based on the query — admin defaults live under **Admin → Integrations → Zoeken → Agent Search Default Options**.

## How "Cloud-only" works under the hood

The cloud-only path is implemented entirely in the Node.js server ([`server/integrations/nodeSearchTools.js`](https://github.com/Bee-Flow/beeflow/blob/main/server/integrations/nodeSearchTools.js)) — no Python, no GPU, no external orchestrator:

1. Serper returns the top-N organic results (URLs + titles + snippets).
2. Top pages are fetched in parallel via `fetch()` with size and content-type guards.
3. Pages are stripped of `<script>` / `<style>` / nav, then embedded by the configured provider.
4. Rerank step orders the candidates (cosine on embeddings, CPU cross-encoder, or LLM-as-rerank).
5. Cleanup model converts HTML to compact markdown for the agent's context.
6. Results are returned in the same shape as the GPU path — agents don't see a difference.

Output markdown is tagged `**Mode:** web (cloud)` so admins can verify which path actually ran.

## Verifying which provider ran

Open any agent message that used `agent_search`, expand "How I got this answer", look at the markdown header inside the tool result:

- `**Mode:** web (cloud)` — Cloud-only ran.
- `**Mode:** web` (no `(cloud)` suffix) — Self-hosted Agent Search service ran.
- `**Provider:** Bing Web Search` — Bing ran.

In server logs:

| Provider | Log prefix |
|---|---|
| Self-hosted | `[AgentSearch]` |
| Cloud-only | `[NodeSearch]` |
| Bing | `[BingSearch]` |

## Privacy

Web results pass through the Privacy Shield (`piiDetectionEnabled` in [Privacy Shield](../features/privacy-shield.md) config) before injection into the agent's prompt. Detected entities are tokenised so the model never sees raw PII — useful when search returns news articles with names, emails, phone numbers, IBANs etc.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Serper API key not configured` | Cloud-only / Self-hosted picked, no Serper key | Set in **Admin → Integrations → Zoeken**. |
| `Search returned 0 results` | Serper quota exhausted / overly narrow query | Check Serper dashboard; agent retries with different keywords. |
| `Bing Search API error (403)` | Azure subscription expired | Renew Azure subscription. |
| `Bing Search API error (429)` | Provider rate-limited | Raise tier or switch provider. |
| `Provider rerank failed; returning original order` | LLM-as-rerank model unreachable | Pick a different rerank method. CPU cross-encoder works without any provider. |
