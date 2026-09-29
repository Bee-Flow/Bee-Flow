---
title: Self-hosting
---

# Self-hosting

Bee Flow's server and frontend are open-source under the Sustainable Use Licence. You can run the entire stack on your own infrastructure for free, for your own organisation.

## Fastest path

```bash
# with selfhost.sh, docker-compose.from-registry.yml and .env.selfhost.example present:
./selfhost.sh
```

This pulls **public** images from `ghcr.io/bee-flow` (no login), generates secrets, starts the core
stack, and prints your URL + admin password. Full walkthrough: [Docker Compose → Easy install](docker-compose.md#easy-install).
Then [connect your Nextcloud](docker-compose.md#connect-nextcloud).

The **Community tier is free and the default — no licence key is required** (chat, knowledge bases,
multi-user, and the Nextcloud connector all work out of the box). For premium features, [activate a
licence](docker-compose.md#activate-a-licence); pricing and keys are at [beeflow.nl](https://beeflow.nl).

## What you'll run

| Component | Image | Required? |
|-----------|-------|:---------:|
| Bee Flow server | `ghcr.io/bee-flow/server:latest` | ✅ |
| Bee Flow web UI (`agent-hub`) | `ghcr.io/bee-flow/agent-hub:latest` | ✅ |
| PostgreSQL 15+ with pgvector | `pgvector/pgvector:pg15` | ✅ |
| Object storage (S3-compatible) | `rustfs/rustfs:latest` (or any S3) | ✅ |
| Redis 7 | `redis:7-alpine` | recommended |
| Bee Flow Nextcloud connector | NC App Store (`bee_flow`) | optional |
| Guard service (PII detection) | `ghcr.io/bee-flow/guard:latest` | optional |
| Search service (KB ingestion + reranking) | `ghcr.io/bee-flow/search-api:latest` | optional |

The minimum useful deployment is **server + Postgres + object storage** (the `core` profile). Add Redis
as soon as you scale to >1 server replica or many concurrent users.

The `ghcr.io/bee-flow/*` images are also mirrored on [Docker Hub](docker-hub.md)
(`docker.io/beeflowapp`) — same digests, different registry.

## Stack diagram

```
                Browser
                   │
                   ▼
       ┌──────────────────────┐
       │  Reverse proxy       │  Caddy / Nginx / Traefik / Cloudflare
       │  ─ TLS termination   │
       │  ─ Path routing      │
       └──────────┬───────────┘
                  │
      ┌───────────┼──────────────────┐
      │           │                  │
      ▼           ▼                  ▼
┌───────────┐ ┌──────────┐     ┌────────────┐
│ agent-hub │ │ server   │ ◀───│ bee_flow   │ (Nextcloud connector,
│ /         │ │ /api/    │     │ ExApp      │  optional, same network)
│ /app      │ │ /auth/   │     └────────────┘
└───────────┘ └────┬─────┘
                   │
      ┌────────────┼───────────────┐
      │            │               │
      ▼            ▼               ▼
┌──────────┐  ┌────────┐  ┌─────────────────┐
│ Postgres │  │ Redis  │  │ guard / search  │
│  15      │  │  7     │  │ services        │
└──────────┘  └────────┘  └─────────────────┘
```

## Minimum and recommended hardware

| | Minimum | Recommended | Heavy use |
|---|---|---|---|
| **CPU** | 2 cores | 4 cores | 8 cores |
| **RAM** | 4 GB | 8 GB | 16+ GB |
| **Disk** | 10 GB | 50 GB | 200+ GB (KB) |
| **Postgres** | 1 GB RAM | 2 GB | 4 GB |
| **Network** | 100 Mbps | 1 Gbps | 1 Gbps + |

The server is stateless when Redis is configured — scale horizontally. Postgres carries all durable state (users, agents, conversations, KB chunks, automation runs, audit log).

## Pick your deploy target

<div className="bf-grid">

-    [Docker Compose](docker-compose.md)

    Single host, simplest. Production-ready for most small/mid orgs.

-    [Kubernetes](kubernetes.md)

    Multi-node. No chart or published manifests — a pattern guide for operators.

-    [Environment variables](env.md)

    The full reference for every `BEEFLOW_*` and dependency knob.

-    [Upgrades](upgrades.md)

    Pinning versions, migrations, verifying an upgrade, rollback.

</div>

## Supported deploy targets

| Target | Status | Notes |
|--------|:------:|-------|
| Docker Compose (single host) | ✅ | Recommended for self-hosters — the tested, documented path. |
| Kubernetes | ⚠️ | No chart or published manifests. [The pattern](kubernetes.md), for operators who bring their own. |
| Other Docker hosts (Coolify, Kamal, Render, Fly, …) | ⚠️ | The images are plain Docker images, so it can work — but these targets are not tested by Bee Flow; you translate the compose file yourself. |
| Vercel / Netlify / Cloudflare Pages (frontend only) | ⚠️ | A static frontend build from `agent-hub/` hosts anywhere — see [Serving the frontend](docker-compose.md#serving-the-frontend-manual-topology-only). The server still needs a Docker host. |
| Bare-metal (systemd) | ⚠️ | Works but unsupported — you maintain the service files. |

## Required external services

- **At least one model provider** — Anthropic, OpenAI, Mistral, Azure OpenAI, or a local Ollama endpoint.
- **Postgres 15+ with `pgvector`** — primary store (the stack ships `pgvector/pgvector:pg15`).
- **DNS + TLS** for the hostname your users hit (Let's Encrypt via Caddy is the simplest path).

## What's next

- [Docker Compose recipe](docker-compose.md) — full annotated stack.
- [Environment variables](env.md) — every `BEEFLOW_*` and dependency knob.
- [Upgrades](upgrades.md) — pinning versions, migrations, verification, rollback.
