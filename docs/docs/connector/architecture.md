---
title: Architecture
---

# Architecture

## Transport (deploy daemon)

AppAPI delivers browser/API traffic to the connector container in one of two ways, decided by the **deploy daemon** the admin registered. The same connector image supports both and selects its mode at startup from the `HP_SHARED_KEY` environment variable HaRP injects.

| Mode | Path of a browser request | Listens on | Notes |
|------|---------------------------|------------|-------|
| **`manual-install` / Docker-Socket-Proxy** (legacy) | browser → Nextcloud `app_api/proxy` route → **Nextcloud PHP process** → connector (TCP `APP_PORT`) | TCP `0.0.0.0:$APP_PORT` | Every request occupies a PHP-FPM worker for its whole lifetime. Long-lived streams + bursts can exhaust the pool → intermittent stalled/`502` calls. Required for Nextcloud 31. |
| **HaRP** (recommended, NC 32+) | browser → **HaRP HAProxy** → FRP tunnel → connector (Unix socket) | Unix socket `/tmp/exapp.sock`, tunnelled out via `frpc` | Bypasses the Nextcloud PHP process entirely; no inbound ports; native streaming/WebSockets. Removes the PHP-worker bottleneck. |

In HaRP mode the entrypoint (`scripts/harp-start.sh`) writes an `frpc` config from the `HP_*` env vars and dials out to HaRP's FRP server; the connector binds `/tmp/exapp.sock` instead of a TCP port (`src/server.js`). The SSE chunked-encoding workaround (see below and [Troubleshooting](./troubleshooting.md#err_invalid_chunked_encoding-on-sse-responses)) is applied **only** on the legacy path, because the double-chunking it fixes happens inside Nextcloud's PHP proxy, which HaRP doesn't use. See the [install guide](../getting-started/nextcloud.md#2d-harp-recommended-for-nextcloud-32) to set up HaRP.

## Routes and access levels

