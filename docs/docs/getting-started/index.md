---
title: Getting started
---

# Getting started

There are three common ways to run Bee Flow:

1. **As a Nextcloud app** — install from the Nextcloud App Store. The connector runs as an ExApp container next to your Nextcloud and the SPA is embedded at the top bar. **Recommended for most teams.**
2. **Self-hosted, standalone** — run the Bee Flow server + frontend yourself, without Nextcloud. Useful for evaluating outside an existing Nextcloud, or for non-Nextcloud teams.
3. **Hosted SaaS** — sign in at [beeflow.nl/app](https://beeflow.nl/app). Same code as this repo, run by Bee Flow B.V.

## Pick your path

<div className="bf-grid">

-    **I have a Nextcloud**

    ---

    Install Bee Flow from the App Store. Sign-in with your Nextcloud account. No second password.

    [→ Install on Nextcloud](nextcloud.md)

-    **I want to self-host standalone**

    ---

    Run the server in Docker, point a frontend at it. Community tier is free.

    [→ Self-hosting](../self-hosting/docker-compose.md)

-    **I just want to try it**

    ---

    Sign up for the hosted SaaS. Free Community tier, no credit card.

    [→ beeflow.nl/app](https://beeflow.nl/app)

</div>

### Once your server is running

The workspace runs in any browser. There are also two clients that connect to it:

- **[Desktop](desktop.md)** — Linux, macOS and Windows. Lives in the tray, adds a global quick-ask
  shortcut and real notifications, and bridges to the Nextcloud desktop app so files you attach are
  referenced rather than copied.
- **[Android](android.md)** — a genuinely native app, not the web UI in a wrapper.

## Before you start

### System requirements

| | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 cores | 4 cores |
| **RAM** | 2 GB (server) + 1 GB (Postgres) | 4 GB + 2 GB |
| **Disk** | 5 GB | 20 GB + KB storage |
| **OS** | Linux x86_64 (the server images are `linux/amd64` only) | Ubuntu 22.04 / Debian 12 |
| **Postgres** | 15+ with the `pgvector` extension | `pgvector/pgvector:pg15`, the image the Compose files run |
| **Redis** | optional | 7+ for >1 server replica |

Sessions live in Postgres, with or without Redis, so the server can run as several replicas behind a load balancer. Before you do, read [Kubernetes → More than one server replica](../self-hosting/kubernetes.md#server-replicas): the data of App Studio apps and of webpage projects is single-writer by default.

### Supported Nextcloud versions

| Nextcloud | Supported | Notes |
|-----------|:---------:|-------|
| 33, 34, 35 | ✅ | The range in the connector's manifest (`appinfo/info.xml`). |
| 32 and older | ❌ | Nextcloud does not offer or install the app below version 33. Update Nextcloud first. |
| 36 and newer | ❌ | Not yet: the manifest ends at 35. A later connector release raises the range. |

The full list of tested configurations is in [Connector → Compatibility](../connector/index.md#compatibility).

### Supported model providers

You need at least one configured. They are optional layered — the same agent can call any of them.

A provider and its API key are added in the app, under **Admin dashboard → Whole server → AI configuration → Providers**, and
stored encrypted in the database. The variable names earlier versions of this page
listed (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_KEY`, `VOXTRAL_API_KEY`,
`ELEVENLABS_API_KEY`, `OLLAMA_BASE_URL`) are not read by the server.

| Provider | Notes |
|----------|-------|
| Anthropic | Claude models. |
| OpenAI | GPT models. |
| Google | Gemini, through Google AI or Vertex AI. |
| Azure OpenAI | EU-region deployments. |
| Mistral | Open-weight and hosted models; its key also runs voice (Voxtral speech-to-text and text-to-speech). |
| Scaleway, IONOS, EU GPT | European hosting; see [Scaleway models](../admin/scaleway-models.md) and [IONOS models](../admin/ionos-models.md). A key saved in the app wins; `SCALEWAY_API_KEY`, `IONOS_API_KEY` and `EUGPT_API_KEY` are read when none is saved. |
| ElevenLabs | Text-to-speech fallback, music, sound effects. |
| Ollama, vLLM, llama.cpp, LM Studio, SGLang | Self-hosted, for fully offline mode. These can also be registered at start-up with `OLLAMA_URL`, `VLLM_URL`, `LLAMACPP_URL`, `LMSTUDIO_URL` or `SGLANG_URL`; see [Local models](../admin/local-models.md). |

### Network egress

The server reaches out to:

- the model providers above (HTTPS 443)
- `api.github.com` and `ghcr.io` (only at install + update time)
- OAuth providers you enable (Google, Microsoft, GitHub, …)
- Optional: `https://license.beeflow.nl` for licence validation refresh (opt-in, only with a licence key)

There are no inbound webhooks required from the public internet — the server can sit behind a reverse proxy on a private network.

### What you'll need

- **For Nextcloud install**: admin permissions on the NC instance, AppAPI enabled, a deployment daemon (HaRP or `manual-install`), outbound access to `ghcr.io`.
- **For self-hosting**: Docker + Docker Compose (or Kubernetes), a public hostname for OAuth callbacks, at least one model-provider key.
- **For evaluating**: just a browser at [https://beeflow.nl/app](https://beeflow.nl/app).

## What's next

- [First-run wizard](wizard.md) — what the org admin sees on first launch.
- [Free vs paid features](tiers.md) — what's free, what needs a key.
- [Licensing](../licensing/index.md) — how feature gating works under the hood.
