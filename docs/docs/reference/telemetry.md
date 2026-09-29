---
title: Telemetry
---

# Telemetry

What Bee Flow logs, how to ship it elsewhere, and what guarantees we make about PII in logs.

:::info[Implementation status]

Current reality:

- **Logs**: plain `console.*` JSON (no structured Pino logger wired yet). Captured by `docker logs` or the container runtime.
- **Metrics**: implemented and **off by default** (env-gated, no-op unless configured). Two surfaces: an admin-gated `GET /api/admin/metrics` (Prometheus text or JSON) from in-memory counters, and an OpenTelemetry meter exported over OTLP when `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` are set.
- **Tracing**: implemented — OTLP/HTTP trace exporter + auto-instrumentation, same env gate as metrics.
- **Usage / ops push**: optional periodic JSON push of usage-cost and ops snapshots to an OpenObserve-style store (`USAGE_PUSH_ENABLED` / `OPS_PUSH_ENABLED`).
- **Audit log**: real and complete — `guardrail_events`, `admin_audit_events`, `automation_runs` tables in Postgres. See [Admin → Audit & compliance](../admin/audit-and-compliance.md).

Everything metric/trace-related is a no-op until the corresponding env vars are set, so the default self-host footprint is logs-only.

:::

## What's logged

Bee Flow's server emits structured JSON logs covering:

| Category | Examples |
|----------|----------|
| HTTP requests | method, path, status, duration_ms, requestId |
| Auth | login attempts, JWT issuance, OAuth callbacks (no tokens logged) |
| Chat | conversationId, messageId, agentId, model, token usage |
| Tool calls | toolName, durationMs, success boolean (no payloads at default level) |
| Errors | stack trace, requestId |
| Migrations | which migration applied, duration |
| Background jobs | NC sync, KB ingestion, audit retention purge |
| License | tier, lastVerifiedAt, refresh ticks |

At `LOG_LEVEL=debug`: also logs request bodies (PII-redacted via the same Privacy Shield used at runtime), full tool call args + results.

## What's NEVER logged

