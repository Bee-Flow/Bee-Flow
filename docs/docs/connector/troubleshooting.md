---
title: Troubleshooting
---

# Troubleshooting

A reference of common problems with the connector. For each: symptom → cause → fix.

## Some API calls intermittently stall or fail (only under load)

Symptom: the app mostly works, but **some** requests randomly hang or return `502` — often on page load (when the app fires many requests at once) or while a chat is streaming. Reloading sometimes helps. The connector logs look clean; in the browser **Network** tab a handful of `…/apps/app_api/proxy/bee_flow/…` requests sit in **(pending)** or come back `502`, frequently while a `…/stream` request is open. It "should work exactly the same" for every call — and the connector does treat them identically.

Cause: you're on a `docker-install` / Docker-Socket-Proxy daemon, where **every** browser→connector request is proxied **through a Nextcloud PHP-FPM worker**, held for the full lifetime of the request. A long-lived chat stream pins a worker for minutes; the burst of calls the app makes on load needs several more at once. When Nextcloud's PHP-FPM pool (often only 5–16 workers) is exhausted, whichever requests lose the race for a free worker stall → time out → `502`, non-deterministically. This is a property of the transport, not the connector.

Confirm it (run during a reproduction — replace the container name as needed):

```bash
# Connector logs are quiet but the browser still got 502s → failure is upstream in PHP:
docker logs nc_app_bee_flow --tail 500 2>&1 | grep -E "\[Proxy\]|User lookup failed|502"

# PHP-FPM saturation is the smoking gun — look for "max children reached" / a non-zero listen queue
# during the burst (path/method depends on your image's FPM status config):
docker exec <nextcloud-container> sh -c 'ps -C php-fpm --no-headers | wc -l'   # sampled repeatedly during load
```

