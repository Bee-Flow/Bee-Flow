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
| **OS** | Linux x86_64 / arm64 | Ubuntu 22.04 / Debian 12 |
| **Postgres** | 16+ | 16 |
| **Redis** | optional | 7+ for >1 server replica |

The server is stateless when Redis is configured — scale by running more replicas behind a load balancer. Without Redis, sessions are server-local.

### Supported Nextcloud versions

| Nextcloud | Supported | Notes |
|-----------|:---------:|-------|
| 31.x | ✅ | Stable. |
| 32.x | ✅ | Stable. |
| 33.0.0 | ⚠️ | AppAPI ships a broken `EventsListenerController`. Bee Flow detects this and continues without event subscriptions; user/group changes won't auto-sync until 33.0.1+. |
| 33.0.1+ | ✅ | Stable. |
| 34.x | ✅ | Stable. |
| 30.x or older | ❌ | Not supported — AppAPI prerequisites are missing. |

### Supported model providers

You need at least one configured. They are optional layered — the same agent can call any of them.

| Provider | Env var | Notes |
|----------|---------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Recommended default. Claude 4.x family. |
| OpenAI | `OPENAI_API_KEY` | GPT-4.x, GPT-5 once available. |
| Mistral | `MISTRAL_API_KEY` | Open-weight + hosted. |
| Azure OpenAI | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY` | EU-region deployments. |
| Voxtral | `VOXTRAL_API_KEY` | Voice (STT + TTS). |
| ElevenLabs | `ELEVENLABS_API_KEY` | TTS, music, sound effects. |
| Ollama / local | `OLLAMA_BASE_URL` | Self-hosted; for fully offline mode. |

### Network egress

The server reaches out to:

- the model providers above (HTTPS 443)
- `api.github.com` and `ghcr.io` (only at install + update time)
- OAuth providers you enable (Google, Microsoft, GitHub, …)
- Optional: `https://license.beeflow.nl` for licence validation refresh (Pro+)

There are no inbound webhooks required from the public internet — the server can sit behind a reverse proxy on a private network.

### What you'll need

- **For Nextcloud install**: admin permissions on the NC instance, AppAPI enabled, a deployment daemon (HaRP or `manual-install`), outbound access to `ghcr.io`.
- **For self-hosting**: Docker + Docker Compose (or Kubernetes), a public hostname for OAuth callbacks, at least one model-provider key.
- **For evaluating**: just a browser at [https://beeflow.nl/app](https://beeflow.nl/app).

## What's next

- [First-run wizard](wizard.md) — what the org admin sees on first launch.
- [Free vs paid features](tiers.md) — what's free, what needs a key.
- [Licensing](../licensing/index.md) — how feature gating works under the hood.