The connector serves a strict allow-list of paths declared in [`appinfo/info.xml`](https://github.com/Bee-Flow/connector/blob/main/appinfo/info.xml). Anything not matched is rejected by AppAPI before it reaches the connector.

| Path | Verb | Access | Purpose |
|------|------|--------|---------|
| `^$`, `^index.html`, `^favicon.ico`, `^assets/`, `^js/`, `^img/`, `^bee-flow-logo.*` | GET | PUBLIC | Static SPA shell |
| `^api/` | GET / POST / PUT / DELETE / PATCH | USER | SaaS-proxied REST + SSE. USER (not PUBLIC) so AppAPI forwards the NC userId in `AUTHORIZATION-APP-API`; the connector mints a per-user SaaS JWT from it. |
| `^auth/` | GET / POST / PUT / DELETE / PATCH | USER | SaaS-proxied auth + OAuth flows. Same USER requirement as `^api/`. |
| `^heartbeat$` | GET | PUBLIC | AppAPI liveness probe |
| `^init$` | POST | ADMIN | AppAPI lifecycle install hook |
| `^enabled$` | PUT | ADMIN | AppAPI lifecycle enable/disable hook |
| `^setup/?$` | GET / POST | ADMIN | Setup picker UI + form submit (Bee Flow Cloud vs self-hosted). |
| `^setup/(status\|test)$` | GET / POST | ADMIN | Setup picker status + connectivity test endpoints. |
| `^webhook/` | POST | ADMIN | NC events_listener forwarder |
| `^nc/` | GET / POST / PUT / DELETE / PATCH / PROPFIND / REPORT / MKCOL / MOVE / COPY | PUBLIC | HMAC-signed reverse proxy back to NC |

AppAPI signs every call regardless of access level. The level only controls what user attribution AppAPI injects: `USER` makes AppAPI forward the NC userId, `ADMIN` additionally requires the caller to hold the admin role, and `PUBLIC` skips the user-id requirement entirely (used only for lifecycle hooks called by NC itself, not by browsers).

## Lifecycle

Per the [NC AppAPI spec](https://nextcloud.github.io/app_api/notes_for_developers/ExAppLifecycle.html):

```
Install → POST /init           ─▶ HTTP 200 immediately
       ⌙                          background work runs in setImmediate()
       PUT /ocs/v2.php/apps/app_api/ex-app/status {progress: N}
       PUT /ocs/v2.php/apps/app_api/ex-app/status {progress: 100}

Up    → GET /heartbeat          ─▶ {"status":"ok"}     (every ~10s by AppAPI)

Enable/disable → PUT /enabled?enabled=0|1
```

### `/init`

1. Returns `{"status":"ok"}` within ~50 ms.
2. Schedules `runInitInBackground()` via `setImmediate`.
3. Background work in three phases:
   - **25%** — bootstrap (provision tenant key if `BEEFLOW_TENANT_KEY=auto`).
   - **60%** — register top-bar entry + embed script (parallel).
   - **100%** — register 5 event listeners (parallel, with the AppAPI-33.0.0 short-circuit).
4. Errors during background setup → `reportInitProgress(0, errorMessage)` so the AppAPI deploy log surfaces them.

### `/heartbeat`

Unauthenticated, returns `{status:'ok'}`. Nextcloud requires the connector to respond within 10 minutes of startup. Zero side effects.

### `/enabled?enabled={0|1}`

Authenticated. Logs the state change. Reserved for future suspend / resume hooks; no immediate action today.

## AppAPI signature on inbound calls

Every AppAPI-proxied call carries:

```
AUTHORIZATION-APP-API: base64(<userId>:<APP_SECRET>)
EX-APP-ID: bee_flow
EX-APP-VERSION: 0.1.0
EX-APP-USER-ID: <ncUid or empty>
```

The connector validates the shared secret on every request and rejects with 401 on mismatch. `EX-APP-USER-ID` is empty for service-level calls (e.g. `/init`) and populated for user-attributed calls (e.g. an API call originated by a logged-in user).

## HMAC `/nc/*` reverse-proxy

The Bee Flow service can call back into Nextcloud through a separate proxy. Used for any API the assistant needs (Files via WebDAV, Mail via the Mail app REST API, Calendar via CalDAV, etc.).

### Allowed paths

| Path prefix | Used for |
|-------------|----------|
| `/ocs/*` | Provisioning, capabilities, user info |
| `/remote.php/dav/*` | WebDAV, CalDAV, CardDAV |
| `/index.php/apps/*` | Mail, Deck, Notes, Talk, Activity |

Anything else returns 404.

### Signature

```
message = "{unixSeconds}\n{HTTP_METHOD}\n{path}\n{ncUid}"
sig     = HMAC-SHA256(message, tenantKey)
header  = X-Beeflow-Sig: {unixSeconds}.{hexSig}
```

Required headers:

- `X-Beeflow-Sig` — timestamp + HMAC signature
- `X-Beeflow-NC-Uid` — Nextcloud user ID to impersonate (empty for service-level)

Verification (server side):

1. Reject if `unixSeconds` is outside ±300s clock skew (`BEEFLOW_SIG_SKEW_SECONDS`).
2. Recompute HMAC with the loaded tenant key.
3. Constant-time compare with `timingSafeEqual`.
4. Return 401 if the tenant key isn't loaded yet (bootstrap incomplete).

### Tenant key source

| Source | Priority |
|--------|----------|
| `BEEFLOW_TENANT_KEY` env var | 1 (highest) — used if not literal `auto` |
| `${APP_PERSISTENT_STORAGE}/tenant-key.json` | 2 — cached after first bootstrap, file mode `0600` |
| Bootstrap call to SaaS | 3 — issued on first `/init` |

## Bootstrap flow

Triggered on startup and again on `/init` if no cache is found.

1. **Skip if explicit** — if `BEEFLOW_TENANT_KEY` is not `auto`, use that key directly.
2. **Cache check** — read the persistent file at `APP_PERSISTENT_STORAGE/tenant-key.json`.
3. **Gather metadata** — anonymous OCS call to fetch the NC instance ID, version, and theming name.
4. **Discover admin**:
   - **Fast path** — `GET /ocs/v2.php/cloud/groups/admin/users`, single round-trip.
   - **Fallback** — walk `/ocs/v2.php/cloud/users` in parallel batches of 5, looking for first user in the `admin` group.
5. **Call SaaS bootstrap** — `POST {apiBaseUrl}/auth/connector/bootstrap` with NC instance metadata in headers.
6. **Anti-spoofing** — the SaaS independently re-fetches NC capabilities to confirm the metadata matches.
7. **Persist** — store the returned `{tenantKey, organizationId, organizationName}` in the cache file.

If any step fails, the connector logs the error and continues; the admin sees "ExApp unhealthy" in NC, which surfaces the misconfiguration.

## Event subscriptions

The connector subscribes to 5 NC events on first init:

| Event class | NC event | Mapped to webhook event |
|-------------|----------|--------------------------|
| `OCP\User\Events\UserCreatedEvent` | User added | `user.created` |
| `OCP\User\Events\UserDeletedEvent` | User removed | `user.deleted` |
| `OCP\User\Events\UserChangedEvent` | User updated (mail, name) | `user.updated` |
| `OCP\Group\Events\UserAddedEvent` | User joined a group | `group.member_added` |
| `OCP\Group\Events\UserRemovedEvent` | User left a group | `group.member_removed` |

Per-call timeout: 3 seconds. Calls run in parallel. NC enforces unique `(appId, eventType, actionHandler)` and returns 409 on duplicate (idempotent re-init). NC 33.0.0's broken `EventsListenerController` returns 500 — the connector probes the first call and skips the rest if it sees the controller-missing error message.

## Webhook `/webhook/nc-events`

NC's events listener POSTs to this path on every fired event. Payload (best-effort field extraction):

```json
{
  "eventType": "OCP\\User\\Events\\UserCreatedEvent",
  "userId": "alice",
  "groupId": "engineering"
}
```

The connector maps the event class to `user.created` / `user.deleted` / `user.updated` / `group.member_added` / `group.member_removed` and forwards to the SaaS at `POST /auth/webhook/nc-user-sync`, signed with the same tenant-key HMAC. 10s timeout, best-effort — failures log a warning and return 200 to NC (NC won't retry).

## Connector environment variables

Set by AppAPI / Dockerfile (you don't normally touch these):

| Var | Default | Purpose |
|-----|---------|---------|
| `APP_ID` | `bee_flow` | ExApp identifier |
| `APP_SECRET` | (required) | AppAPI shared secret |
| `APP_VERSION` | `0.0.0` | Version string |
| `APP_HOST` | `0.0.0.0` | Always bound to all interfaces (HaRP compat) |
| `APP_PORT` | `8080` | Internal listen port |
| `APP_PERSISTENT_STORAGE` | `/data` | Tenant-key cache directory |
| `NEXTCLOUD_URL` | (required) | Base URL of the NC instance |

Admin-configurable via `occ app_api:app:setenv`:

| Var | Default | Purpose |
|-----|---------|---------|
| `BEEFLOW_TENANT_KEY` | `auto` | Tenant key, or literal `auto` for one-click install |
| `BEEFLOW_API_BASE_URL` | `https://server.beeflow.nl` | Bee Flow service URL — override for staging / on-prem |
| `BEEFLOW_JWT_TTL_SECONDS` | `300` | JWT expiry (short on purpose) |
| `BEEFLOW_SIG_SKEW_SECONDS` | `300` | HMAC clock-skew tolerance (±5 min) |

## Why returning 200 immediately matters

Earlier versions of the connector ran every step of `/init` synchronously — including ~21 sequential event-listener registrations (10s timeout each). Worst-case install was ~5 minutes; AppAPI's `--wait-finish` polled forever. The current implementation returns within ~50 ms and runs setup in `setImmediate`, reporting progress to AppAPI via `PUT /ocs/v2.php/apps/app_api/ex-app/status`. This is the spec — see [NC AppAPI lifecycle docs](https://nextcloud.github.io/app_api/notes_for_developers/ExAppLifecycle.html).