Fix: **[migrate to HaRP](#migrate-to-harp)** (Nextcloud 32+). HaRP routes browser→connector traffic directly, bypassing PHP, so concurrent requests and streams no longer compete for PHP workers.

## Migrate to HaRP

Moving the connector from a `docker-install` / Docker-Socket-Proxy daemon to [HaRP](../getting-started/nextcloud.md#2d-harp-recommended-for-nextcloud-32) (Nextcloud 32+) fixes the intermittent-dropped-calls problem above and improves streaming. The connector image is already HaRP-aware — it switches transport automatically when HaRP is in use; this is a **daemon change**, not an app change.

:::warning[Capture your tenant key first]
The tenant key lives in the connector's container-local `/data/tenant-key.json`. Re-deploying onto a new daemon starts a **fresh container with empty `/data`**, which would try to re-provision and hit `409 instance already provisioned`. Capture the key and re-inject it explicitly so your organisation and all its data are preserved.
:::

```bash
# 0. Preconditions + capture state
sudo -u www-data php occ status | grep versionstring          # must be 32+
docker exec nc_app_bee_flow cat /data/tenant-key.json         # save the "tenantKey" value
sudo -u www-data php occ app_api:daemon:list                  # note the CURRENT daemon (for rollback)

# 1. Register the HaRP daemon (see Install guide §2d for the full command + UI path)
#    occ app_api:daemon:register harp1 "HaRP" docker-install https <harp-host>:8780 ... --harp ...
sudo -u www-data php occ app_api:daemon:test harp1

# 2. Move bee_flow onto HaRP, re-injecting the captured key so bootstrap is a no-op
sudo -u www-data php occ app_api:app:disable bee_flow
sudo -u www-data php occ app_api:app:unregister bee_flow      # removes the old container
sudo -u www-data php occ app_api:app:register bee_flow harp1 \
  --info-xml https://raw.githubusercontent.com/Bee-Flow/connector/main/appinfo/info.xml \
  --env "BEEFLOW_TENANT_KEY=<captured-tenant-key>" \
  --env "BEEFLOW_API_BASE_URL=https://server.beeflow.nl" \
  --env "BEEFLOW_NC_PUBLIC_URL=https://cloud.example.com"
sudo -u www-data php occ app_api:app:enable bee_flow

# 3. Verify
sudo -u www-data php occ app_api:app:heartbeat bee_flow                       # → {"status":"ok"}
docker inspect --format '{{.State.Health.Status}}' nc_app_bee_flow           # → healthy
docker logs nc_app_bee_flow 2>&1 | grep -i "HaRP mode"                       # confirms socket transport
```

To prove the bug is fixed: open a chat (keep the stream running) and hard-reload a few times while watching the Network tab — every request should return `200`, even under the concurrent load that previously produced `502`s.

**Rollback** (symmetric, no data loss — re-use the *same* captured key): `app:disable` → `app:unregister` → `app:register bee_flow <old-daemon>` with the same `--env BEEFLOW_TENANT_KEY=…` → `app:enable`. The HaRP daemon can stay registered (inert) for a later retry.

## "Install" button in the App Store does nothing

The Nextcloud Apps page accepts the install request but no ExApp container ever appears:

```bash
sudo -u www-data php occ app_api:daemon:list
# → (empty)
```

You need a deploy daemon. Bee Flow can't be installed without one — AppAPI has no idea where to put the container. Pick the right setup:

| Your Nextcloud | Action |
|---|---|
| Vanilla self-hosted | [Register a `docker-install` daemon](../getting-started/nextcloud#2a-vanilla-nextcloud) — one `occ app_api:daemon:register` command. |
| Nextcloud All-in-One | The AIO master container usually pre-registers it. If `daemon:list` is empty, [register the AIO socket proxy](../getting-started/nextcloud#2b-nextcloud-all-in-one). |
| Shared / multi-tenant | Use [HaRP](https://docs.nextcloud.com/server/latest/admin_manual/app_api/harp.html). |

After registering, click **Install** in the App Store again — it'll succeed this time.

## Bee Flow installs but user-sync is degraded

Symptom: bee icon shows up, chat works, but a yellow banner appears: *"User sync degraded: SaaS cannot reach this Nextcloud."* Or webhooks are silently never delivered.

Cause: Bee Flow Cloud can't reach your Nextcloud at the URL it was told to use. Common with reverse-proxied or NAT'd instances where `NEXTCLOUD_URL` is an internal hostname.

Fix: set `BEEFLOW_NC_PUBLIC_URL` to your **public** Nextcloud URL:

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow \
  BEEFLOW_NC_PUBLIC_URL "https://cloud.example.com"
sudo -u www-data php occ app_api:app:redeploy bee_flow
```

Verify from outside (your laptop / a phone on cellular):

```bash
curl "https://cloud.example.com/status.php"
# → {"installed":true,...}
```

## Bootstrap "failed" state in heartbeat

Starting v0.2, `/heartbeat` returns a `failed` state with a category and remediation when the SaaS handshake fails. View it:

```bash
docker exec nc_app_bee_flow curl -s http://127.0.0.1:23000/heartbeat
# → {"status":"failed","category":"saas_unreachable","error":"...","nextRetryAt":"..."}
```

| Category | Meaning | Fix |
|---|---|---|
| `saas_unreachable` | Connector can't reach the Bee Flow server | Test `curl https://server.beeflow.nl/api/health` from inside the container. Whitelist that hostname in your egress firewall. |
| `nc_not_publicly_reachable` | SaaS bootstrap check couldn't reach your NC | Set `BEEFLOW_NC_PUBLIC_URL` (see section above), or switch to self-hosted Bee Flow via the setup picker. |
| `admin_lookup_failed` | No admin user found in NC's `admin` group | `occ user:add --group admin <uid>` then `occ app_api:app:redeploy bee_flow`. |
| `appstore_signature_invalid` | Downloaded tarball signature mismatch (rare) | Uninstall and reinstall from the App Store. |

The next retry is scheduled automatically; you don't need to redeploy unless you've changed the underlying problem.

## Install hangs at "Deploying…"

| Symptom | Cause | Fix |
|---------|-------|-----|
| AppAPI deploy log shows `Image pull failed` | Daemon can't reach `ghcr.io` | `docker pull ghcr.io/bee-flow/connector:latest` from the host running the daemon. Whitelist `ghcr.io` + `pkg-containers.githubusercontent.com` in your egress firewall. |
| HaRP deploy returns `500 Internal Server Error` on `images/create` from a local registry | HaRP's Docker daemon doesn't trust HTTP registries | Add `{"insecure-registries":["registry:5000"]}` to the HaRP daemon's `/etc/docker/daemon.json` and restart, **or** switch to the `manual-install` daemon for local dev. |
| Deploy succeeds but heartbeat times out | Port 23000 already in use on the host | Stop the conflicting container, or change the AppAPI port mapping for the daemon. |
| Init reports `progress=0` and an error | Bootstrap failure (e.g. SaaS unreachable) | Check `docker logs nc_app_bee_flow` — see "Tenant key bootstrap" below. |

## "Heartbeat failed" in Nextcloud admin

The connector container is up but Nextcloud can't reach it. Run:

```bash
sudo -u www-data php occ app_api:app:heartbeat bee_flow
```

| Returns | Likely cause |
|---------|--------------|
| `{"status":"ok"}` from CLI but UI still red | Stale UI cache — refresh **Administration → AppAPI**. |
| `Connection refused` | Container not running. `docker ps \| grep bee_flow`, then `docker logs nc_app_bee_flow`. |
| `404 Not Found` | Wrong port mapping. Inspect `docker inspect nc_app_bee_flow` and confirm `23000` is published. |
| `Network unreachable` | NC and connector aren't on the same Docker network. Verify with `docker network inspect`. |

## Tenant key bootstrap fails

| Symptom in `docker logs nc_app_bee_flow` | Cause | Fix |
|------------------------------------------|-------|-----|
| `[Bootstrap] capabilities fetch timeout` | Connector can't reach NC | Check `NEXTCLOUD_URL` env. Ping it from inside the container: `docker exec nc_app_bee_flow curl $NEXTCLOUD_URL/status.php`. |
| `[Bootstrap] admin discovery: no admin found` | NC has no user in the `admin` group | Create one: `occ user:add --group admin alice`. |
| `[Bootstrap] SaaS responded 401` | Bee Flow service rejected the AppAPI signature | Check clocks (NTP) on both hosts. Verify `BEEFLOW_API_BASE_URL` is reachable. |
| `[Bootstrap] SaaS responded 409: instance already provisioned` | This NC was bootstrapped before; the tenant-key cache was lost | Recover the key from the SaaS admin UI (or contact support), set `BEEFLOW_TENANT_KEY=<key>` via `occ app_api:app:setenv`. |

The cache file is at `${APP_PERSISTENT_STORAGE}/tenant-key.json`. If it gets corrupted:

```bash
docker exec nc_app_bee_flow rm /data/tenant-key.json
docker exec nc_app_bee_flow kill -USR1 1   # triggers re-bootstrap, or just restart the container
```

## "Setup in progress" never goes away

Other users see this until the org admin completes the wizard. If you are the admin and still see it:

1. Reload the page (Cmd/Ctrl+Shift+R).
2. Check **Administration → AppAPI** — Bee Flow should show **Enabled**.
3. Check the connector logs: `docker logs nc_app_bee_flow --tail 100`.
4. Hit the SaaS health endpoint: `curl https://server.beeflow.nl/api/health` (or your self-hosted URL).

If the SaaS health is fine but the wizard still shows "Setup in progress", the tenant-key bootstrap probably ran but the SaaS didn't finish creating the org row. Restart the connector to force re-bootstrap.

## `ERR_INVALID_CHUNKED_ENCODING` on SSE responses

This only affects the **`docker-install` / Docker-Socket-Proxy daemons**, where the SSE response passes through Nextcloud's PHP AppAPI proxy. (On [HaRP](#migrate-to-harp) the stream goes straight to the connector, so this can't happen — and the connector skips the workaround there to keep the tunnel connection alive.)

When the browser shows `ERR_INVALID_CHUNKED_ENCODING` and the chat stream dies mid-reply, the issue is Nextcloud's AppAPI proxy stripping the `Transfer-Encoding: chunked` header from the connector's SSE response without rewriting the body. The connector works around this by forcing `useChunkedEncodingByDefault=false` and adding `Connection: close` on every SSE proxy hop, so plain `Content-Length`-less bodies flow through cleanly.

If you still see it after upgrading to a connector built from commit `af26662` or later:

1. Verify your `nc_app_bee_flow` container is up-to-date: `docker exec nc_app_bee_flow node -e "console.log(require('./package.json').version)"`.
2. Confirm no upstream reverse proxy (nginx, traefik) is re-introducing chunked encoding on the NC → browser hop — check `proxy_buffering off;` and `proxy_http_version 1.1;` in the NC vhost.
3. Capture a `curl -N -v https://<nc-host>/index.php/apps/app_api/proxy/bee_flow/api/...` against an SSE endpoint and attach the headers to a bug report — the response should have `Connection: close` and no `Transfer-Encoding`.

## Nextcloud 33.0.0 — broken events listener

NC 33.0.0 ships AppAPI with a broken `EventsListenerController` that returns 500 to every `POST /ocs/v1.php/apps/app_api/api/v1/events_listener`. The connector probes the first call, detects this, and **skips the rest of the registrations** with a log line:

```
[Init] AppAPI 33.0.0 detected — events listener disabled
```

Effect: user/group changes in NC won't auto-sync to Bee Flow until you upgrade. The 6-hourly **NC Sync Backstop** job catches up — most teams won't notice. Upgrade to 33.0.1+ to restore real-time sync.

## HMAC clock-skew rejections

If Bee Flow service-side calls fail with:

```
401 Unauthorized: HMAC timestamp out of skew window
```

…the connector and the Bee Flow server have clocks more than 5 minutes apart. Fix:

```bash
sudo timedatectl set-ntp true
sudo systemctl restart systemd-timesyncd
```

To loosen the window temporarily (not recommended for prod):

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow BEEFLOW_SIG_SKEW_SECONDS 600
```

## JWT TTL expired

The connector mints short-lived JWTs (default 300 s) for browser-side calls. If you see:

```
401 Unauthorized: token expired
```

…the SPA's token wasn't refreshed in time. The frontend usually auto-refreshes; if it doesn't, hard-reload the page. If it still fails, raise the TTL temporarily:

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow BEEFLOW_JWT_TTL_SECONDS 600
```

(The short default is intentional — leaked-token containment.)

## Where to look

| Component | How to view logs |
|-----------|------------------|
| Connector container | `docker logs nc_app_bee_flow --tail 200 -f` |
| Nextcloud (AppAPI) | `tail -f data/nextcloud.log \| grep '"app":"app_api"'` |
| Nextcloud (Bee Flow specific) | `tail -f data/nextcloud.log \| grep bee_flow` |
| Bee Flow server (self-hosted) | `docker logs beeflow-server --tail 200 -f` |
| AppAPI deploy state | `occ app_api:app:list` and `occ app_api:app:status bee_flow` |
| Heartbeat | `occ app_api:app:heartbeat bee_flow` |

## Recovery commands cheat sheet

```bash
# Stop, remove, redeploy from clean
sudo -u www-data php occ app_api:app:unregister bee_flow
sudo -u www-data php occ app_api:app:register bee_flow \
  --info-xml https://raw.githubusercontent.com/Bee-Flow/connector/main/appinfo/info.xml

# Force a fresh tenant-key bootstrap
docker exec nc_app_bee_flow rm /data/tenant-key.json
docker restart nc_app_bee_flow

# Pin to a specific connector version
sudo -u www-data php occ app_api:app:update bee_flow --image-tag 0.2.0
```

## Where to ask

- Bug reports: [https://github.com/Bee-Flow/connector/issues](https://github.com/Bee-Flow/connector/issues)
- Security disclosure: [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl)
- Commercial: [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl)
