---
title: API
---

# API

Bee Flow exposes a REST + Server-Sent Events API. The web frontend (`agent-hub`) is one client; you can build others.

| Base URL | Use |
|----------|-----|
| `https://server.beeflow.nl` | Hosted SaaS |
| `https://beeflow.example.com/api` | Self-hosted |
| `http://localhost:3101/api` | Local dev |

## Pages

- [Authentication](auth.md) — how to obtain a session JWT or API key.
- [REST reference](rest.md) — endpoints by area.
- [Streaming (SSE)](sse.md) — chat streams and tool-call events.

## Versioning

Pre-1.0. The API is **not** versioned by URL prefix. Breaking changes will be:

- Announced in the release notes 30 days before they ship.
- Tagged with the new server version that drops the old behaviour.
- Held to a minimum during 0.x — most non-breaking additions follow.

If you need a version pin: pin the **server image** to an immutable tag in your deploy (e.g. `ghcr.io/bee-flow/server:sha-<commit>` — see [Self-hosting → Upgrades](../self-hosting/upgrades.md)). A pinned image speaks the same protocol forever.

## Deprecation policy

Endpoints marked `Deprecated` in this docs site continue to work for at least 6 months from the deprecation announcement, and are removed in the first major version after the sunset date. Watch the release notes for headlines.

## Error format

All errors return JSON:

```json
{
  "error": "tier_limit",
  "message": "Your tier doesn't allow more than 20 agents",
  "details": { "tier": "pro", "limit": 20, "current": 20 },
  "requestId": "req_2026..."
}
```

| Status | When |
|--------|------|
| 400 | Bad request — body or query is malformed. |
| 401 | Missing / invalid auth. |
| 402 | Tier limit hit (`error: "tier_limit"`). |
| 403 | Auth ok, but feature not in your tier (`error: "license_feature_required"`). |
| 404 | Not found / wrong tenant. |
| 409 | Conflict (e.g. resource already exists). |
| 422 | Semantic validation failed (e.g. invalid cron). |
| 429 | Rate-limited. Retry-After header present. |
| 500 | Server bug. `requestId` lets us trace it. |
| 503 | Upstream model provider down or overloaded. |

## Rate limits

Default per-IP + per-user limits at the reverse proxy (self-hosters) and at the SaaS edge:

| Endpoint family | Default | Burst |
|-----------------|---------|-------|
| `/ai/chat` | 60 / min | 120 |
| `/agents` | 120 / min | 200 |
| `/api/kb/*` | 30 / min | 60 |
| `/auth/*` | 30 / min | 60 |
| `/api/automation/webhook/*` | 600 / min | 1200 |

Set on the reverse proxy or via `RATE_LIMIT_*` env vars on the server (Redis-backed).

## CORS

The hosted SaaS allows requests from `https://beeflow.nl`. Self-hosted: configure via `CORS_ALLOWED_ORIGINS=` (comma-separated). For embedded chat, list every parent origin.

## Where to next

- [Authentication](auth.md)
- [REST reference](rest.md)
- [Streaming (SSE)](sse.md)
