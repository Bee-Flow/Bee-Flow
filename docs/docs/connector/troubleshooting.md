---
title: Troubleshooting
---

# Troubleshooting

A reference of common problems with the connector. For each: symptom → cause → fix.

## "Bee Flow is not set up yet" (`server_not_chosen`)

Symptom: users who open Bee Flow read *"Bee Flow is not set up yet. Ask your Nextcloud administrator to open Bee Flow and choose where it runs."* The heartbeat answers `{"status":"ok","bootstrap":"server_not_chosen"}`, calls of the web app answer `503` with the code `server_not_chosen`, and some setup actions answer `409` with the same code.

Cause: this is not a failure. The connector has no Bee Flow server until a Nextcloud administrator chooses one, and it sends nothing before that choice. It is the state of every new install, and of an install that never finished connecting before it was updated to 2.0.0.

Fix: open **Bee Flow** from the top bar as a Nextcloud administrator and choose Bee Flow Cloud or your own server. See [Choose where Bee Flow runs](setup-picker.md).

| Also seen in this state | Why |
|---|---|
| `BEEFLOW_API_BASE_URL` holds `https://server.beeflow.nl` and the page says that this address is not a choice | Choose Bee Flow Cloud on the page, or register the app again with the word `cloud` to fix Bee Flow Cloud at install time. |
| Connect answers "server unreachable" and nothing is saved | The address did not answer `/api/health` from the connector container. Use **Test connection**; from the container: `docker exec nc_app_bee_flow curl -s <your-url>/api/health`. |
| Connect answers "certificate not trusted" | The server's certificate does not verify. Use a certificate from a public certificate authority, or register the app again with `--env BEEFLOW_SERVER_CA_CERT=<PEM or path>`. Verification cannot be switched off. |
| A tenant key was given at install but Bee Flow is "not set up yet" | The key came without a server address. Choose the server on the setup page; the key is then taken into use as it is. |
| A code that was e-mailed before the update is refused | Choose the server; a new code is sent. |

## "Your Nextcloud account has no e-mail address"

Bee Flow needs an e-mail address for every user. An account without one gets this page instead of the app (calls of the web app answer `403` with the code `no_email`). Add an address under **Personal settings** in Nextcloud, or have an administrator set one. Setup, diagnostics and the administrator pages work without an address.

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

