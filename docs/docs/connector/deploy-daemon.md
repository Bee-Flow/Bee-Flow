---
title: Deploy daemon and reverse proxy
---

# Deploy daemon and reverse proxy

The connector is an ExApp: a Docker container that [AppAPI](https://apps.nextcloud.com/apps/app_api)
starts next to your Nextcloud. AppAPI needs a **deploy daemon** to start it, and with the HaRP daemon
your reverse proxy needs one extra rule. This page says which daemon applies to which kind of
Nextcloud install and what you add yourself.

Statements about AppAPI, HaRP and Nextcloud All-in-One on this page were read in their source
(AppAPI `stable33` to `stable35`, HaRP 0.4.8, All-in-One `main`). Where we did not run a setup
ourselves, the page says "not verified by us".

## The two daemons

| Daemon | How a browser reaches the connector | State upstream |
|---|---|---|
| **HaRP** | Directly: your reverse proxy sends `/exapps/` to the HaRP container, which passes it to the connector. Nextcloud's PHP is not involved. | The deploy daemon of AppAPI since Nextcloud 32. |
| **Docker Socket Proxy** | Through Nextcloud: every request passes Nextcloud's PHP (`/index.php/apps/app_api/proxy/bee_flow/…`). | AppAPI calls it deprecated and scheduled for removal in Nextcloud 35. The AppAPI of Nextcloud 35 still accepts it. |

Use HaRP for a new install. The reason is under
[Why HaRP](#why-harp).

## Per install method {#per-install-method}

| Your Nextcloud | Deploy daemon | What you add | Verified by us |
|---|---|---|---|
| **Nextcloud All-in-One** | The HaRP container of All-in-One. AppAPI has the matching daemon `harp_aio` ("AIO HaRP"). | Tick **HaRP** in the All-in-One interface. No reverse-proxy rule: see [All-in-One](#aio). | Routing read in the All-in-One source. There is a [local test setup](../getting-started/local-development.md#testing-on-a-local-nextcloud-aio-harp--a-self-signed-certificate); this release on All-in-One: not verified by us. |
| **Community Docker image with compose**, behind your own reverse proxy | HaRP, as one more container on the same Docker engine | The HaRP container, the daemon registration, and the [`/exapps/` rule](#exapps-rule) in the reverse proxy in front of Nextcloud | Our development sandbox runs this shape with nginx. Other proxies: not verified by us. |
| **Bare metal or a virtual machine**, with Docker on the host | HaRP, as a container on that host | Docker, the HaRP container, the daemon registration, and the [`/exapps/` rule](#exapps-rule) in the web server or proxy that serves Nextcloud | Not verified by us. |
| **Snap** | HaRP, when Docker runs on the host | The same as bare metal. Where the `/exapps/` rule goes on a snap is not verified by us. | Not verified by us. |
| **NAS appliances** | HaRP, when the appliance can run the HaRP container and the connector container | The same as the community image. Whether the appliance's own proxy can carry the `/exapps/` rule is not verified by us. | Not verified by us. |
| **Managed or shared hosting** | None where you cannot run Docker or Kubernetes for AppAPI | The connector cannot be installed there. Bee Flow still works with that Nextcloud without the connector: see [No Docker on your Nextcloud host?](../integrations/nextcloud.md#no-docker) | Not possible. |

The daemon registration and the install itself are in [Install on Nextcloud](../getting-started/nextcloud.md#2d-harp).

:::note How to run `occ`
The commands on these pages are written as `sudo -u www-data php occ …`, the form for a Nextcloud
installed on the host. On other installs the same command is:

| Install | Form |
|---|---|
| Nextcloud All-in-One | `sudo docker exec --user www-data -it nextcloud-aio-nextcloud php occ …` |
| Community Docker image | `docker exec --user www-data <nextcloud-container> php occ …` |
| Snap | `sudo nextcloud.occ …` |
:::

## The `/exapps/` rule {#exapps-rule}

With HaRP, browsers reach the connector at `https://<your-nextcloud>/exapps/bee_flow/`. The reverse
proxy in front of Nextcloud must send everything under `/exapps/` to HaRP's ExApps port (`8780` by
default, `HP_EXAPPS_ADDRESS`). Without the rule those requests go to Nextcloud instead of HaRP, and
the app does not load.

### nginx

This is the block our development sandbox runs, with HaRP on `127.0.0.1:8780`:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    # … your existing Nextcloud server block …

    location /exapps/ {
        proxy_pass http://127.0.0.1:8780/exapps/;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Streaming answers: never buffer, and wait as long as HaRP does (1800 s).
        proxy_buffering off;
        proxy_request_buffering off;
        # Chat attachments travel in the request body (base64, a third larger than the file);
        # nginx's default of 1 MB refuses a PDF of 800 KB with a 413.
        client_max_body_size 32m;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```

Keep the trailing `/exapps/` in `proxy_pass`. When your Nextcloud server block has regular-expression
locations (for `.php`, `.js`, `.css`), write the location as `location ^~ /exapps/` so that they do
not answer these requests; the HaRP README explains this.

### Apache

The example of the HaRP README, for the virtual host of your Nextcloud, before the existing
configuration. Not verified by us:

```apache
ProxyPass /exapps/ http://127.0.0.1:8780/exapps/ upgrade=websocket
ProxyPassReverse /exapps/ http://127.0.0.1:8780/exapps/
ProxyTimeout 1800
```

### Other proxies

For Caddy, Traefik and Cloudflare Tunnel see
[Configuring Your Reverse Proxy](https://github.com/nextcloud/HaRP#configuring-your-reverse-proxy) in
the HaRP README, and Nextcloud's
[deployment configurations](https://docs.nextcloud.com/server/latest/admin_manual/exapps_management/DeployConfigurations.html).
For Cloudflare also read [Nextcloud behind Cloudflare](troubleshooting.md#cloudflare).

### Check the rule

The HaRP README gives this check. Without the shared key the answer should be `401`, which shows
that the request reached HaRP:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cloud.example.com/exapps/app_api/_ping
```

Run it once. Each `401` counts as a failed attempt for [HaRP's temporary block](#harp-block).

Do not test with `/exapps/bee_flow/heartbeat`: HaRP answers the lifecycle endpoints (`/heartbeat`,
`/init`, `/enabled`) to AppAPI only, drops them for everybody else and counts the attempt.

Tell HaRP which address your reverse proxy has (`HP_TRUSTED_PROXY_IPS`), so that it sees the address
of each visitor instead of the proxy's.

## Nextcloud All-in-One {#aio}

What the All-in-One source shows:

- **All-in-One routes `/exapps/` by itself.** Its own web server (the `apache` container, which runs
  Caddy) sends `/exapps/*` to the HaRP container on port 8780, ahead of the route to Nextcloud. A
  reverse proxy of your own in front of All-in-One needs no extra `/exapps/` rule, because
  everything goes to that web server.
- **HaRP is an optional container** (`nextcloud-aio-harp`) that you tick in the All-in-One
  interface. AppAPI has the matching daemon `harp_aio`, and registers it when AppAPI is installed
  while HaRP is enabled in All-in-One. Check with `occ app_api:daemon:list`.
- **All visitors share one address for HaRP.** All-in-One does not set `HP_TRUSTED_PROXY_IPS` on the
  HaRP container, so HaRP sees the address of All-in-One's web server as the client of every
  request. [HaRP's temporary block](#harp-block) then applies to everybody at once.
- **The connector is reached through Nextcloud on this daemon.** The `harp_aio` daemon connects to
  ExApps directly and does not hand them the HaRP key. The connector then listens on its TCP port
  and opens the app through Nextcloud's AppAPI proxy path, so
  [what holds for the Docker Socket Proxy](#why-harp) holds here too.

Not verified by us: this release of the connector on a running All-in-One, with either container.
For a local All-in-One with a self-signed certificate see
[Local development](../getting-started/local-development.md#testing-on-a-local-nextcloud-aio-harp--a-self-signed-certificate).

All-in-One also still offers the **Docker Socket Proxy** container, with the daemon `docker_aio`.
To move from it to HaRP see [Migrate to HaRP](troubleshooting.md#migrate-to-harp).

## HaRP's temporary block {#harp-block}

HaRP stops answering an address that fails too often. What its source (0.4.8) does:

- **Threshold.** 10 failures (`HP_BLACKLIST_COUNT`) within a sliding window of 300 seconds
  (`HP_BLACKLIST_WINDOW`), counted per client address, in memory.
- **Effect.** While 10 or more failures are inside the window, every request from that address is
  dropped without an HTTP answer. There is no fixed duration: the block ends when the oldest failure
  leaves the window, at most 300 seconds after the last one. Dropped requests are not counted as new
  failures. Restarting HaRP clears it.
- **What counts, at HaRP itself:** a path with a `.` or `..` segment; no app id in the path; an
  unknown or disabled ExApp; a wrong `harp-shared-key`; a lifecycle endpoint, a control character or
  an over-long path; an access denial (`403`), which includes a visitor who is not signed in on a
  route that needs a user or an administrator; and no matching route (`404`).
- **What counts, from the ExApp's answer:** only on routes that declare it in the app's manifest,
  and only for the statuses listed there. For Bee Flow that is `/hooks/` with `401` and `403`. An
  error answer of the connector on any other route does not count.
- **What does not count:** a wrong method (`405`), an error of Nextcloud's own lookup, an ExApp host
  that does not resolve, and requests AppAPI signs itself.
- **Which address.** The address HaRP sees: the peer, unless `HP_TRUSTED_PROXY_IPS` covers your
  reverse proxy (then the first `X-Forwarded-For` entry, else `X-Real-IP`). The default is empty, so
  behind a reverse proxy all users share one counter.

In practice: after you fix a proxy rule or a shared key, a test that still fails can be the block
and not your fix. Wait five minutes or restart the HaRP container, then test once.

## Why HaRP {#why-harp}

On a Docker Socket Proxy (or `manual-install`) daemon every request from the browser to Bee Flow
passes Nextcloud's PHP:

- **A streaming answer is buffered.** Nextcloud's AppAPI proxy passes the body on when the
  connector is done, so a chat answer or a builder run arrives in one piece at the end instead of
  word by word.
- **Each open request holds a PHP worker** for as long as it lasts. Long answers and the burst of
  requests on page load compete for the workers of Nextcloud's PHP pool; when the pool is full,
  requests stall or fail, for Bee Flow and for Nextcloud itself.

With HaRP and its tunnel the browser reaches the connector directly on `/exapps/bee_flow/`, and
neither applies. This is the reason to move an existing install:
[Migrate to HaRP](troubleshooting.md#migrate-to-harp).
