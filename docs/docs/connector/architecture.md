---
title: Architecture
---

# Architecture

## Transport (deploy daemon)

AppAPI delivers browser/API traffic to the connector container in one of two ways, decided by the **deploy daemon** the admin registered. The same connector image supports both and selects its mode at startup from the `HP_SHARED_KEY` environment variable HaRP injects.

| Mode | Path of a browser request | Listens on | Notes |
|------|---------------------------|------------|-------|
| **`manual-install` / Docker-Socket-Proxy** (legacy) | browser → Nextcloud `app_api/proxy` route → **Nextcloud PHP process** → connector (TCP `APP_PORT`) | TCP `0.0.0.0:$APP_PORT` | Every request occupies a PHP-FPM worker for its whole lifetime, and a streaming answer reaches the browser in one piece at the end. Long-lived streams + bursts can exhaust the pool → intermittent stalled/`502` calls. |
| **HaRP** (recommended) | browser → reverse proxy (`/exapps/`) → **HaRP HAProxy** → FRP tunnel → connector (Unix socket) | Unix socket `/tmp/exapp.sock`, tunnelled out via `frpc` | Bypasses the Nextcloud PHP process entirely; no inbound ports; native streaming/WebSockets. Removes the PHP-worker bottleneck. Needs the [`/exapps/` rule](deploy-daemon.md#exapps-rule) in the reverse proxy. |

In HaRP mode the entrypoint (`scripts/harp-start.sh`) writes an `frpc` config from the `HP_*` env vars and dials out to HaRP's FRP server; the connector binds `/tmp/exapp.sock` instead of a TCP port (`src/server.js`). A HaRP daemon that connects to ExApps directly, without the tunnel (`harp_exapp_direct`, which All-in-One's `harp_aio` daemon uses), passes no `HP_SHARED_KEY`: the connector then runs as in the first row. The SSE chunked-encoding workaround (see below and [Troubleshooting](./troubleshooting.md#err_invalid_chunked_encoding-on-sse-responses)) is applied **only** on the legacy path, because the double-chunking it fixes happens inside Nextcloud's PHP proxy, which HaRP doesn't use. See the [install guide](../getting-started/nextcloud.md#2d-harp) to set up HaRP, and [Deploy daemon and reverse proxy](deploy-daemon.md) for which daemon applies to which install.

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
| `^setup/?$` | GET / POST | ADMIN | The setup page and its save: where Bee Flow runs (Bee Flow Cloud or your own server). See [Choose where Bee Flow runs](setup-picker.md). |
| `^setup/(status\|test\|diagnostics\|…)$` | GET / POST | ADMIN | Status, connection test, diagnostics and the administrator actions of the setup page. |
| `^hooks/` | POST | PUBLIC (brute-force protected) | Deliveries from Nextcloud's `webhook_listeners` app and from Talk. No user session; the connector checks a secret on each delivery. |
| `^webhook/` | POST | ADMIN | Legacy user/group sync bridge. Nothing in Nextcloud delivers to it today. |
| `^nc/` | GET / POST / PUT / DELETE / PATCH / PROPFIND / REPORT / MKCOL / MOVE / COPY | PUBLIC | HMAC-signed reverse proxy back to NC. Nextcloud's PHP proxy only forwards GET, POST, PUT and DELETE, so the Bee Flow service sends every verb except GET and POST as `POST` with `X-HTTP-Method-Override`; the connector restores the real verb. |

AppAPI adds its shared secret to every call it forwards, regardless of access level. The level controls what user attribution AppAPI injects: `USER` makes AppAPI forward the NC userId, `ADMIN` additionally requires the caller to hold the admin role, and `PUBLIC` skips the user-id requirement entirely (static assets, `/heartbeat`, and the routes that bring their own authentication: `/hooks/*` and `/nc/*`).

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

Authenticated: AppAPI sends the shared secret with an empty user id, and a call without it gets `401` and does nothing.

1. Returns `{"status":"ok"}` within ~50 ms.
2. Schedules `runInitInBackground()` via `setImmediate`.
3. Background work in three phases:
   - **25%** — connect to the chosen Bee Flow server (get a tenant key if `BEEFLOW_TENANT_KEY=auto`). While no server is chosen this step does nothing: no request, no file.
   - **60%** — register top-bar entry, embed script, the admin settings form and the Studio app menu entries (parallel).
   - **100%** — register the Talk bot once a Bee Flow server is known and, once a tenant key exists, the Task Processing providers, the Files actions and the `webhook_listeners` rows. Init reaches 100 also while no server is chosen.
4. Errors during background setup → `reportInitProgress(0, errorMessage)` so the AppAPI deploy log surfaces them.

### `/heartbeat`

Unauthenticated, returns `{status:'ok'}`. Nextcloud requires the connector to respond within 10 minutes of startup. Zero side effects. While no Bee Flow server is chosen it answers `{status:'ok', bootstrap:'server_not_chosen'}`: the connector is healthy and waits for an administrator.

### `/enabled?enabled={0|1}`

Authenticated the same way as `/init`. Logs the state change and nothing else: the connector does not remove its registrations (Talk bot, Task Processing providers, Files actions, webhook rows) when it is disabled.

## AppAPI signature on inbound calls

Every AppAPI-proxied call carries:

```
AUTHORIZATION-APP-API: base64(<userId>:<APP_SECRET>)
EX-APP-ID: bee_flow
EX-APP-VERSION: <connector version>
AA-VERSION: <AppAPI version>
AA-REQUEST-ID: <request id>
```

The connector validates the shared secret on every request and rejects with 401 on mismatch. The `<userId>` part of `AUTHORIZATION-APP-API` is empty for service-level calls (e.g. `/init`, `/enabled`, the Task Processing `/trigger`) and holds the Nextcloud user id for user-attributed calls (e.g. an API call originated by a logged-in user). `/heartbeat` is the only route AppAPI calls without these headers.

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
message = "{unixSeconds}\n{HTTP_METHOD}\n{canonicalPath}\n{ncUid}\n{sha256(body)}\nc1"
sig     = HMAC-SHA256(message, tenantKey)
header  = X-Beeflow-Sig: {unixSeconds}.{hexSig}
```

`HTTP_METHOD` is the real verb, also when the request travels as `POST` with `X-HTTP-Method-Override`. `canonicalPath` is the decoded path with its query re-encoded in one fixed form, because the proxy hops in front of the connector re-encode URLs. The body hash binds the signature to the bytes that are written. For an older Bee Flow service the connector still accepts the earlier message forms, including one without the body hash; there is no replay cache, so inside the skew window an identical request can be repeated.

Required headers:

- `X-Beeflow-Sig` — timestamp + HMAC signature
- `X-Beeflow-NC-Uid` — Nextcloud user ID to impersonate (empty for service-level)

Verification (server side):

1. Reject if `unixSeconds` is outside ±300s clock skew (`BEEFLOW_SIG_SKEW_SECONDS`).
2. Recompute HMAC with the loaded tenant key over the method, path, user id and body hash.
3. Constant-time compare with `timingSafeEqual`.
4. Return 401 if the tenant key isn't loaded yet (bootstrap incomplete).

### Tenant key source

No server means no tenant key in memory, whatever the sources below hold.

| Source | Priority |
|--------|----------|
| `BEEFLOW_TENANT_KEY` install-time value | 1 (highest) — used if not literal `auto`, once a server is known |
| `${APP_PERSISTENT_STORAGE}/tenant-key.json` | 2 — written when the chosen server issues the key, file mode `0600` |
| Bootstrap call to the chosen server | 3 — made when an administrator chooses the server |

## Which Bee Flow server

The connector has no Bee Flow server until an administrator chooses one. At every start the server is worked out once, read-only (`src/serverChoice.js`); the first match wins:

1. **Install-time value** — `BEEFLOW_API_BASE_URL` holds the word `cloud` or the URL of a server. Fixed: it cannot be changed from inside Nextcloud. The address `https://server.beeflow.nl` there is not a choice by itself, and an invalid value is logged and ignored.
2. **Existing binding** — `tenant-key.json` holds a key (with `BEEFLOW_TENANT_KEY=auto`): the server that issued it (`boundApiBaseUrl`). A file without that field resolves to the saved choice, else Bee Flow Cloud, and gets the field written at that start.
3. **Saved choice** — `setup-config.json`, written by the setup page or the settings form.
4. **Key for Cloud** — an explicit `BEEFLOW_TENANT_KEY` next to the address `https://server.beeflow.nl`.
5. **None** — the connector waits.

While none is chosen, the connector's own embed script and menu icon are served, a page load gets the setup page (the picker for an administrator, a notice for everybody else), and everything else is answered `503` with code `server_not_chosen`: nothing is proxied and no part of the web app is fetched. The setup actions that need a server (`rotate-tenant-key`, `clear-cache`, `apply-pairing-code`, the e-mail code routes, `diagnose`) answer `409` with the same code. `noServerChosen.test.js` proves that no request leaves for a Bee Flow host and no file is written in this state; see the [decision record](../contributing/decisions/connector-no-default-server.md).

## Bootstrap flow

Runs once a server is chosen: when an administrator chooses it, and at every start after that until the connector holds a key.

1. **Skip if explicit** — if `BEEFLOW_TENANT_KEY` is not `auto`, that key is taken into use directly; no request is made to the Bee Flow server. The instance id that goes with the key is read from Nextcloud as in step 3.
2. **Cache check** — read the persistent file at `APP_PERSISTENT_STORAGE/tenant-key.json`.
3. **Gather metadata** — anonymous OCS call to fetch the NC version and theming name. Nextcloud publishes no instance id in its capabilities, so the connector derives one from the host of the public Nextcloud URL (`nc-host:<host>`) and keeps it in the tenant-key cache.
4. **Discover admin**:
   - **Fast path** — `GET /ocs/v2.php/cloud/groups/admin/users`, single round-trip.
   - **Fallback** — walk `/ocs/v2.php/cloud/users` in parallel batches of 5, looking for first user in the `admin` group.
5. **Call the server's bootstrap** — `POST {apiBaseUrl}/auth/connector/bootstrap` with the Nextcloud's address, instance id and version, and the administrators' names and e-mail addresses.
6. **Anti-spoofing** — the server independently re-fetches the Nextcloud's capabilities to confirm the metadata matches.
7. **Persist** — store the returned `{tenantKey, organizationId, organizationName}` in the cache file, with the server that issued it (`boundApiBaseUrl`).

If a step fails, the connector records the failure with a category and a remediation text; `/heartbeat`, `GET setup/diagnostics` and the setup page show it. A failure of step 3 or 4 is the connector's own read of Nextcloud (`nc_cert_untrusted`, `nc_unreachable`, `admin_lookup_failed`): nothing has been sent to the Bee Flow server at that point.

## Event subscriptions

Real-time events go through Nextcloud's bundled `webhook_listeners` app (`occ app:enable webhook_listeners`). AppAPI's own `events_listener` API no longer exists. Once a tenant key is present the connector keeps one row per event class, registered at `/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks`:

| Area | Event classes | Bee Flow events |
|------|---------------|-----------------|
| Files | `OCP\Files\Events\Node\Node{Created,Written,Deleted,Renamed,Copied}Event`, `NodeRestoredEvent` (when the server has it) | `file.new`, `file.changed`, `file.deleted`, `file.renamed`, `file.copied`, `file.restored` |
| Tags | `OCP\SystemTag\Tag{Assigned,Unassigned}Event` | `file.tagged`, `file.untagged` |
| Calendar | `OCP\Calendar\Events\CalendarObject{Created,Updated,Deleted,Moved}Event` | `calendar.event.created`, `.changed`, `.deleted`, `.moved` |
| Forms (if installed) | `OCA\Forms\Events\FormSubmittedEvent` | `forms.submitted` |
| Tables (if installed) | `OCA\Tables\Event\Row{Added,Updated,Deleted}Event` | `tables.row.added`, `.updated`, `.deleted` |
| Deck (if installed) | `OCA\Deck\Event\Card{Created,Updated,Deleted}Event` | `deck.card.created`, `.changed`, `.deleted` |

Each row has the relative uri `/hooks/nextcloud` and carries a secret header (`X-Beeflow-Hook-Secret`, derived from the tenant key) that the connector checks on delivery. Nextcloud delivers a row with a relative uri through AppAPI to the connector (directly, or through HaRP), so Nextcloud does not call its own public address and `allow_local_remote_servers` is not needed for push triggers. AppAPI waits 3 seconds for the answer; the connector answers within 2 and finishes forwarding to the Bee Flow server afterwards. Registration is idempotent: existing rows are updated in place, rows registered with an absolute address are rewritten, and duplicates are removed. `GET setup/diagnostics` reports under `webhooks` whether the rows are registered, how many deliveries arrived since the connector started and when the last one came in. If `webhook_listeners` is not enabled the connector logs a warning and retries every minute.

Nextcloud dispatches these deliveries from background jobs, so out of the box the delay is the cron interval (5 minutes). For near-real-time delivery run a dedicated worker:

```
occ background-job:worker -t 60 'OCA\WebhookListeners\BackgroundJobs\WebhookCall'
```

Not every Nextcloud event can be delivered this way. User, group and share events are not webhook-compatible, so user and group changes reach Bee Flow through the periodic sync and the manual "Sync now" action. Talk messages arrive through the Talk bot (`/hooks/talk`), not through an event subscription.

## Webhook `/webhook/nc-events`

A legacy bridge for user and group events. It maps an event class to `user.created` / `user.deleted` / `user.updated` / `group.member_added` / `group.member_removed` and forwards it to the Bee Flow service at `POST /auth/webhook/nc-user-sync`, signed with the tenant-key HMAC. Nothing in Nextcloud delivers to it today, because those events cannot be registered with `webhook_listeners`; the route is kept for an internal caller.

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

Install-time values, declared in `appinfo/info.xml`. Give them in the advanced deploy options at install, or with `occ app_api:app:register bee_flow <daemon> --env NAME=VALUE`. AppAPI stores them and passes them again on every update; to change one, run `occ app_api:app:unregister bee_flow` (without `--rm-data` the data volume is kept) and register again with the new values. A variable left blank is not passed at all, and the connector's default applies.

| Var | Default | Purpose |
|-----|---------|---------|
| `BEEFLOW_TENANT_KEY` | `auto` | Tenant key, or literal `auto`: the chosen server issues one |
| `BEEFLOW_API_BASE_URL` | (none) | Empty: an administrator chooses after installing. The word `cloud` or a server URL fixes the server |
| `BEEFLOW_EMBED_BASE_URL` | (none) | Empty: the web app follows the chosen server. A URL forces one web app host. A value that is not a URL is logged and ignored |
| `BEEFLOW_NC_PUBLIC_URL` | (none) | Address at which the Bee Flow server reaches this Nextcloud, when that is not its main URL |
| `BEEFLOW_PAIRING_CODE` | (none) | One-time code that joins this Nextcloud to an existing organisation |
| `BEEFLOW_TRUSTED_EMBED_ORIGINS` | (none) | Extra origins that may frame the app |
| `BEEFLOW_NC_CA_CERT`, `BEEFLOW_NC_TLS_PIN` | (none), `auto` | Trust for a Nextcloud certificate that is self-signed or from an internal CA. `BEEFLOW_NC_CA_CERT` takes the PEM text of the authority's certificate (not a path). `BEEFLOW_NC_TLS_PIN=off` keeps a self-signed certificate refused |
| `BEEFLOW_SERVER_CA_CERT` | (none) | PEM certificate (or a path to one in the container) of the certificate authority of a self-hosted Bee Flow server. Added to the default authorities, used for the Bee Flow server only; verification stays on |
| `HTTPS_PROXY`, `NO_PROXY` | (none) | Outbound forward proxy for https connections to the Bee Flow server, and the hosts reached without it. Nextcloud is always reached directly |
| `BEEFLOW_NC_PROXY_MAX_BODY_MB` | `100` | Largest body of one request from the Bee Flow server into Nextcloud. 0 = no cap |
| `BEEFLOW_NC_PROXY_MAX_INFLIGHT_MB` | `512` | Upload data all such requests together may hold in memory. 0 = no cap |
| `BEEFLOW_UPSTREAM_HEADERS_TIMEOUT_MS` | `60000` | How long the Bee Flow server may take to start answering. 0 = off |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`: the least severe level that is written to the container log |
| `BEEFLOW_SIG_SKEW_SECONDS` | `300` | HMAC clock-skew tolerance, between 30 and 900 |

Not declared in `info.xml`, so settable only where you start the container yourself (a `manual-install` daemon or `docker run`): `BEEFLOW_RUN_AS`, `BEEFLOW_NC_TLS_PROBE_BUDGET_MS`, `BEEFLOW_UPSTREAM_MAX_SOCKETS`, `BEEFLOW_BOOTSTRAP_RETRY_MS`, `BEEFLOW_STUDIO_MENU_SYNC_SECONDS` and `BEEFLOW_JWT_TTL_SECONDS` (default 300, kept between 30 and 900).

## Why returning 200 immediately matters

Earlier versions of the connector ran every step of `/init` synchronously — including ~21 sequential event-listener registrations (10s timeout each). Worst-case install was ~5 minutes; AppAPI's `--wait-finish` polled forever. The current implementation returns within ~50 ms and runs setup in `setImmediate`, reporting progress to AppAPI via `PUT /ocs/v2.php/apps/app_api/ex-app/status`. This is the spec — see [NC AppAPI lifecycle docs](https://nextcloud.github.io/app_api/notes_for_developers/ExAppLifecycle.html).
