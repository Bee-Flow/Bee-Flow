---
title: Architecture
---

# Architecture

A 30 000 ft view of the Bee Flow stack.

## System diagram

```
                     Browser
                       │
              TLS (your reverse proxy)
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
    ┌──────────┐               ┌──────────┐
    │  Hive    │   REST + SSE  │  Server  │
    │ frontend │ ◀───────────▶ │  3101    │
    │  (React) │               └────┬─────┘
    └──────────┘                    │
                              ┌─────┼─────┐
                              ▼     ▼     ▼
                          ┌──────┐ ┌────┐ ┌─────────┐
                          │Postgres│ │Redis│ │SMTP / │
                          │  16  │ │  7 │ │OAuth/ │
                          └──────┘ └────┘ │license/ │
                                          │..       │
                                          └─────────┘
                              ▲
                              │ HMAC tenant key
                              │
                  ┌─────────────────────┐
                  │ Connector (NC ExApp)│  (optional, Nextcloud-only)
                  └─────────────────────┘
                              ▲
                              │ AppAPI signed proxy
                              │
                       ┌──────────────┐
                       │  Nextcloud   │
                       │   instance   │
                       └──────────────┘
```

Optional sidecars (used when configured):

| Sidecar | Image | Purpose |
|---------|-------|---------|
| Guard service | `ghcr.io/bee-flow/guard-service` | Local CPU PII detection (GLiNER multi-PII). Probed at `GUARD_SERVICE_URL`. |
| Classify service | `ghcr.io/bee-flow/classify` | Zero-shot topic classifier for the Condition node's "is about" rule (CPU). Opt-in via `CLASSIFY_SERVICE_URL`. |

The server itself runs fine with none of these. Each sidecar plugs in at a single env var.

Bee Flow publishes no images for the following; the server can still talk to a service you run yourself.
The default knowledge-base pipeline, web search and reranking all run in-process.

| Service | Env var | Purpose |
|---------|---------|---------|
| Remote search service | `SEARCH_SERVICE_URL` | KB ingestion/search over HTTP. The self-host compose files point it at the server's own `/api/search`. |
| Reranker | `RERANKER_URL` | Optional external cross-encoder for re-ranking KB hits; the in-process CPU reranker covers most deployments. |
| WhisperX | `WHISPERX_URL` | Speech-to-text and diarisation for the voice / meeting-notes pipeline. |

## Data plane

| Layer | Tech |
|-------|------|
| Durable state | Postgres 16+ — users, orgs, agents, conversations, KB chunks (or pointers), automation runs, audit log |
| Cache + sessions | Redis 7 (optional but recommended) |
| Message bus | Postgres `LISTEN/NOTIFY` for in-process events; Redis pub/sub for cross-replica |
| Vector index | pgvector (default) or external (via a remote search service) |
| Object storage | Disk on the server (small images) or S3-compatible if configured |
| Audit log | Postgres tables; SIEM webhook for off-host shipping |

## Control plane

| Layer | Tech |
|-------|------|
| Auth | JWT (ECDSA P-256 for licence, HMAC-SHA256 for sessions); OAuth 2.0; SAML 2.0 |
| Migrations | Forward-only, applied at server startup; `automatic_migrations` flag governs auto-apply |
| Background jobs | In-process scheduler; cron at the OS level for the connector |
| Health checks | `/api/health`, `/api/guard/health` |
| Telemetry | `console`-based logging today; ticket-assistant exposes Prometheus metrics. Global OTel/Prometheus is on the roadmap — see [Telemetry](telemetry.md). |

## Trust boundaries

```
┌──────────────────────────────────────────────────────────┐
│  Public internet                                         │
│   ─ users' browsers                                      │
│   ─ OAuth providers, model providers, licence-server     │
└────────┬─────────────────────────────────────────────────┘
         │  HTTPS, OAuth, signed JWTs
         ▼
┌──────────────────────────────────────────────────────────┐
│  Edge (your reverse proxy)                               │
│   ─ TLS termination                                      │
│   ─ Rate limit                                           │
│   ─ Request log                                          │
└────────┬─────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│  Bee Flow tenant boundary                                │
│   ─ Server, Postgres, Redis, sidecars                    │
│   ─ Privacy Shield runs here                             │
│   ─ Audit log lives here                                 │
└────────┬─────────────────────────────────────────────────┘
         │  Tenant-key HMAC
         ▼
┌──────────────────────────────────────────────────────────┐
│  Nextcloud tenant boundary                               │
│   ─ Connector + Nextcloud server                         │
│   ─ User auth via NC session                             │
└──────────────────────────────────────────────────────────┘
```

## Repositories

| Repo | Contents | Licence |
|------|----------|---------|
| `Bee-Flow/beeflow` | Server (Node.js + Express) | SUL |
| `Bee-Flow/hive` | Frontend (React + Vite) | SUL |
| `Bee-Flow/connector` | NC ExApp (Node.js + Express, Docker) | AGPL-3.0 |
| `Bee-Flow/docs` | This site | CC-BY-4.0 + MIT |
| `Bee-Flow/guard-service` | PII guard sidecar (Python + FastAPI) | Apache-2.0 |
| License server (private repository) | Licence-key minting service and module hub | **PRIVATE** (Bee Flow B.V.) |

## Key request flow — a chat turn

```
1. Browser POST /agents/:id/chat/stream with { message, conversationId }
   │
   ▼
2. Server: checks the session → resolves user, org, agent, tier
   │
   ▼
3. Server: runs Privacy Shield scan on the prompt
   │
   ▼
4. Server: resolves agent's tool list (3-layer access)
   │
   ▼
5. Server: streams to model provider (Anthropic / OpenAI / ...)
   │
   ▼
6. Model emits tool calls → server dispatches to integrations/*.js
   │  (each tool call may go through HMAC /nc/* proxy or OAuth provider)
   │
   ▼
7. Tool results streamed back → model continues
   │
   ▼
8. Final reply tokens → SSE → browser, with citations
   │
   ▼
9. Server records: usage, tool calls, audit events
```

## Key request flow — NC connector lifecycle

```
1. Admin clicks Install in NC App Store
   │
   ▼
2. AppAPI pulls ghcr.io/bee-flow/connector → starts container on :23000
   │
   ▼
3. AppAPI POST /init → connector returns 200 immediately
   │
   ▼
4. setImmediate(): bootstrap (provision tenant key) → register UI → register events
   │
   ▼
5. Progress reported to AppAPI via PUT /ocs/v2.php/apps/app_api/ex-app/status
   │
   ▼
6. AppAPI marks app as enabled → bee icon appears
   │
   ▼
7. User clicks bee → SPA loads → /auth/nc-handshake → JWT minted → chat opens
```

## Where to next

- [Glossary](glossary.md) — what every term means.
- [Connector → Architecture](../connector/architecture.md) — the connector's request flow in detail.
- [Self-hosting → Index](../self-hosting/index.md) — the deployment options.
