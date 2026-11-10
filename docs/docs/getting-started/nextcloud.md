---
title: Install on Nextcloud
---

# Install on Nextcloud

This page walks an admin through installing the Bee Flow connector via the Nextcloud App Store.

:::info[Requirements]

- Nextcloud 33, 34 or 35
- [AppAPI](https://apps.nextcloud.com/apps/app_api) installed and enabled
- A Docker deploy daemon configured (HaRP recommended). Bee Flow cannot be installed on managed or
  shared hosting without Docker
- Admin permissions on the Nextcloud instance
- Outbound HTTPS to `ghcr.io` (image pull) and to the Bee Flow server you choose after installing:
  `server.beeflow.nl` for Bee Flow Cloud, or your own server
- Nextcloud served over HTTPS: the embedded Bee Flow sign-in uses the browser's Web Crypto API, which
  browsers offer only on secure pages

:::

## 1. Install AppAPI

If you haven't already:

```bash
sudo -u www-data php occ app:install app_api
sudo -u www-data php occ app:enable app_api
```

Or install **App API** from the **Apps** page in the Nextcloud admin UI.

## 2. Configure a deployment daemon

AppAPI deploys ExApps as Docker containers. Pick the daemon that matches your Nextcloud setup:

| Your setup | Daemon | Where |
|---|---|---|
| **A new install on your own host** (bare metal, VM or the community Docker image) | **HaRP** (recommended) | [§2d](#2d-harp) |
| **Nextcloud All-in-One** | The HaRP container of All-in-One | [§2b](#2b-nextcloud-all-in-one) |
| **An existing Docker Socket Proxy daemon** | `docker-install` (deprecated upstream) | [§2a](#2a-vanilla-nextcloud), and [Migrate to HaRP](../connector/troubleshooting.md#migrate-to-harp) |
| **Behind reverse proxy / NAT** (Nextcloud has a public address that differs from its internal one) | Any, plus the public Nextcloud URL | [§2c](#2c-behind-reverse-proxy-or-nat) |

[Deploy daemon and reverse proxy](../connector/deploy-daemon.md) has the full table per install method (All-in-One, community image, bare metal, snap, NAS, managed hosting) and the reverse-proxy rule HaRP needs.

:::tip[Which daemon should I pick?]
**HaRP.** With a Docker-Socket-Proxy daemon every browser request to Bee Flow passes **through the Nextcloud PHP process**: a streaming answer arrives in one piece at the end, and each open request holds a PHP worker for as long as it lasts, so a busy chat plus the burst of requests the app makes on load can fill Nextcloud's PHP worker pool. HaRP sends those requests straight to the connector. AppAPI calls the Docker Socket Proxy deprecated and scheduled for removal in Nextcloud 35. If you see stalled or failed calls under load, [migrate to HaRP](../connector/troubleshooting.md#migrate-to-harp).
:::

:::note How to run `occ`
The commands below are written for a Nextcloud installed on the host (`sudo -u www-data php occ …`). On Nextcloud All-in-One use `sudo docker exec --user www-data -it nextcloud-aio-nextcloud php occ …`, with the community Docker image `docker exec --user www-data <nextcloud-container> php occ …`, and on a snap `sudo nextcloud.occ …`.
:::

### 2a. Vanilla Nextcloud

This registers a Docker-Socket-Proxy style daemon, which AppAPI calls deprecated. For a new install use [HaRP (§2d)](#2d-harp).

Register a daemon that talks to the host's Docker socket. Run this once on the server hosting Nextcloud:

```bash
sudo -u www-data php occ app_api:daemon:register \
  docker_local \
  "Local Docker" \
  docker-install \
  http \
  /var/run/docker.sock \
  https://cloud.example.com
```

The last two values are the path of the Docker socket and the URL of your Nextcloud.

Verify it works: `occ app_api:daemon:list` shows the daemon, and **Administration → AppAPI** has **Check connection** and **Test deploy** in the daemon's menu.

```bash
sudo -u www-data php occ app_api:daemon:list
```

The Docker socket must be readable by `www-data`. On most Nextcloud Docker images this means adding `www-data` to the host's `docker` group inside the Nextcloud container:

```bash
docker exec <nextcloud-container> bash -c "
  groupadd -g $(stat -c '%g' /var/run/docker.sock) docker-host 2>/dev/null || true
  usermod -aG docker-host www-data
"
```

### 2b. Nextcloud All-in-One

Nextcloud All-in-One ships AppAPI and offers two optional containers for it in the All-in-One interface: **HaRP** and the **Docker Socket Proxy**. Tick **HaRP** for a new install. All-in-One's own web server sends `/exapps/` to the HaRP container, so there is no reverse-proxy rule to add, and AppAPI has the matching daemon `harp_aio`. See [Deploy daemon and reverse proxy → Nextcloud All-in-One](../connector/deploy-daemon.md#aio) for what that page verified and what it did not.

Verify which daemons are registered:

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud \
  php occ app_api:daemon:list
```

With the Docker Socket Proxy container ticked instead, the daemon is `docker_aio`. AppAPI calls that daemon deprecated. If it is missing from the list, register it manually:

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud \
  php occ app_api:daemon:register \
  docker_aio \
  "AIO Docker socket proxy" \
  docker-install \
  http \
  nextcloud-aio-docker-socket-proxy:2375 \
  http://nextcloud-aio-nextcloud
```

### 2c. Behind reverse proxy or NAT

If your Nextcloud is reached via a public URL (e.g. `https://cloud.example.com`) but lives on a private network, the Bee Flow server needs that public URL to call your Nextcloud back. Give it in one of two ways:

- On the setup page, under **Public Nextcloud URL**, before or after you choose the server. A value saved before the choice is used when the server is chosen.
- As an install-time value (the advanced deploy options, or on the command line):

  ```bash
  sudo -u www-data php occ app_api:app:register bee_flow <daemon> \
    --env BEEFLOW_NC_PUBLIC_URL=https://cloud.example.com
  ```

Bee Flow Cloud needs a Nextcloud that is reachable from the internet, directly or through a tunnel. A Nextcloud on a private network needs a self-hosted Bee Flow server that can reach it.

### 2d. HaRP (recommended) {#2d-harp}

[HaRP](https://github.com/nextcloud/HaRP) is AppAPI's reverse proxy and deploy daemon: a single container that bundles HAProxy, a Docker-socket proxy and an FRP server. Unlike the Docker-Socket-Proxy daemons, HaRP passes browser and API traffic **directly to the ExApp container, without the Nextcloud PHP process**, so streaming answers arrive as they are produced and no PHP worker is held. The connector container needs no inbound ports: it dials out to HaRP over an FRP tunnel.

**Requirements:** Nextcloud 33, 34 or 35 (the connector's range), the ability to run the HaRP container alongside Nextcloud, and access to the reverse proxy in front of Nextcloud.

1. **Run the HaRP container** following the [HaRP README](https://github.com/nextcloud/HaRP#how-to-install-it). You choose an `HP_SHARED_KEY` (a secret HaRP and Nextcloud share) and publish HaRP's ExApps port (default `8780`) and FRP port (default `8782`).

2. **Send `/exapps/` to HaRP** in the reverse proxy in front of Nextcloud. Without this rule the app does not load. The nginx block, an Apache example and a check are in [Deploy daemon and reverse proxy](../connector/deploy-daemon.md#exapps-rule).

3. **Register the HaRP daemon** in Nextcloud. In the admin UI: **Administration → AppAPI**, register a daemon with the **HaRP Proxy (Host)** or **HaRP Proxy (Docker)** template and fill in the HaRP host and the shared key. The equivalent CLI form is:

   ```bash
   sudo -u www-data php occ app_api:daemon:register \
     harp1 "HaRP" docker-install \
     http <harp-host>:8780 "https://cloud.example.com" \
     --harp --harp_shared_key "<HP_SHARED_KEY>" \
     --harp_frp_address <harp-host>:8782
   ```

   `http` is how Nextcloud reaches HaRP on port 8780; the last positional value is the URL of your Nextcloud. `occ app_api:daemon:register --help` lists every option of your version.

   Verify: `occ app_api:daemon:list` shows the daemon, and **Test deploy** in the daemon's menu under **Administration → AppAPI** runs a full test install.

   ```bash
   sudo -u www-data php occ app_api:daemon:list
   ```

4. **Install Bee Flow onto the HaRP daemon** (step 3 below). If Bee Flow is already installed on another daemon, follow [Migrate to HaRP](../connector/troubleshooting.md#migrate-to-harp) instead: it keeps the connector's data, so the same organisation stays connected.

The same connector image runs under HaRP and the other daemons; it detects HaRP by the `HP_SHARED_KEY` AppAPI passes to it and switches to the FRP tunnel and a Unix socket with no extra configuration.

HaRP stops answering an address for a few minutes after repeated failures, which can make a test fail after you already fixed the cause: see [HaRP's temporary block](../connector/deploy-daemon.md#harp-block).

## 3. Install Bee Flow from the App Store

1. Open **Apps** in your Nextcloud admin area.
2. Search **Bee Flow** in the **AI** category.
3. Click **Install**.

Or via CLI:

```bash
sudo -u www-data php occ app_api:app:register \
  bee_flow \
  --info-xml https://raw.githubusercontent.com/Bee-Flow/connector/main/appinfo/info.xml
```

AppAPI pulls the connector image from `ghcr.io/bee-flow/connector:latest` and starts a container next to your Nextcloud. The first install typically takes **30–60 seconds** end-to-end on a stock VPS.

The install connects to nothing. The deploy options have a field **Bee Flow server (optional)**: leave it empty, and an administrator chooses after installing (step 5). Fill it in only to fix the server at install time: the URL of your own Bee Flow server, or the word `cloud` for Bee Flow Cloud (on the command line: `--env BEEFLOW_API_BASE_URL=cloud`). A value given there cannot be changed from inside Nextcloud.

![App Store listing](../img/screenshots/getting-started/nextcloud-app-store/)

## 4. Verify the install

After AppAPI reports the install as successful:

```bash
# The app as AppAPI sees it
sudo -u www-data php occ app_api:app:list
# → bee_flow (Bee Flow): 2.0.0 [enabled]

# The container's own health check (it asks the connector for /heartbeat)
docker inspect --format '{{.State.Health.Status}}' nc_app_bee_flow
# → healthy

# The heartbeat answer itself, from inside the container (works under every deploy daemon)
docker exec nc_app_bee_flow sh -c 'if [ -n "$HP_SHARED_KEY" ]; then
    curl -fsS --unix-socket /tmp/exapp.sock http://localhost/heartbeat
  else
    curl -fsS "http://127.0.0.1:$APP_PORT/heartbeat"
  fi'
# → {"status":"ok","bootstrap":"server_not_chosen"}   until an administrator chooses a server
# → {"status":"ok"}                                   once connected

# Container logs
docker logs nc_app_bee_flow --tail 50
# → [ServerChoice] No Bee Flow server chosen; nothing is sent until an administrator chooses one
# → [Init] Background setup completed in 4210ms
```

A **bee icon** should now appear in your Nextcloud top bar. The webhook rows of step 4a are registered once Bee Flow is connected (step 5).

![Top-bar icon](../img/screenshots/getting-started/nextcloud-topbar/)

## 4a. Enable real-time triggers

Automations that react to something happening in Nextcloud — a file arriving, a
form being submitted, a row changing — need Nextcloud's **Webhook Listeners**
app. It ships with Nextcloud but is **not enabled by default**:

```bash
sudo -u www-data php occ app:enable webhook_listeners
```

The connector registers its subscriptions automatically, within a minute of the
app being enabled. Check them with:

```bash
sudo -u www-data php occ webhook_listeners:list
```

You should see rows with the uri `/hooks/nextcloud`, once Bee Flow is connected. Nextcloud delivers them to the connector through AppAPI; it does not call its own public address for them.

### Make delivery fast

Nextcloud delivers webhooks through background jobs, so **out of the box an
event can take up to 5 minutes** to reach Bee Flow — the default cron interval.
Everything works, it just feels broken. Run dedicated workers to get delivery
down to seconds:

```bash
# One per screen/tmux window; four or more is typical.
set -e; while true; do \
  sudo -E -u www-data php occ background-job:worker -v -t 60 \
    "OCA\WebhookListeners\BackgroundJobs\WebhookCall"; \
done
```

For a permanent setup, run these as systemd units — see
[Nextcloud's Webhook Listeners documentation](https://docs.nextcloud.com/server/latest/admin_manual/webhook_listeners/index.html)
for a template service file.

:::note What is and is not real-time
Nextcloud only exposes *some* of its events to webhooks. Files, tags, calendar
objects, **Forms** submissions and **Tables** rows are delivered this way.
Sharing, Deck and Talk events are not — Nextcloud has no webhook for them — so
Bee Flow reads those from the activity feed on a polling interval instead.
Triggers with no producer at all are labelled in the Automations builder rather
than failing silently.
:::

### Optional apps

Two of the trigger families need their Nextcloud app installed before the
connector can subscribe to them. Both are optional and skipped cleanly when
absent (you will see them in the `[Webhooks] … skipped` count above):

| App | Unlocks |
|---|---|
| [Forms](https://apps.nextcloud.com/apps/forms) | the `forms.submitted` trigger and the `nextcloud_forms_*` actions |
| [Tables](https://apps.nextcloud.com/apps/tables) | the `tables.row.*` triggers and the `nextcloud_tables_*` actions |

[Nextcloud Office](https://apps.nextcloud.com/apps/richdocuments) is likewise
optional: it backs the "convert to PDF" action, and it is what opens the
`.xlsx`, `.docx` and `.pptx` files Bee Flow creates in Nextcloud Files
(`nextcloud_create_spreadsheet` / `_document` / `_presentation`) straight
from the browser.

## 4b. Use Bee Flow from Nextcloud Assistant (optional)

Everything above lets Bee Flow act *on* Nextcloud. This does the reverse: it
makes Bee Flow's tools and automations callable from Nextcloud's own **Assistant**,
via the Model Context Protocol.

1. In Bee Flow, open **Settings → Connections → MCP access** and mint a token.
   It is shown once — Bee Flow stores only a hash-equivalent, so it cannot be
   displayed again. Minting a new one revokes the old.
2. In Nextcloud, go to **Administration settings → Artificial intelligence →
   Context Agent → MCP Config** and add:

```json
{
  "bee-flow": {
    "url": "https://<your-bee-flow-server>/mcp",
    "transport": "streamable_http"
  }
}
```

3. Set the `Authorization: Bearer <token>` header for that service.

Nextcloud's Assistant can now call every Bee Flow tool the token's owner has
access to — and every automation they have published as agent-callable. Tools carry
read-only/destructive annotations drawn from the same classification Bee Flow's
own dry-run mode uses, so Assistant knows which ones to confirm first.

The token grants exactly what that user can do in Bee Flow chat, nothing more:
tool availability is re-resolved on every call, so revoking an integration takes
effect immediately rather than at the next reconnect.

:::note
This is per-user. Nextcloud's Context Agent documents that it cannot yet hold a
different token per user for one MCP service, so a service configured
instance-wide acts as whoever minted the token. Until that changes, use it for a
shared service account, or scope it to the people who should share that access.
:::

## 4c. Power Nextcloud's own AI features with Bee Flow (optional)

Nextcloud routes **every** AI feature through one API — Task Processing. That
includes Assistant, Mail thread summaries, Talk summaries, Text, Collectives,
Notes, Deck and Nextcloud Office. Whichever provider is registered does the work.

The connector registers Bee Flow as a provider automatically at install, so
there is nothing to configure. Check it took:

**Administration settings → Artificial intelligence** — Bee Flow appears in the
provider dropdown for the text task types (summary, headline, topics, proofread,
reformulate, simplify, formalise, improve, translate, and free-form prompts).
Select it for the ones you want.

What this gets you: those features now run on your organisation's own model
choice, through Bee Flow's Privacy Shield, in the region you host in — rather
than a third-party endpoint. Nextcloud's own Ethical AI Rating scores the
OpenAI integration **Red** (closed model, closed weights, closed training data);
this is the alternative that keeps the data where you put it.

:::note What is not registered
Image generation, text-to-speech and audio transcription are deliberately
absent. Bee Flow transcribes with WhisperX — which does speaker diarisation,
unlike Nextcloud's own `stt_whisper2` — but that runs on a separate pipeline
and is not wired into Task Processing yet. Registering a provider that fails
every task would be worse than not registering: Nextcloud would still route to
it and the feature would break. Use the Bee Flow meeting-notes pipeline for
recordings in the meantime.
:::

## 5. Choose where Bee Flow runs

Open **Bee Flow** from the top bar as a Nextcloud administrator. The setup page offers two cards:
**Bee Flow Cloud** (hosted by Bee Flow B.V. in the Netherlands) or **Self-hosted server** (the URL of
[your own Bee Flow server](../self-hosting/docker-compose.md), with an optional pairing code).

Before you press **Connect**, the page shows what connecting sends and to which host: the names and
e-mail addresses of the Nextcloud's administrators, its address, instance id and version. Nothing is
sent before that. Until an administrator has chosen, everybody else reads "Bee Flow is not set up
yet."

More in [Choose where Bee Flow runs](../connector/setup-picker.md).

## 6. First-time consent

The first time **each user** opens Bee Flow they see a privacy-disclosure modal. Read, then **I agree — start Bee Flow**. Acceptance is recorded server-side so the modal never reappears for that user (unless the consent text version changes).

## 7. First-time admin wizard

The first time the **organisation admin** opens Bee Flow, a 4-step wizard runs covering user-sync mode, default integrations, privacy shield level, and an optional licence key. Other users see a "Setup in progress" screen until the admin finishes.

[Continue: First-run wizard walk-through →](wizard.md)

## Updating the connector

AppAPI auto-checks for updates daily. To force-update:

1. **Apps → Updates** in the Nextcloud admin area.
2. Click **Update** on the Bee Flow card.

Or:

```bash
sudo -u www-data php occ app_api:app:update bee_flow
```

[More about upgrades →](../self-hosting/upgrades.md)

## Uninstalling

```bash
sudo -u www-data php occ app_api:app:unregister bee_flow
```

This stops the container, removes it, and cleans up the AppAPI registration. Without `--rm-data` the connector's data volume is kept, so installing again finds the same server and binding; with `--rm-data` the connector starts again without a Bee Flow server. The organisation is **not** deleted either way — your data stays on the Bee Flow server that was chosen until you delete the organisation explicitly via **Settings → Organisation → Danger zone**.

## Troubleshooting

If the install hangs, fails, or the heartbeat doesn't return: see [Connector → Troubleshooting](../connector/troubleshooting.md). The most common causes are:

- AppAPI's deployment daemon can't pull from `ghcr.io` (firewall / DNS)
- With HaRP: `/exapps/` of your Nextcloud address is not forwarded to HaRP — see [Deploy daemon and reverse proxy](../connector/deploy-daemon.md#exapps-rule)
- **Automations never fire.** Almost always one of: the `webhook_listeners` app
  is not enabled, or no background-job workers are running so events sit in the
  queue for up to 5 minutes. See [Enable real-time triggers](#4a-enable-real-time-triggers).
  Confirm with `occ webhook_listeners:list` — no rows means the connector never
  registered; check `docker logs nc_app_bee_flow | grep Webhooks` for the reason.
- HaRP doesn't trust a local insecure registry (dev-only)
- **Icon appears but the app is blank on a local AIO + HaRP with a self-signed certificate** — HaRP and Nextcloud's own PHP can't verify the cert, so the embedded app's requests 500. Run [`aio-trust-local-cert.sh`](local-development.md#testing-on-a-local-nextcloud-aio-harp--a-self-signed-certificate) (local testing only; a real/valid certificate needs no step).
