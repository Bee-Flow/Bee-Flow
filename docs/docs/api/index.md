---
title: API
---

# API

Bee Flow exposes a REST + Server-Sent Events API. The web frontend (`agent-hub`) is one client; you can build others.

| Base URL | Use |
|----------|-----|
| `https://server.beeflow.nl` | Hosted SaaS |
| `https://beeflow.example.com` | Self-hosted |
| `http://localhost:3101` | Local dev |

Paths are given in full, from the base URL. Not everything sits under `/api`: sign-in is under
`/auth`, agents under `/agents`, chat under `/ai`.

## Pages

- [Authentication](auth.md) — the session cookie, the connector's bearer JWT and the other credentials.
- [REST reference](rest.md) — a tour of the most-used endpoints.
- [Endpoint reference](reference.md) — every route, generated from the server (also as [OpenAPI 3.1](pathname:///openapi.json)).
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

Errors are JSON. `error` is a message written for the caller; `correlationId` is the id to quote
when you ask for help (it matches the server log). `code` and `details` are present when the route
raised a typed error:

```json
{
  "error": "A folder needs a name.",
  "code": "invalid_request",
  "details": [{ "path": "body.name", "message": "A folder needs a name." }],
  "correlationId": "5b0c0f9e-..."
}
```

Some gates answer with their own body instead, for example `{"error": "Not authenticated"}` (401)
or `{"error": "feature_locked", "feature": "...", "required": "...", "current": "...", "upgrade_url": "..."}`
(403, the licence tier does not include the feature).

| Status | When |
|--------|------|
| 400 | Bad request: the body, query or path parameters failed validation (`code: "invalid_request"`). |
| 401 | Not signed in, or the session no longer belongs to an existing user. |
| 402 | The organisation is suspended (`org_suspended`). |
| 403 | Signed in, but the role or permission is not enough, or the licence tier does not include the feature (`feature_locked`, `tier_required`). |
| 404 | Not found, or in another tenant. |
| 409 | Conflict (for example the resource already exists, or is still in use). |
| 410 | The organisation is archived and read-only (`org_archived`). |
| 413 | The body is too large. |
| 429 | Rate-limited. |
| 500 | Server bug. The body carries only a generic message and the `correlationId`. |
| 503 | A dependency is unavailable (`auth_unavailable`, `tier_unavailable`), or the upstream model provider is down or overloaded. |

## Rate limits

There is no single rate-limit table. Limits are set per route inside the server (sign-in, chat
streams, public webhooks, uploads and others each have their own), and a request over its limit
answers `429`. A reverse proxy in front of a self-hosted install can add limits of its own.

## CORS

The hosted SaaS allows requests from `https://beeflow.nl`. Self-hosted: configure via `CORS_ORIGIN=` (comma-separated). For embedded chat, list every parent origin.

## Where to next

- [Authentication](auth.md)
- [REST reference](rest.md)
- [Endpoint reference](reference.md)
- [Streaming (SSE)](sse.md)
