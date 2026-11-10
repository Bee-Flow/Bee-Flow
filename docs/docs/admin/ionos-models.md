---
title: IONOS models (EU, Germany)
---

# IONOS AI Model Hub

The IONOS AI Model Hub is a German, EU-hosted inference service for open-weight models,
billed per token. The API is OpenAI-compatible, so there is nothing to deploy: you add an
API token and the models appear in the tier picker. It is the one provider here that
covers all three jobs of a knowledge base: **chat, embeddings and reranking**.

|  | Where inference runs | Cost | Ops |
|---|---|---|---|
| [Local models](./local-models.md) | Your own hardware | €0 per token | You run the GPU |
| [Scaleway](./scaleway-models.md) | Scaleway, EU (FR/NL) | Per 1M tokens | None |
| **IONOS** | IONOS, Germany (Berlin) | Per 1M tokens | None |
| OpenAI / Anthropic / Google | Mostly outside the EU | Per 1M tokens | None |

## Connect it

1. In the IONOS Data Center Designer (DCD), create an API token for the AI Model Hub. See the
   [IONOS documentation](https://docs.ionos.com/cloud/ai/ai-model-hub).
2. Go to **Admin → AI Config → API Keys** and paste it into the **IONOS** card.

The provider is created automatically and the live model list is read from IONOS on the
next request. The endpoint is
`https://openai.inference.de-txl.ionos.com/v1`, the only region IONOS offers.

## The models

The list Bee Flow shows is the one the API reports. Prices are EUR per 1M tokens,
excluding VAT (IONOS price list, 9 November 2026).

| Model | Category | Input | Output |
|---|---|---|---|
| `Qwen3.5 9B` | Reasoning, vision, tools | 0.10 | 0.15 |
| `Qwen3.8 27B` | Reasoning, vision, tools | 0.40 | 2.70 |
| `Qwen3.5 397B A17B` | Reasoning, vision, tools | 0.60 | 3.60 |
| `Mistral Small 24B` | Vision | 0.10 | 0.30 |
| `gpt-oss 120B` | Reasoning | 0.15 | 0.65 |
| `Llama 3.3 70B Instruct` | General | 0.65 | 0.65 |
| `Qwen3 Coder Next 80B` | Code | 0.15 | 0.80 |
| `LightOnOCR 2` | Vision, OCR | 0.15 | 0.30 |
| `BAAI/bge-m3` | Embedding (1024 dims) | 0.02 | n/a |
| `Qwen3-VL Embedding 8B` | Embedding | 0.10 | n/a |
| `Qwen/Qwen3-VL-Reranker-8B` | Rerank | 0.04 | n/a |

Model ids are matched by a normalised name, so a suffix such as `-Instruct` or `-fp8` does
not matter. A model that IONOS serves but Bee Flow does not know yet is still usable, but
carries no price: Bee Flow never guesses one. Usage is billed at IONOS's own tariff and
shows up in **Admin → Monitoring**.

## Embeddings

Choose **IONOS** as the embedding provider under **Admin → AI Config → Embeddings**;
only the models IONOS flags as embedding models are listed.

Use **`BAAI/bge-m3`** (1024 dimensions). `Qwen3-VL-Embedding-8B` produces more dimensions
than the 2000-dimension limit of the vector index, so it cannot be used for a knowledge
base. Changing the embedding model re-indexes your knowledge bases in the background;
until that finishes, search uses keywords only.

## Reranking

Reranking reorders the knowledge-base search results with a dedicated model. IONOS
serves one through an OpenAI/Cohere-style `/rerank` endpoint.

1. Make sure the IONOS card above is connected.
2. Under **Reranker → Provider (OpenAI/Cohere-style /rerank)**, pick the IONOS provider
   and the model `Qwen/Qwen3-VL-Reranker-8B`.
3. Save. Provider and model are stored together; the tier is active only when both are set.
   **Turn off** clears both.

The rerank chain tries, in order: local llama.cpp (when enabled), the provider tier
above, Azure Cohere, the CPU reranker, the GPU sidecar, and finally plain rank fusion. The
first one that is configured and answers wins, so a failing provider falls through to the
next instead of breaking search.

## Troubleshooting

**No models appear.** The model list is read live, so an empty list means the token was
rejected or the endpoint was unreachable. Check the server log for
`[IONOS] /v1/models failed`.

**A model shows no price.** It is not in Bee Flow's catalog yet. It works, but its cost is
not counted until the catalog knows it.
