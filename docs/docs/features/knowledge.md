---
title: Knowledge bases
---

# Knowledge bases

A **Knowledge Base** (KB) is a collection of documents the assistant can search. Upload PDFs, Markdown, Word, plain text or HTML, paste text, point at a web page, or draw on a table or a meeting tag — Bee Flow chunks, embeds, indexes, and serves citations.

## Two backends

KB ingestion + retrieval can run in either of two backends. Both expose the same `kb_search` tool to agents — choice is invisible to skills and routines.

| Backend | Storage | Pipeline | Best for |
|---|---|---|---|
| **Local (in-process)** — default | Postgres `kb_chunks` table with pgvector | Chunk + embed via global provider (or CPU fallback) + pgvector + BM25 (FTS) + RRF + reranker | Self-hosted setups, no GPU box |
| **Remote search-service** | External Postgres / Qdrant on the search-service host | Same pipeline but on a dedicated GPU machine | High-throughput tenants, BGE-M3 GPU embeddings |

Pick under **Admin → AI Configuratie → Limits & Self-host → Knowledge-base provider** (Auto / Local / Remote). See [Limits & Self-host](../admin/limits-and-self-host.md) for switching, vector-dim reconciliation, and re-ingest semantics.

## Embedding model

Picked under **Admin → AI Configuratie → Embeddings**. Common choices:

| Model | Provider | Dim | Notes |
|---|---|---|---|
| `mistral-embed` | Mistral | 1024 | Multilingual, default for most self-hosted setups |
| `text-embedding-3-small` | OpenAI / Azure OpenAI | 1536 | English-strong |
| `text-embedding-3-large` | OpenAI / Azure OpenAI | 3072 | Best quality, more expensive |
| `multilingual-e5-small` | In-process CPU (Xenova) | 384 | Used as fallback when no provider is configured. MIT, ~470 MB on disk |

The Web Search Inference panel can override per-feature so web-search and KB can use different embed models if needed.

## Chunking

Documents are sliced with a sliding window:

| Knob | Default | Env var | Also read (pre-rename) |
|------|---------|---------|------------------------|
| Per-chunk token cap | 800 tokens | `KB_PER_CHUNK_TOKENS` | `EMAIL_KB_PER_CHUNK_TOKENS` |
| Total tokens injected into prompt | 4000 | `KB_INJECT_TOKENS` | `EMAIL_KB_INJECT_TOKENS` |

The `EMAIL_KB_*` names are the pre-rename spelling of the same two knobs and are still read, so an operator who tuned those does not silently fall back to the defaults on upgrade. The new name wins when both are set.

After chunking, the ingestion pipeline:

1. Hashes each chunk for content dedup — byte-identical content is skipped.
2. Computes a 64-bit simhash and treats a document within **Hamming distance 3** of an existing one as a near-duplicate. This threshold is a hard-coded default, not an env var; the ingest caller decides what to do with a hit (`skip` keeps the first, `replace` keeps the latest, `merge` folds them into one entry).
3. Embeds via the configured embedding model (provider → CPU fallback).
4. Inserts into `kb_chunks` (or upserts the remote search-service index when `kb_provider = remote`).

Re-ingesting an unchanged document is a no-op. The local pipeline auto-detects the embedding dim on first ingest and ALTERs `kb_chunks.embedding` to match — no manual schema migration when switching models, as long as the table is empty or you re-ingest existing docs.

## Supported file types

| Format | Notes |
|--------|-------|
| PDF | Layout-aware extraction. Falls back to LLM-based extraction for scanned PDFs. |
| Plain text (.txt) | UTF-8 expected. |
| Markdown (.md) | Headings preserved as chunk anchors. |
| HTML | Stripped of `<script>` / `<style>`; whitespace normalised. |
| Email (.eml) | Headers and body extracted separately; `From:` / `Subject:` / `Date:` retained as metadata. |
| Word (.docx) | Paragraph and heading-aware. |
| CSV | Each row becomes a small chunk with column headers prefixed. |
| URL (web page) | Fetched, HTML-cleaned, then ingested as HTML. |

Source kinds that can be created today are: pasted text, uploaded files, a web page, a meeting tag and a table. A **Nextcloud folder** source is planned but not yet available — its button in Studio is deliberately visible and disabled rather than hidden.