- **OAuth access tokens** / refresh tokens
- **Session JWTs**
- **API keys**
- **Licence private key material** (we don't have it in the open-source server)
- **Plaintext PII matched by the Privacy Shield** (only the categories + counts)

This is true at every log level.

## Product measurement: what we may and may not collect

Bee Flow is sold on the promise that the vendor cannot see your data, and many
customers self-host precisely so that nothing leaves. That promise constrains
how the product may be measured, so the constraint is written down here rather
than argued about case by case.

**Every row described below stays in your own database.** A self-hosted
operator is the controller of it. Nothing here is exported anywhere unless you
separately switch on the aggregate ops push (`OPS_PUSH_ENABLED`), which is off
by default.

| | |
|---|---|
| **May be recorded** | The **client** that made a request (`web`, `android`, `api`, `unknown`) — a closed enum, on a row that already exists. The **source** of a model call (`direct_chat`, `automation`, …). The columns already on `ai_usage_log`: model, token counts, duration, cost. |
| **May NOT be recorded** | Screen names. Taps. Navigation or route paths. Session durations. Message content. Any per-user row leaving your database. |

### The client column

Every Bee Flow client sends `X-Beeflow-Client` on each request. Since it is now
read, `ai_usage_log.client` records which one — so an operator can answer "how
much of our work happens on a phone" about their own instance.

`transcriptions.client` records the same enum for a recording. It is a separate
column because it answers a different question: a phone can be a capture device
without being a place anyone works, and a recording made by walking into a
meeting is not the same event as one uploaded from a laptop afterwards. A
recording created by a background ingest — a Nextcloud Talk pickup, a Meet
import — has no request behind it and stays `unknown`, correctly: no client made
it.

Calls made with no request in flight — the automation runner, scheduled tasks,
swarm workers, title generation — are recorded as `unknown`, which is the
honest answer: those are the server acting on its own, not a client choice.

For the same reason, any share computed from this column must use an
**interactive denominator** (`source IN ('direct_chat', 'agent_chat',
'agent_stream', 'notebook', 'webpage_chat')`). Counting machine-initiated turns
would report every client's share against how busy the instance happens to be,
so a quiet week would read as phone adoption. The canonical list is
`INTERACTIVE_SOURCES` in `server/telemetry/requestClient.js`.

### If you are researching your own installation

Two things worth knowing before you query:

- `GET /api/usage/sources` applies **no organisation filter for a super
  admin**. On a multi-tenant instance an unscoped read aggregates every
  organisation's metadata. Scope every research query to a user or an
  organisation explicitly.
- A pilot organisation's numbers should be run by **that organisation's own
  admin**, not by the vendor. Under Art. 28 the vendor is a processor for
  customer data; "we looked at your usage to improve the product" is not a
  basis the contract gives them.

### What cannot be known about self-hosted installs, by design

Community installs need no licence key and never contact anyone. Licence
refresh is opt-in and sends only a licence id — no version, no user count, no
client mix. The in-app support desk is a feature each installation runs for its
own users; a ticket lands in that installation's database with no relay to the
vendor.

Docker pulls and release-asset downloads count installs, never people, and
never distinguish phone from web. They are not usage evidence.

## Log destinations

| Mode | How |
|------|-----|
| `LOG_FORMAT=json` (default) | Stdout — pipe to your log collector. |
| `LOG_FORMAT=pretty` | Human-readable — for local dev only. |
| Sentry | Set `SENTRY_DSN`. Errors go to Sentry; the rest stays in stdout. |

## Shipping to a SIEM / log store

Three good patterns:

### 1. Loki (Grafana stack)

```yaml
# Docker Compose snippet
services:
  beeflow-server:
    logging:
      driver: "loki"
      options:
        loki-url: http://loki:3100/loki/api/v1/push
        loki-batch-size: "100"
```

Then query in Grafana with `{app="beeflow"}`.

### 2. Vector → Elastic / Splunk

Run [Vector](https://vector.dev) as a sidecar; configure source = Docker JSON logs, sink = your destination. Vector handles batching, retries, transformation.

### 3. CloudWatch (AWS)

```yaml
services:
  beeflow-server:
    logging:
      driver: awslogs
      options:
        awslogs-group: /beeflow/server
        awslogs-region: eu-west-1
```

## Audit log shipping (Enterprise+)

Different mechanism from app logs. Bee Flow can push **guardrail events** in real time to a webhook:

| Setting | Value |
|---------|-------|
| URL | Your SIEM ingest endpoint |
| Shared secret | HMAC-SHA256 secret |
| Severity filter | `low` / `medium` / `high` |
| Retry | 3× with exponential backoff |

Configure in **Admin → Audit & compliance → Webhooks**. Format:

```json
{
  "id": "ev_abc",
  "organizationId": "org_123",
  "userId": "u_alice",
  "agentId": "asst_xyz",
  "violationType": "pii",
  "violationCategories": "email,phone",
  "direction": "input",
  "actionTaken": "redact",
  "model": "claude-opus-4-7",
  "timestamp": "2026-05-09T13:30:00Z"
}
```

Verify the `X-Beeflow-Sig` HMAC on your end before processing.

## Metrics

There is no **public** `/metrics` endpoint. Metrics are exposed on two admin/optional surfaces:

**1. `GET /api/admin/metrics`** (admin-gated) — in-memory counters maintained by [server/telemetry/httpMetrics.js](https://github.com/Bee-Flow/beeflow/blob/main/server/telemetry/httpMetrics.js): HTTP request totals + duration buckets, DB query counts, cache hit/miss, event-loop delay. Add `?format=prometheus` for Prometheus text exposition; the default is JSON.

**2. OpenTelemetry meter** ([server/telemetry/metrics.js](https://github.com/Bee-Flow/beeflow/blob/main/server/telemetry/metrics.js), meter `beeflow-server`) — domain metrics recorded across the app and exported over OTLP when telemetry is enabled (see below). No-op when the OTEL SDK isn't started. Covers, among others:

| Instrument | Kind | Notes |
|------------|------|-------|
| `llm.requests`, `llm.tokens.input`, `llm.tokens.output`, `llm.cost.usd`, `llm.provider.errors` | counters | per provider/model |
| `agent.runs`, `mcp.calls`, `sidecar.calls`, `embed.calls`, `job.runs` | counters | agent/tooling activity |
| `auth.events`, `feature.gate` | counters | login/entitlement events |
| `db.pool.connections`, `nodejs.eventloop.delay` | observable gauges | runtime health |

Because the meter is exported via OTLP, you consume these in whatever OTLP-compatible backend you point the exporter at (OpenObserve, an OTel Collector, Grafana/Tempo/Mimir, etc.) rather than by scraping.

## Tracing & OTLP export (OpenTelemetry)

Bee Flow ships an OpenTelemetry bootstrap ([server/telemetry/otel.js](https://github.com/Bee-Flow/beeflow/blob/main/server/telemetry/otel.js), required first in `server/index.js` so it can patch the runtime). When enabled it starts a `NodeSDK` with OTLP/HTTP exporters for **both traces and metrics**, plus auto-instrumentation for HTTP, Express, Postgres, Redis/ioredis, and undici. `GET /api/health` reports whether it came up (`otel: true|false`).

It is **off by default** and turns on when either `OTEL_ENABLED=true` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

| Env var | Purpose |
|---------|---------|
| `OTEL_ENABLED` | Master switch (`true` to force-enable). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base ingest URL. The exporter appends `/v1/traces` and `/v1/metrics`, so pass the **base with no trailing slash**. For an OpenObserve target this must include the org path, e.g. `https://<host>/api/<org>` (the bare host will 404). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth header(s), e.g. `Authorization=Basic <token>`. Treat as a secret. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Service identity / resource labels. |
| `OTEL_METRIC_EXPORT_INTERVAL_MS`, `OTEL_EXPORT_TIMEOUT_MS`, `OTEL_SHUTDOWN_TIMEOUT_MS`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_DISABLE_UNDICI` | Tuning. |

Point the endpoint at your own OTel Collector or any OTLP/HTTP-compatible store.

### Usage & ops push (OpenObserve streams)

Two optional periodic jobs push aggregated data straight to OpenObserve-style streams over HTTP JSON (reusing the OTLP endpoint + headers above), independent of the OTLP metric exporter:

- **Usage/cost** ([server/jobs/usageOpenObservePush.js](https://github.com/Bee-Flow/beeflow/blob/main/server/jobs/usageOpenObservePush.js)) — token/cost rollups from `ai_usage_log` to the `ai_usage` stream. Enable with `USAGE_PUSH_ENABLED=true`; requires `USAGE_HASH_SALT` (HMAC-pseudonymises user ids). Tunable via `USAGE_PUSH_*`.
- **Ops/product/security/billing** ([server/jobs/opsMetricsPush.js](https://github.com/Bee-Flow/beeflow/blob/main/server/jobs/opsMetricsPush.js)) — gauge snapshots to the `bee_ops` / `bee_product` / `bee_security` / `bee_billing` streams. Enable with `OPS_PUSH_ENABLED=true`. Tunable via `OPS_PUSH_*`.

See [server/.env.example](https://github.com/Bee-Flow/beeflow/blob/main/server/.env.example) for the full, commented variable list.

## Health checks

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness. Always returns 200 if the process is up. |
| `GET /api/guard/health` | Guard sidecar liveness — returns `not-configured` when `GUARD_SERVICE_URL` is unset. |

Sub-endpoints for DB, Redis, and per-integration readiness are not currently exposed. For Kubernetes probes, point both `livenessProbe` and `readinessProbe` at `/api/health`; the server fails to start if Postgres is unreachable, so a 200 from `/api/health` is a reliable readiness signal.

## Privacy / GDPR notes

For self-hosters running with EU users:

- Set `LOG_LEVEL=info` (not `debug`). Debug-level logs include redacted but more verbose payloads — still no plaintext PII, but more inferable structure.
- Set `EU_MODE_ENABLED=true` (org config). Anonymises IPs, drops `User-Agent` headers from log lines, shortens audit retention to default 30 days.
- Strip request IDs from outgoing logs if you don't want them correlatable across services.
- Ship logs to an EU-region log store.

## Self-host opt-out for telemetry

There are two outbound connections a Bee Flow install can make on its own. Both
are off or disableable without building your own image.

### Browser telemetry (RUM) — off unless you turn it on

The frontend can send real-user-monitoring events (page loads, errors, timings)
to a collector. **In the published images this is off**, and no build flips it
on: the decision is read at container start, not baked in. Turn it on by setting
one variable on the frontend container:

```yaml
frontend:
  environment:
    - BEEFLOW_TELEMETRY_ENABLED=true
    # Optional: send to your own collector instead of ours.
    - BEEFLOW_TELEMETRY_CLIENT_TOKEN=<token>
    - BEEFLOW_TELEMETRY_SITE=observe.example.internal
```

Only the exact string `true` enables it. Anything else — a typo, `1`, `yes`,
unset — leaves it off, so the quiet state is the one you get by doing nothing.

To confirm what your install is doing, open `/beeflow-runtime.js` in a browser:
the file the container wrote says `enabled: false` or `enabled: true`. It is
never cached, so it always reflects the running container.

Note that if you enable it without pointing it somewhere else, the events go to
our collector. If your reason for self-hosting is that data does not leave your
network, either leave this off or set `BEEFLOW_TELEMETRY_SITE` to a collector
you run.

### Licence refresh

Monthly licences ping the licence server. To disable:

```bash
echo 'LICENSE_REFRESH_URL=' >> .env
```

The licence stays valid through `exp` regardless.

Apart from these two, every outbound connection the server makes is in response
to a user prompt or a tool call.

## Research

What this page covers is the data the software records while it runs. Bee Flow
also occasionally asks people to take part in a usability session, which is a
different collection under a different basis: see
[User research](./user-research.md) for what a session records, who may be
asked, how long anything is kept and how to withdraw.