Fix: **[migrate to HaRP](#migrate-to-harp)**. HaRP routes browser→connector traffic directly, bypassing PHP, so concurrent requests and streams no longer compete for PHP workers. On the same daemons a streaming answer also arrives in one piece at the end; see [Why HaRP](deploy-daemon.md#why-harp).

## Migrate to HaRP

Moving the connector from a `docker-install` / Docker-Socket-Proxy daemon to [HaRP](../getting-started/nextcloud.md#2d-harp) fixes the intermittent-dropped-calls problem above and improves streaming. The connector image is already HaRP-aware — it switches transport automatically when HaRP is in use; this is a **daemon change**, not an app change.

**What carries the connection over.** The connector keeps its connection (the server that was chosen and the key of your organisation) in its data volume. AppAPI keeps that volume when you remove an app, unless you ask for `--rm-data` (in the admin interface: the "Delete data when removing" checkbox). So the order is: remove the app **without** deleting its data, then install it again on the HaRP daemon. HaRP has to run on the **same Docker engine** as the old daemon, because the volume lives there. This follows the migration steps of the [HaRP README](https://github.com/nextcloud/HaRP#nextcloud-32-migrating-existing-exapps-from-dsp-to-harp); we read the behaviour in the AppAPI source and did not run this migration ourselves.

```bash
# 0. Before you start
sudo -u www-data php occ status | grep versionstring          # 33, 34 or 35
sudo -u www-data php occ app_api:daemon:list                  # note the CURRENT daemon (for going back)

# 1. Run HaRP on the same Docker engine, add the /exapps/ rule to your reverse proxy,
#    and register the daemon (install guide §2d, and "Deploy daemon and reverse proxy").
#    Then run "Test deploy" from the daemon's menu under Administration → AppAPI.

# 2. Move bee_flow onto HaRP. No --rm-data: the data volume is kept.
sudo -u www-data php occ app_api:app:disable bee_flow
sudo -u www-data php occ app_api:app:unregister bee_flow
sudo -u www-data php occ app_api:app:register bee_flow harp1 \
  --info-xml https://raw.githubusercontent.com/Bee-Flow/connector/main/appinfo/info.xml

# 3. Verify
sudo -u www-data php occ app_api:app:list                                    # → bee_flow (Bee Flow): <version> [enabled]
docker inspect --format '{{.State.Health.Status}}' nc_app_bee_flow           # → healthy
docker logs nc_app_bee_flow 2>&1 | grep -i "HaRP mode"                       # the connector listens on its socket
```

**Install-time values.** Removing the app also removes the values AppAPI stored for it, so give the ones you used again in the `register` command, each as `--env NAME=VALUE` (for example `BEEFLOW_NC_PUBLIC_URL` or `BEEFLOW_SERVER_CA_CERT`). For `BEEFLOW_API_BASE_URL`:

- If you chose the server on the setup page, leave it out. The connector finds its server in the data volume.
- If the server was fixed at install time, give the same value again: the word `cloud` for Bee Flow Cloud, or the URL of your Bee Flow server. A value given here fixes the server; it cannot be changed from inside Nextcloud afterwards.

**If the connection did not come along.** When Bee Flow opens with the setup page, or shows `pairing_required`, the connector started without its data: HaRP runs on another Docker engine, or the data was removed. Nothing is lost on the Bee Flow server. Choose the same server again on the setup page, and when it asks for a pairing code, have a Bee Flow organisation admin generate one (**Settings → Organisation → Pair a new Nextcloud**) and enter it there. The Nextcloud is then joined to the organisation it had.

If you know beforehand that HaRP will run on another Docker engine, you can instead carry the key over yourself: read `tenantKey` from `/data/tenant-key.json` in the old container before you remove it, and register with `--env BEEFLOW_TENANT_KEY=<that key>`. The key is taken into use once the server is known: when an administrator chooses it on the setup page, or at once when you also give `BEEFLOW_API_BASE_URL` (which then fixes the server). Treat that key as a secret.

To see the difference: open a chat and watch the answer arrive word by word, and hard-reload a few times with the Network tab open while a stream runs — the requests no longer wait for each other.

**Going back.** The same steps with the old daemon's name in `register`. The HaRP daemon can stay registered for a later retry.

:::note Nextcloud All-in-One
- All-in-One's HaRP daemon (`harp_aio`) reaches the connector through Nextcloud's AppAPI proxy path, so moving to it replaces the deprecated daemon but does not change how streams travel. See [Deploy daemon and reverse proxy → Nextcloud All-in-One](deploy-daemon.md#aio).
- After the move, the old `docker_aio` daemon stays registered, with every other ExApp that is still on it. `occ app_api:daemon:unregister docker_aio` refuses while ExApps are on that daemon. Move those ExApps first, in the same way, and only then remove the daemon and untick the Docker Socket Proxy container.
:::

## "Install" button in the App Store does nothing

The Nextcloud Apps page accepts the install request but no ExApp container ever appears:

```bash
sudo -u www-data php occ app_api:daemon:list
# → (empty)
```

You need a deploy daemon. Bee Flow can't be installed without one — AppAPI has no idea where to put the container. Pick the right setup:

| Your Nextcloud | Action |
|---|---|
| Your own host with Docker (bare metal, VM, community Docker image) | [Run HaRP and register it](../getting-started/nextcloud.md#2d-harp), and add the [`/exapps/` rule](deploy-daemon.md#exapps-rule) to your reverse proxy. |
| Nextcloud All-in-One | Tick **HaRP** in the All-in-One interface; see [§2b](../getting-started/nextcloud.md#2b-nextcloud-all-in-one). |
| Managed or shared hosting where you cannot run Docker | Not possible here: the connector needs a Docker (or Kubernetes) deploy daemon. Bee Flow works with such a Nextcloud without the connector, see [No Docker on your Nextcloud host?](../integrations/nextcloud.md#no-docker) |

The full table per install method is in [Deploy daemon and reverse proxy](deploy-daemon.md#per-install-method); Nextcloud's own description of every daemon setup is in its [deployment configurations](https://docs.nextcloud.com/server/latest/admin_manual/exapps_management/DeployConfigurations.html).

After registering, click **Install** in the App Store again.

## Bee Flow installs but user-sync is degraded

Symptom: bee icon shows up, chat works, but a yellow banner appears: *"User sync degraded: SaaS cannot reach this Nextcloud."* Or webhooks are silently never delivered.

Cause: your Bee Flow server can't reach your Nextcloud at the URL it was told to use. Common with reverse-proxied or NAT'd instances where `NEXTCLOUD_URL` is an internal hostname.

Fix: enter your **public** Nextcloud URL under **Public Nextcloud URL** on the [setup page](setup-picker.md#where-the-setup-page-is). To give it at install time instead, register the app with `--env BEEFLOW_NC_PUBLIC_URL=https://cloud.example.com`.

Verify from outside (your laptop / a phone on cellular):

```bash
curl "https://cloud.example.com/status.php"
# → {"installed":true,...}
```

If your Nextcloud has no address that is reachable from outside, see the next section.

## Nextcloud is not reachable from the internet {#not-reachable}

Symptom: connecting fails with `nc_not_publicly_reachable`, and the setup page says that your Bee Flow server cannot reach this Nextcloud. No organisation is created and nothing is connected.

Cause: the connection runs in both directions. The connector calls the Bee Flow server, and the Bee Flow server calls your Nextcloud back: once while connecting, to check that the Nextcloud is the one it says it is, and afterwards for files, mail, calendar and user sync. A Nextcloud that only has an address on a private network (a LAN, a VPN, `192.168.x.x`, `10.x.x.x`) cannot be called from outside that network.

| Your Bee Flow server | What works |
|---|---|
| **Bee Flow Cloud** | Needs a Nextcloud it can reach from the internet: directly, or through a tunnel or reverse proxy that gives it a public HTTPS address. Enter that address as **Public Nextcloud URL** on the setup page. A tunnel makes your Nextcloud reachable from the internet; if that is what you want to avoid, Bee Flow Cloud is not the fit for this Nextcloud. |
| **Your own Bee Flow server** | Works with a private Nextcloud when the server can reach it over your network **and** is allowed to call private addresses (below). See [Bee Flow on your own server next to Nextcloud](own-server.md). |

**Allowing private addresses on your own server.** A Bee Flow server refuses to call private and loopback addresses unless you set this in the environment of the server container and restart it:

```bash
NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1
```

:::warning This setting applies to the whole server
It is not per organisation and not per Nextcloud. With it, the server calls private and loopback addresses for every Nextcloud address that anybody on that server enters, including the address a user saves next to an app password. Set it only on a server whose users you trust, and only when your Nextcloud really is on a private network. Cloud metadata addresses stay refused either way.
:::

The server container must also be able to resolve the Nextcloud's hostname and route to it.

**Linking the two.** A self-hosted server links a Nextcloud by pairing code: generate one in Bee Flow (**Settings → Organisation → Pair a new Nextcloud**) and enter it on the setup page.

## Nextcloud behind Cloudflare (proxy or Tunnel) {#cloudflare}

The connector works behind Cloudflare; we have not tested this setup ourselves. Cloudflare terminates TLS on its side, so it sees the traffic between your users, your Nextcloud and Bee Flow in the clear; Nextcloud's own [notes on Cloudflare](https://github.com/nextcloud/all-in-one#notes-on-cloudflare-proxytunnel) list this and its other limits. What to set:

| Point | What to do |
|---|---|
| **Route order, with HaRP** | In a Tunnel, the `exapps/*` route must stand above the main route of your Nextcloud, or `/exapps/` never reaches HaRP. See [Cloudflare Tunnel](https://github.com/nextcloud/HaRP#cloudflare-tunnel) in the HaRP README, and [the `/exapps/` rule](deploy-daemon.md#exapps-rule). |
| **Challenges and bot protection** | The Bee Flow server calls your Nextcloud from a server, at `/index.php/apps/app_api/proxy/bee_flow/…`. A server cannot answer a challenge, and a blocked call reads as a permission error from Nextcloud. If you use WAF rules, bot protection or challenges, add a [skip rule](https://developers.cloudflare.com/waf/custom-rules/skip/) for that path prefix and, with HaRP, for `/exapps/bee_flow/`. Keep the rule to these two prefixes. |
| **Upload size** | Cloudflare limits the size of a request body per plan; see [Cloudflare's page on error 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/). The connector's own limit for one upload from Bee Flow into Nextcloud is 100 MB by default (`BEEFLOW_NC_PROXY_MAX_BODY_MB`); raising it does not raise Cloudflare's. The limit is on uploads, not on downloads. |
| **Visitor addresses, with HaRP** | HaRP sees the address of the tunnel or proxy, not of the visitor, unless `HP_TRUSTED_PROXY_IPS` names it. Set it, or [HaRP's temporary block](deploy-daemon.md#harp-block) counts all users as one. |
| **Rocket Loader** | Turn it off for the Nextcloud hostname; Nextcloud's notes linked above say its sign-in page does not load with it. |

## Bootstrap "failed" state in heartbeat

`/heartbeat` reports `"bootstrap":"failed"` when connecting to the Bee Flow server fails. To read it from inside the container (this works under every deploy daemon):

```bash
docker exec nc_app_bee_flow sh -c 'if [ -n "$HP_SHARED_KEY" ]; then
    curl -s --unix-socket /tmp/exapp.sock http://localhost/heartbeat
  else
    curl -s "http://127.0.0.1:$APP_PORT/heartbeat"
  fi'
# → {"status":"ok","bootstrap":"failed","remediation":"Open Bee Flow in Nextcloud as an administrator, or read GET /setup/diagnostics, for the cause and how to fix it."}
```

`status` stays `ok`: the connector itself is healthy. The heartbeat names the state only. The category, the error and the time of the next attempt are on the [setup page](setup-picker.md#where-the-setup-page-is) and in `GET setup/diagnostics`, both for Nextcloud administrators.

With HaRP's tunnel the connector listens on a Unix socket and has no TCP port, so a check against a port number cannot work there.

| Category | Meaning | Fix |
|---|---|---|
| `saas_unreachable` | Connector can't reach the Bee Flow server that was chosen | Test `curl <your Bee Flow server>/api/health` from inside the container (the remediation text names the address). Allow that hostname in your egress firewall; behind a forward proxy, register the app with `--env HTTPS_PROXY=…`. |
| `saas_cert_untrusted` | The certificate of the Bee Flow server does not verify | A certificate from a public certificate authority, or the install-time value `BEEFLOW_SERVER_CA_CERT` with your own authority's PEM certificate. |
| `nc_not_publicly_reachable` | The Bee Flow server couldn't reach your Nextcloud (also shown for the server answer `invalid_callback_url`) | Set the public Nextcloud URL (see section above). A Nextcloud on a private network needs a self-hosted Bee Flow server that can reach it and is allowed to: see [Nextcloud is not reachable from the internet](#not-reachable). |
| `pairing_required` | The server does not create an organisation by itself | Generate a pairing code in Bee Flow (**Settings → Organisation → Pair a new Nextcloud**) and enter it on the setup page. |
| `version_mismatch` | The server and the connector do not work together in these versions, or the address is the web app's instead of the server's | Update both; check the address. |
| `admin_lookup_failed` | No admin user found in NC's `admin` group | `occ user:add --group admin <uid>`, then restart the connector container. |
| `appstore_signature_invalid` | Downloaded tarball signature mismatch (rare) | Uninstall and reinstall from the App Store. |

The next retry is scheduled automatically; you don't need to redeploy unless you've changed the underlying problem.

## Install hangs at "Deploying…"

| Symptom | Cause | Fix |
|---------|-------|-----|
| AppAPI deploy log shows `Image pull failed` | Daemon can't reach `ghcr.io` | `docker pull ghcr.io/bee-flow/connector:latest` from the host running the daemon. Whitelist `ghcr.io` + `pkg-containers.githubusercontent.com` in your egress firewall. |
| HaRP deploy returns `500 Internal Server Error` on `images/create` from a local registry | HaRP's Docker daemon doesn't trust HTTP registries | Add `{"insecure-registries":["registry:5000"]}` to the HaRP daemon's `/etc/docker/daemon.json` and restart, **or** switch to the `manual-install` daemon for local dev. |
| Deploy succeeds but the heartbeat check fails, HaRP daemon | `/exapps/` of your Nextcloud address is not forwarded to HaRP, or HaRP is in its temporary block after earlier failures | Add the [`/exapps/` rule](deploy-daemon.md#exapps-rule); then wait five minutes or restart HaRP before you test again ([why](deploy-daemon.md#harp-block)). |
| Deploy succeeds but the heartbeat check fails, other daemon | Nextcloud cannot reach the connector container | See ["Heartbeat failed"](#heartbeat-failed) below. |
| Init reports `progress=0` and an error | Bootstrap failure (e.g. SaaS unreachable) | Check `docker logs nc_app_bee_flow` — see "Tenant key bootstrap" below. |

## "Heartbeat failed" in Nextcloud admin {#heartbeat-failed}

Nextcloud asks the connector for `/heartbeat` and gets no good answer. First see whether the connector itself is healthy; the container's health check asks the same endpoint from inside:

```bash
docker inspect --format '{{.State.Health.Status}}' nc_app_bee_flow     # → healthy
docker logs nc_app_bee_flow --tail 50
```

| What you see | Likely cause |
|---------|--------------|
| No container, or it keeps restarting | `docker ps -a \| grep bee_flow`, then `docker logs nc_app_bee_flow`. |
| Container `healthy`, Nextcloud still reports a failed heartbeat, **HaRP** daemon | The connector is fine; the path between Nextcloud and the connector is not. Check that `/exapps/` of your Nextcloud address is forwarded to HaRP ([Deploy daemon and reverse proxy](deploy-daemon.md#exapps-rule)), and mind [HaRP's temporary block](deploy-daemon.md#harp-block) while you retry. |
| Container `healthy`, Nextcloud still reports a failed heartbeat, **other daemon** | Nextcloud and the connector are not on the same Docker network, or the daemon's host is wrong. Verify with `docker network inspect` and `occ app_api:daemon:list`. |
| Container `healthy` and the heartbeat is fine again, the page still shows the failure | Reload **Administration → AppAPI**. |

## Tenant key bootstrap fails

| Symptom in `docker logs nc_app_bee_flow` | Cause | Fix |
|------------------------------------------|-------|-----|
| `[Bootstrap] capabilities fetch timeout` | Connector can't reach NC | Check `NEXTCLOUD_URL` env. Ping it from inside the container: `docker exec nc_app_bee_flow curl $NEXTCLOUD_URL/status.php`. |
| `[Bootstrap] admin discovery: no admin found` | NC has no user in the `admin` group | Create one: `occ user:add --group admin alice`. |
| `[Bootstrap] SaaS responded 401` | Bee Flow service rejected the AppAPI signature | Check clocks (NTP) on both hosts. Verify `BEEFLOW_API_BASE_URL` is reachable. |
| The setup page shows `pairing_required` on a Nextcloud that was connected before | The connector no longer holds the key of its organisation, and the server does not hand it out again without one | Ask a Bee Flow organisation admin to generate a pairing code (**Settings → Organisation → Pair a new Nextcloud**) and enter it on the setup page under **Bind to existing organisation**. |

The connector keeps its key in `${APP_PERSISTENT_STORAGE}/tenant-key.json`. Leave that file in place: the key in it is what proves to the Bee Flow server that this is the same Nextcloud. To connect again:

- **Clear organisation cache** on the [setup page](setup-picker.md#where-the-setup-page-is) connects again from the start, and puts the previous key back when that fails.
- A **pairing code** joins the Nextcloud to its organisation when the key is gone.
- A restart of the container (`docker restart nc_app_bee_flow`) makes the connector try again with what it has.

## "Setup in progress" never goes away

Other users see this until the org admin completes the wizard. If you are the admin and still see it:

1. Reload the page (Cmd/Ctrl+Shift+R).
2. Check **Administration → AppAPI** — Bee Flow should show **Enabled**.
3. Check the connector logs: `docker logs nc_app_bee_flow --tail 100`.
4. Hit the health endpoint of the Bee Flow server the connector is on (the setup page shows it): `curl <your Bee Flow server>/api/health`.

If the SaaS health is fine but the wizard still shows "Setup in progress", the tenant-key bootstrap probably ran but the SaaS didn't finish creating the org row. Restart the connector to force re-bootstrap.

## `ERR_INVALID_CHUNKED_ENCODING` on SSE responses

This only affects the **`docker-install` / Docker-Socket-Proxy daemons**, where the SSE response passes through Nextcloud's PHP AppAPI proxy. (On [HaRP](#migrate-to-harp) the stream goes straight to the connector, so this can't happen — and the connector skips the workaround there to keep the tunnel connection alive.)

When the browser shows `ERR_INVALID_CHUNKED_ENCODING` and the chat stream dies mid-reply, the issue is Nextcloud's AppAPI proxy stripping the `Transfer-Encoding: chunked` header from the connector's SSE response without rewriting the body. The connector works around this by forcing `useChunkedEncodingByDefault=false` and adding `Connection: close` on every SSE proxy hop, so plain `Content-Length`-less bodies flow through cleanly.

If you still see it after upgrading to a connector built from commit `af26662` or later:

1. Verify your `nc_app_bee_flow` container is up-to-date: `docker exec nc_app_bee_flow node -e "console.log(require('./package.json').version)"`.
2. Confirm no upstream reverse proxy (nginx, traefik) is re-introducing chunked encoding on the NC → browser hop — check `proxy_buffering off;` and `proxy_http_version 1.1;` in the NC vhost.
3. Capture a `curl -N -v https://<nc-host>/index.php/apps/app_api/proxy/bee_flow/api/...` against an SSE endpoint and attach the headers to a bug report — the response should have `Connection: close` and no `Transfer-Encoding`.

## Nextcloud events do not reach automations

File, tag, calendar, Forms, Tables and Deck triggers are delivered by Nextcloud's bundled `webhook_listeners` app. If that app is not enabled the connector logs:

```
[Webhooks] The webhook_listeners app is not enabled on this Nextcloud
```

Fix: `occ app:enable webhook_listeners`. The connector retries the registration every minute, so no restart is needed. A healthy registration logs `[Webhooks] N registered, M skipped (optional apps), 0 failed`; "skipped" rows belong to apps that are not installed (Forms, Tables, Deck).

Nextcloud delivers these events to the connector through AppAPI, so it does not have to reach its own public address and `allow_local_remote_servers` is not needed for them. A delivery that fails shows in `nextcloud.log` as `Webhook(<id>) call failed`. `GET setup/diagnostics` reports under `webhooks` whether the rows are registered and when the last delivery arrived (counted since the connector started).

If automations fire twice after going back to connector 1.7.0: that version does not recognise the rows 2.0.0 registered and adds a second set. Update the connector again.

If events arrive, but minutes late: Nextcloud sends them from background jobs, so the delay is the cron interval. Run a dedicated worker for near-real-time delivery:

```
occ background-job:worker -t 60 'OCA\WebhookListeners\BackgroundJobs\WebhookCall'
```

User and group changes are not delivered as events at all (Nextcloud's user and group events are not webhook-compatible). They reach Bee Flow through the periodic sync, or at once through **Sync now**.

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

To loosen the window (not recommended for production), register the app again with the install-time value `BEEFLOW_SIG_SKEW_SECONDS` (30 to 900):

```bash
sudo -u www-data php occ app_api:app:unregister bee_flow        # without --rm-data: the data is kept
sudo -u www-data php occ app_api:app:register bee_flow <daemon> --env BEEFLOW_SIG_SKEW_SECONDS=600
```

Give the other install-time values you use in the same command.

## JWT TTL expired

The connector mints short-lived JWTs (default 300 s) for browser-side calls. If you see:

```
401 Unauthorized: token expired
```

…the SPA's token wasn't refreshed in time. The frontend usually auto-refreshes; if it doesn't, hard-reload the page. The short default is intentional (leaked-token containment). `BEEFLOW_JWT_TTL_SECONDS` (30 to 900) is not an install-time option; it can only be set where you start the connector container yourself.

## Where to look

| Component | How to view logs |
|-----------|------------------|
| Connector container | `docker logs nc_app_bee_flow --tail 200 -f` |
| Nextcloud (AppAPI) | `tail -f data/nextcloud.log \| grep '"app":"app_api"'` |
| Nextcloud (Bee Flow specific) | `tail -f data/nextcloud.log \| grep bee_flow` |
| Bee Flow server (self-hosted) | `docker logs beeflow-server --tail 200 -f` |
| AppAPI deploy state | `occ app_api:app:list`, and **Administration → AppAPI** |
| Heartbeat | `docker inspect --format '{{.State.Health.Status}}' nc_app_bee_flow` (the container's health check asks the connector for `/heartbeat`) |

## Recovery commands cheat sheet

```bash
# Remove and install again. Without --rm-data the data volume, and with it the
# connection, is kept. Give your install-time values again with --env NAME=VALUE.
sudo -u www-data php occ app_api:app:unregister bee_flow
sudo -u www-data php occ app_api:app:register bee_flow \
  --info-xml https://raw.githubusercontent.com/Bee-Flow/connector/main/appinfo/info.xml

# Have the connector try again with the server and key it has
docker restart nc_app_bee_flow
```

To connect again from the start, use **Clear organisation cache** on the setup page; when the key of the organisation is gone, use a pairing code. Both are described under [Tenant key bootstrap fails](#tenant-key-bootstrap-fails).

## Where to ask

- Bug reports: [https://github.com/Bee-Flow/connector/issues](https://github.com/Bee-Flow/connector/issues)
- Security disclosure: [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl)
- Commercial: [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl)
