---
title: Environment variables
---

# Environment variables

The Bee Flow server is configured through environment variables. This page
covers the operationally important ones, grouped by area; defaults are quoted
from the example files and the server code, not invented.

The **source of truth** is the pair of annotated example files in the
repository — every supported variable is listed there with its rationale:

- [`.env.example`](https://github.com/Bee-Flow/Bee-Flow/blob/main/.env.example) — repository root; what the Compose stack and a dev checkout read.
- [`server/.env.example`](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/.env.example) — the server's own template.

:::warning No silent fallbacks for secrets
The server **refuses to boot** when a required secret is missing or too weak.
That is intentional: a silent fallback to a predictable default is how secrets
get effectively published.
:::

## Required secrets (fail-closed boot)

| Variable | Default | Purpose |
|----------|---------|---------|
| **`SESSION_SECRET`** | — (boot fails) | Signs the session cookie and derives keys for feature-scoped vaults. Must be a random value of at least 32 characters; anything shorter throws at start-up. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Rotating invalidates existing sessions. |
| **`MASTER_ENCRYPTION_KEY`** | — (boot fails) | Keys everything encrypted at rest (OAuth tokens, stored API keys). Must be random, at least 32 characters. Generate: `openssl rand -hex 32`. Rotating breaks decryption of already-stored tokens — re-link integrations after rotation. |
| **`WEBPAGE_PREVIEW_TOKEN_SECRET`** | auto-generated in dev only | HMAC key for the short-lived (4h) preview-iframe bearer tokens. In production you **must** set it explicitly. |

## Database

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CORE_DATABASE_URL`** | `postgresql://beeflow:beeflow@localhost:5432/beeflow_core` | Connection string for the primary (`beeflow_core`) database — the server's runtime pool. |
| **`DATABASE_URL`** | `postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks` | Connection string for the productivity-tasks database. |
| `MONITORING_DATABASE_URL` | derived by Compose | Monitoring database. The Compose files build all three from `DB_USER` / `DB_PASSWORD` / `DB_NAME` — see [Docker Compose → Three databases](docker-compose.md#three-databases-not-one). |

The Compose stack also creates `beeflow_tasks` and `monitoring_db` on the same
Postgres instance.

## HTTP listener and public URLs

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVER_PORT` | `3001` | HTTP port the server listens on (`PORT` is honoured as a fallback). |
| `SERVER_BIND_HOST` | `127.0.0.1` | Interface that publishes `SERVER_PORT`. Loopback on purpose: the API is meant to be reached through the agent-hub nginx, where the rate limits and security headers live. Set to `0.0.0.0` only when something off-machine must talk to the API port itself. |
| `TRUST_PROXY_HOPS` | `1` | How many proxies sit in front of the server. Rate limiting and login throttling key on the client IP; behind two proxies (e.g. CDN + nginx) set this to `2` or every visitor shares one bucket. |
| `PUBLIC_BASE_URL` | (none) | Public base URL of the API (`https://api.example.com`). Used for outgoing webhooks and callback URLs — and it is the switch that decides whether MS-Graph subscriptions get provisioned at all. |
| `SERVER_PUBLIC_HOST` / `SERVER_PROTOCOL` | `localhost:3001` / `http` | How the API is addressed externally. |
| `CLIENT_PUBLIC_HOST` / `CLIENT_PROTOCOL` | `localhost:5176` / `http` | Where the SPA lives; drives CORS and OAuth redirect URLs. |
| `CORS_ORIGIN` | `http://localhost:5176` | Comma-separated list of allowed browser origins. |
| `PUBLIC_SITE_URL` | falls back to `PUBLIC_BASE_URL` | Public origin of the marketing site: canonical/og URLs, sitemap, and the robots.txt gate. Unset on a public site means `Disallow: /` — it will not be indexed. Leave unset on staging. |

## Sessions and cookies

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_MAX_AGE_DAYS` | `30` | Session lifetime in days; fractions allowed (`0.5` = 12 hours), capped at 365. An unparseable or non-positive value falls back to 30 — never to "no expiry". |
| `SESSION_ROLLING` | `false` | The default is a **fixed 30-day window from sign-in**, not an inactivity timeout. Set to `true` if your access-control policy describes inactivity (most do). Only the exact string `true` enables it. |
| `COOKIE_SECURE` | on when `NODE_ENV=production` | Send the session cookie over HTTPS only. Set explicitly to `false` only in dev over plain HTTP. |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`. |
| `COOKIE_NAME` | `connect.sid` | Session cookie name. |
| `COOKIE_DOMAIN` | — | Set when the SPA and API are on different subdomains (e.g. `.example.com`). |

## Deployment mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEPLOYMENT_MODE` | `cloud` | `cloud` (Bee Flow SaaS — Stripe subscriptions, consumer accounts) or `self-hosted` (customer-run — licence keys, no billing, Community tier by default, organisation domain allow-lists). These are the only two valid values; the retired `private-cloud` is treated as `self-hosted`. |

## Download size limits

Each limit is in bytes, has a generous default, and `0` means no limit. They keep one huge file or page from filling the server's memory; raise or remove them on a large server.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOOL_FILE_MAX_BYTES` | `104857600` (100 MB) | Largest file the Nextcloud, Nextcloud Mail and Gmail tools read into memory. A bigger file gets a clear error naming this variable. |
| `KB_WEB_PAGE_MAX_BYTES` | `10485760` (10 MB) | Largest web page a knowledge-base source reads. A bigger page is refused, never indexed in part. |
| `KB_SITEMAP_MAX_BYTES` | `52428800` (50 MB) | Largest sitemap a crawl reads (the sitemap specification's own maximum). A bigger one is skipped; the entry page is still indexed. |
| `ATTACHMENT_MAX_BYTES` | `26214400` (25 MB) | Largest single attachment the Email Sender component adds, a file or a downloaded http(s) URL. Files come only from `ATTACHMENTS_DIR` (created when missing; default `beeflow-attachments` in the temp directory). |

## AI steps and automation concurrency

Limits for automations that call a model. Each is an integer, has a generous default, and `0` means no limit (the exception is `LLM_RATE_LIMIT_RETRIES`, where `0` means no retry). They protect the model provider's account and the server's memory, not the user: raise or remove them on a large installation. See [Reliable AI steps](../studio/ai-steps.md) for what they do from the builder's side.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER_RPM` | `600` | Requests per minute Bee Flow sends to one model connection (one provider URL with one key). A request over the limit waits until room frees up (the allowance refills steadily) instead of failing. `0` = unlimited. |
| `LLM_PROVIDER_TPM` | `2000000` | Estimated tokens per minute for one model connection, counted from the request size plus the room for the answer and corrected afterwards from the real usage. `0` = unlimited. |
| `LLM_RATE_LIMIT_RETRIES` | `4` | How many times a request is repeated after the provider answers "too many requests" or "overloaded", waiting as long as the provider asks. `0` = no retry: the first such answer fails the step. |
| `LLM_RATE_LIMIT_MAX_WAIT_MS` | `60000` | The longest single wait, in milliseconds, for a slot or a retry. A larger wait asked by the provider is cut to this. `0` = no cap. |
| `AUTOMATION_FOREACH_MAX_CONCURRENCY` | `4` | The most items an AI step without tools, or a data extraction step, runs at once when its "Run per item" list sets a concurrency. A step asking for more is held to this number. `0` = no cap beyond the number of items. |
| `AUTOMATION_AI_ENUM_MAX_VALUES` | `500` | The longest list of allowed values that one "Allowed values from a list" setting shows to the model. A longer list is not shown to the model at all (the server log says so); the answer is still checked against the whole list. `0` = unlimited. |
| `AUTOMATION_AI_CHECK_MAX_ERRORS` | `100` | The most problems collected while checking one AI answer. `0` = unlimited. |
| `AUTOMATION_AI_REPAIR_MAX_ERRORS` | `25` | The most failing places quoted back to the model in the single repair round. `0` = unlimited. |

## Redis

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | (none) | Read-through cache over the PG session store, e.g. `redis://redis:6379`. Optional — with it unset the server falls back to PG-only sessions, and a failed Redis connect degrades to the same rather than taking logins down. |

## Service-to-service (sidecars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVICES_API_KEY` | (none) | Shared secret for calls to the bundled sidecars (guard-service, classify-service). The guard-service and classify-service require it: they enforce it on every request except `/health` and refuse to start without one (`./selfhost.sh` generates it). Set `SERVICES_ALLOW_OPEN=1` on them only to run open on a trusted network. Note it has **no** `GUARD_` prefix on that side. |
| `PII_SERVICE_URL` | (none — opt-in) | Guard-service base URL, e.g. `http://guard-service:8100`. Unset means PII detection is disabled entirely. |
| `PII_SERVICE_API_KEY` | falls back to `SERVICES_API_KEY` | Sent as `X-API-Key` to the guard; must match the guard's own `SERVICES_API_KEY`. |
| `GUARD_SERVICE_URL` | (none — opt-in) | Sidecar health probe for `/api/guard/health`; returns `not-configured` when unset. |

## Observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `http` / `debug`. An unrecognised value falls back to `info`. |
| `OTEL_ENABLED` | off | Set to `true` (or set an endpoint) to start the OpenTelemetry SDK. Fully off by default — zero overhead. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | (none) | Where traces and metrics go: directly to OpenObserve, or — recommended for production — to an in-cluster OTel collector so the app never holds the OpenObserve secret. |
| `OTEL_SERVICE_NAME` | `beeflow-server` | Service name in the exported telemetry. |
| `USAGE_PUSH_ENABLED` / `OPS_PUSH_ENABLED` | off | Optional pushes of per-org usage rollups and ops-metric snapshots to OpenObserve. `USAGE_HASH_SALT` is **required** when usage push is on — it pseudonymises user ids. |

Telemetry is exported off the request path (background batch export, bounded
queues, swallowed errors), so a down or slow OpenObserve never affects Bee
Flow's latency or availability. The full knob list — including export timeouts
and backfill behaviour — is in `server/.env.example`; see
[Reference → Telemetry](../reference/telemetry.md) for the current state.

## Webpage full-tier runtime (optional)

The full-tier preview for webpage projects runs each project in a throwaway Docker container. It is **off by default** and starts only when `WEBPAGE_FULL_RUNTIME_ENABLED=1` and the server can reach a Docker daemon.

The container image, `ghcr.io/bee-flow/webpage-runner`, is **built outside this repository**: this repo contains no Dockerfile for it. The server picks the image in this order:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBPAGE_RUNNER_IMAGE` | unset | Image to run. Wins over everything else; set it to use your own build or a private mirror. |
| `WEBPAGE_RUNNER_REGISTRY_IMAGE` | `ghcr.io/bee-flow/webpage-runner:latest` | Image the server pulls when `WEBPAGE_RUNNER_IMAGE` is unset and no local `beeflow-webpage-runner:local` image exists. |

If the image can neither be found nor pulled (for example on an air-gapped host), the preview does not start: the API answers `503 full_tier_unavailable` and the server log says `webpage-runner image unavailable. Set WEBPAGE_RUNNER_IMAGE.` Pull or load the image on the host first, then set `WEBPAGE_RUNNER_IMAGE`.

## Everything else

Model-provider keys, OAuth client credentials, SMTP, licensing, retention
windows, rate limits, edition/module switches and the automation kill switches
are all documented where they are set: in the two example files linked above.
Integration API keys entered in the admin UI are stored encrypted in the
database, not in `.env`.
