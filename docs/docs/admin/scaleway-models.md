---
title: Scaleway models (EU serverless)
---

# Scaleway Generative APIs

Scaleway's Generative APIs are serverless endpoints for open-weight models, hosted in
European data centres and billed per token. There is nothing to deploy and nothing to
keep running — you add an API key and the models appear in the tier picker.

It sits between the two options either side of it:

|  | Where inference runs | Cost | Ops |
|---|---|---|---|
| [Local models](./local-models.md) | Your own hardware | €0 per token | You run the GPU |
| **Scaleway** | Scaleway, EU (FR/NL) | Per 1M tokens | None |
| OpenAI / Anthropic / Google | Mostly outside the EU | Per 1M tokens | None |

The models are open-weight (Qwen, Mistral, Gemma, GLM, DeepSeek, Llama, gpt-oss), so the
same weights you would self-host are available without buying GPUs — and prompts stay
inside the EU.

## Connect it

1. Create an API key in the [Scaleway console](https://console.scaleway.com/iam/api-keys)
   — Generative APIs uses your **secret key**.
2. Go to **Admin → AI configuration → API keys** and paste it into the **Scaleway** card.

That is the whole setup. The provider is created automatically, the live model list is
read from Scaleway on the next request, and the models become selectable in the chat
model tiers, in agents, and as a knowledge-base embedding provider.

:::tip One key, two features
This is the same key as **Admin → Integrations → Transcription (Scaleway)**. A Scaleway
secret key opens every Scaleway API, so configuring it in either place enables both the
chat models and Whisper transcription.
:::

### Scoping the key to one project

By default calls go to `https://api.scaleway.ai/v1`, which uses your default Scaleway
Project. To pin them to a specific project, set the endpoint to
`https://api.scaleway.ai/<project-id>/v1` — Bee Flow accepts the project-scoped form
anywhere the account-wide one is accepted.

## The models

Scaleway adds and retires serverless models continuously, so the list Bee Flow shows is
the one the API reports, not a list baked into the release. As of August 2026:

| Model | Category | Context | Notes |
|---|---|---|---|
| `glm-5.2` | Reasoning | 256k | Long-horizon agentic tasks and coding |
| `deepseek-v4-flash-0731` | Reasoning | 256k | Cheapest reasoning tier; discounted cached input |
| `qwen3.5-397b-a17b` | Reasoning | 250k | Frontier MoE, vision |
| `qwen3.6-35b-a3b` | Reasoning | 256k | Small MoE, vision, strong tool use |
| `gemma-4-26b-a4b-it` | Reasoning | 256k | Vision |
| `gpt-oss-120b` | Reasoning | 128k | Reasoning cannot be switched off |
| `mistral-medium-3.5-128b` | Generalist | 180k | Vision |
| `mistral-small-3.2-24b-instruct-2506` | Generalist | 128k | Vision |
| `qwen3-235b-a22b-instruct-2507` | Generalist | 250k | Multilingual |
| `llama-3.3-70b-instruct` | Generalist | 100k | No parallel tool calls |
| `qwen3-coder-30b-a3b-instruct` | Coding | 128k | Deprecated by Scaleway |
| `pixtral-12b-2409` | Vision | 128k | Deprecated by Scaleway; max 12 images |
| `qwen3-embedding-8b` | Embedding | 32k | 119+ languages |
| `bge-multilingual-gemma2` | Embedding | 8k | Multilingual embeddings |
| `whisper-large-v3` | Audio | — | Transcription endpoint, not chat |

All the chat models support tool calling. Output is capped well below the context window
(16k–32k depending on the model); Bee Flow clamps requests to that cap rather than
letting Scaleway reject them.

### Reasoning

Reasoning models reason **by default**. Bee Flow passes the reasoning effort a tier is
configured with, but only where the model accepts it — `gpt-oss-120b` has no "off"
setting and `glm-5.2` uses `high`/`max` rather than `low`/`medium`. An effort a model
does not understand is dropped instead of forwarded, so the model falls back to its
default effort rather than the request failing.

Reasoning traces are shown in the thinking panel, whether the model returns them as a
separate field or inline in `<think>` tags.

## Costs

Usage is billed at Scaleway's published per-token rates and shows up in
**Admin → Monitoring** like any other provider. Because these are open weights that other
hosts also sell, Bee Flow prices them from Scaleway's own tariff specifically — never
from another host's rate for a model with the same name.

## Self-hosting

Set the key through the environment instead of the admin UI:

```bash
SCALEWAY_API_KEY=<your-secret-key>
# Optional: pin to one Scaleway Project
SCALEWAY_URL=https://api.scaleway.ai/<project-id>
```

Or, at first boot, via the init variables:

```bash
INIT_AI_PROVIDER=scaleway
INIT_GENERIC_API_KEY=<your-secret-key>
```

## Troubleshooting

**No models appear.** The model list is read live, so an empty list means the key was
rejected or the endpoint was unreachable — Bee Flow deliberately shows nothing rather
than a catalog it cannot actually serve. Check the server log for `[Scaleway] /v1/models
failed`.

**A model disappeared.** Scaleway retires deprecated models on a published schedule.
Anything pinned to it in a chat tier or agent needs repointing; the table above flags the
models Scaleway has already marked deprecated.

**429 responses.** Serverless endpoints are rate-limited per token and per request.
Sustained load belongs on a Scaleway Dedicated Deployment — point a provider at its
endpoint and the same adapter handles it.