Uploads in Studio are capped at 20 files at a time, 20 MB each; files over the limit are named and refused in the browser rather than 413'd. The API's own JSON body limit is 20 MB and is not configurable by environment variable.

## How a search runs

There is **no search mode to choose** — not per instance, not per knowledge base, not per query. Every search is the same pipeline, and the only thing your configuration changes is which reranker it can reach.

1. **Vector and keyword retrieval run in parallel**, always. The vector leg is a pgvector cosine scan; the keyword leg is a Postgres full-text query, tried as an AND-join first and retried as an OR-join when AND finds nothing. Neither leg is optional: a failure in one is logged and returns no rows, and the other still answers. The vector leg is simply absent if pgvector is unavailable or the query could not be embedded.
2. **The two result sets are fused with RRF** (Reciprocal Rank Fusion) into one ranking, with a table-of-contents demotion and a heading boost applied on top.
3. **The top candidates go through the reranker chain**, in a fixed order of preference: Azure Cohere reranker → in-process CPU cross-encoder → local GPU sidecar (`RERANKER_URL`). Each falls through to the next on failure, and if none is reachable the RRF ordering is used as-is.

So keyword retrieval and reranking are not features you switch on. The CPU cross-encoder is on unless an admin sets `cpu_reranker_enabled = false`; everything else about the ordering is automatic. The remote search-service backend runs the same pipeline — vector + full-text → merge → dedupe → rerank.

Search is preceded by a **greeting guard**, not by a query rewrite: a turn that is *only* a greeting or small talk ("hi", "goedemorgen", "thanks", "how are you") skips the knowledge lookup altogether and the agent answers naturally — including in strict-knowledge mode, where the "no results" prompt would be confusing for a simple "hi". Anything else is searched as the person wrote it; the query is not cleaned or reworded.

The pattern is deliberately broad in both English and Dutch. A false negative costs one unnecessary search; a false positive would hide a real question.

## Citations

Sources are returned to the agent as numbered blocks:

```
### Source 1: Q3-2025-Report.pdf
…3 sentences from the chunk…

### Source 2: Strategy-meeting-notes.md
…3 sentences…
```

If the agent's `config.includeSourceReferences = true`, citations are rendered as a separate UI block (cards) below the answer, and the agent is instructed not to inline `[1]`-style markers in prose.

Click a citation card to jump to the original document.

![KB-cited reply with source cards](../img/screenshots/features/knowledge-citations/)

## Which KBs a turn may search

An agent's bases are the ones on its own configuration (`config.knowledge_base_ids`), picked in the agent's Knowledge panel. A direct chat can also carry its own bases (`direct_conversations.knowledge_base_ids`), attached from the knowledge pill in the composer. There is no message-prefix syntax for pinning a base for a single turn.

Before retrieval, the list is narrowed by **who is asking** — and this can only ever *remove* bases. A base is searched only for someone who may see it; everyone else gets the same answer with that base left out, never an error. An unauthenticated visitor to an embedded agent has no identity to evaluate, so the rule shifts rather than the identity: of the bases the owner chose, only the ones their organisation published to itself may face the public internet. A draft is unfinished, and a group-restricted base was restricted on purpose.

## Operational notes

- **Switching embedding model**: the embedding model is an instance-wide setting, not a per-KB one, and changing it does not re-embed anything by itself. Existing chunks keep the vectors they were written with; re-ingest the documents to move them to the new model. (A `knowledge_bases.embedding_model` column exists from an earlier design and no longer decides which model is used.)
- **Storage**: the embedding is the part you can compute exactly — 4 bytes per dimension, so 4 KB per chunk at 1024 dims and 1.5 KB at 384 (the CPU fallback). The chunk text itself varies with your documents; at the 800-token cap, budget a few KB. Treat any total as an order of magnitude, not a quote.
- **Cost**: embedding is charged per token by whichever provider you configured, so the bill scales with how much you ingest and re-ingest — there is no flat figure. Self-hosted and CPU-fallback embedding cost nothing per call.
- **Privacy**: chunks live alongside your Postgres. Nothing is sent to the embedding provider beyond the chunk text — no metadata, no IDs.

## Where to next

- [Studio → Knowledge bases](../studio/knowledge-bases.md) — UI walkthrough.
- [Privacy shield](privacy-shield.md) — what's redacted before chunks reach the embedding provider.
