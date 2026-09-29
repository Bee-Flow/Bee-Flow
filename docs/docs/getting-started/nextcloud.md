---
title: Install on Nextcloud
---

# Install on Nextcloud

This page walks an admin through installing the Bee Flow connector via the Nextcloud App Store.

:::info[Requirements]

- Nextcloud 31, 32, 33.0.1+, or 34
- [AppAPI](https://apps.nextcloud.com/apps/app_api) installed and enabled
- A deployment daemon configured (HaRP **or** `manual-install`)
- Admin permissions on the Nextcloud instance
- Outbound HTTPS to `ghcr.io` (image pull) and `server.beeflow.nl` (or your self-hosted Bee Flow server)

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

| Your setup | Daemon | One-time command |
|---|---|---|
| **Vanilla Nextcloud** (self-managed bare-metal or VM with Docker) | `docker-install` | See [§2a](#2a-vanilla-nextcloud) below |
| **Nextcloud All-in-One** (AIO master container) | `docker-install` (auto-configured) | Usually nothing — see [§2b](#2b-nextcloud-all-in-one) |
| **Behind reverse proxy / NAT** (NC not directly reachable from the public internet) | `docker-install` + `BEEFLOW_NC_PUBLIC_URL` | See [§2c](#2c-behind-reverse-proxy-or-nat) |
| **Nextcloud 32+, multi-tenant, or heavy chat/streaming use** | **HaRP** (recommended) | See [§2d](#2d-harp-recommended-for-nextcloud-32) |

:::tip[Which daemon should I pick?]
On **Nextcloud 32+, HaRP is the recommended daemon.** With the `docker-install` / Docker-Socket-Proxy daemons, every browser request to Bee Flow is proxied **through the Nextcloud PHP process** — so a busy chat (long-lived streaming responses) plus the burst of requests the app makes on load can saturate Nextcloud's PHP worker pool and cause **some API calls to stall or drop intermittently**. HaRP routes those requests straight to the connector, bypassing PHP, and natively supports streaming. If you see flaky/dropped calls under load, [migrate to HaRP](../connector/troubleshooting.md#migrate-to-harp).
:::

### 2a. Vanilla Nextcloud

Register a daemon that talks to the host's Docker socket. Run this once on the server hosting Nextcloud:

```bash
sudo -u www-data php occ app_api:daemon:register \
  docker_local \
  "Local Docker" \
  docker-install \
  http \
  localhost \
  http://nextcloud
```

Verify it works:

```bash
sudo -u www-data php occ app_api:daemon:list
sudo -u www-data php occ app_api:daemon:test docker_local
```

The Docker socket must be readable by `www-data`. On most Nextcloud Docker images this means adding `www-data` to the host's `docker` group inside the Nextcloud container:

```bash
docker exec <nextcloud-container> bash -c "
  groupadd -g $(stat -c '%g' /var/run/docker.sock) docker-host 2>/dev/null || true
  usermod -aG docker-host www-data
"
```

### 2b. Nextcloud All-in-One

Nextcloud AIO ships AppAPI pre-installed and exposes a docker-socket-proxy on `nextcloud-aio-docker-socket-proxy:2375`. The daemon is **already registered** in most AIO releases — verify with:

```bash
sudo docker exec --user www-data nextcloud-aio-nextcloud \
  php occ app_api:daemon:list
```

If the list is empty (older AIO image), register manually:

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

If your Nextcloud is reached via a public URL (e.g. `https://cloud.example.com`) but lives on a private network, Bee Flow Cloud needs a publicly resolvable callback URL for user-sync webhooks. Set `BEEFLOW_NC_PUBLIC_URL` on the ExApp **before** the install so the bootstrap handshake registers the right callback:

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow \
  BEEFLOW_NC_PUBLIC_URL "https://cloud.example.com"
```

If you forget this, the install still completes but user-sync webhooks fail silently and Bee Flow shows a yellow "user sync degraded" banner. You can set it any time after the install and run `app_api:app:redeploy bee_flow` to apply.

### 2d. HaRP (recommended for Nextcloud 32+)

[HaRP](https://github.com/nextcloud/HaRP) (the High-availability Reverse Proxy for AppAPI) is a single container that bundles HAProxy + a Docker-socket proxy + an FRP server. Unlike the `docker-install` daemons, HaRP proxies browser/API traffic **directly to the ExApp container, bypassing the Nextcloud PHP process** — saving Nextcloud resources, supporting streaming/WebSockets, and removing the PHP-worker-pool bottleneck that causes intermittent dropped calls under load. The connector container needs no inbound ports: it dials out to HaRP over an FRP tunnel.

**Requirements:** Nextcloud **32+** and the ability to run the HaRP container alongside Nextcloud.

1. **Run the HaRP container** following the [official HaRP setup](https://github.com/nextcloud/HaRP). You choose an `HP_SHARED_KEY` (a secret the daemon and Nextcloud share) and expose HaRP's HAProxy port (default `8780`) and FRP port (default `8782`).

2. **Register the HaRP daemon** in Nextcloud. In the admin UI: **Administration → AppAPI → Deploy Daemons → Register Daemon**, choose the **HaRP** template (the *"High-availability Reverse Proxy for Nextcloud ExApps"* option), and fill in the HaRP host, the shared key, and the FRP server address. The equivalent CLI form is:

   ```bash
   sudo -u www-data php occ app_api:daemon:register \
     harp1 "HaRP" docker-install \
     https <harp-host>:8780 "https://cloud.example.com" \
     --harp --harp-shared-key "<HP_SHARED_KEY>" \
     --harp-frp-address <harp-host> --harp-frp-port 8782
   ```

   :::note
   The exact `--harp*` flag names vary by AppAPI version — run `occ app_api:daemon:register --help` on your instance to confirm, or use the admin UI form (the screenshot above), which always matches your version.
   :::

   Verify:

   ```bash
   sudo -u www-data php occ app_api:daemon:list
   sudo -u www-data php occ app_api:daemon:test harp1
   ```

3. **Install Bee Flow onto the HaRP daemon** (step 3 below). If Bee Flow is already installed on another daemon, follow [Migrate to HaRP](../connector/troubleshooting.md#migrate-to-harp) instead — it preserves your tenant key so no re-provisioning happens.

The same connector image runs under HaRP and the legacy daemons; it detects HaRP automatically (via the `HP_SHARED_KEY` HaRP injects) and switches to the FRP tunnel + Unix-socket transport with no extra configuration.

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

![App Store listing](../img/screenshots/getting-started/nextcloud-app-store/)

## 4. Verify the install

After AppAPI reports the install as successful:

```bash
# Heartbeat from Nextcloud's perspective
sudo -u www-data php occ app_api:app:heartbeat bee_flow
# → {"status":"ok"}

# Direct heartbeat from the host (if reachable)
curl http://localhost:23000/heartbeat
# → {"status":"ok"}

# Container logs
docker logs nc_app_bee_flow --tail 50
# → [Webhooks] 12 registered, 4 skipped (optional apps), 0 failed
# → [Init] Background setup completed in 4210ms
```

A **bee icon** should now appear in your Nextcloud top bar.

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

You should see rows pointing at `.../apps/app_api/proxy/bee_flow/hooks/nextcloud`.

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
Triggers with no producer at all are labelled in the Routines builder rather
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
makes Bee Flow's tools and routines callable from Nextcloud's own **Assistant**,
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
access to — and every routine they have published as agent-callable. Tools carry
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

## 5. First-time consent

The first time **each user** opens Bee Flow they see a privacy-disclosure modal. Read, then **I agree — start Bee Flow**. Acceptance is recorded server-side so the modal never reappears for that user (unless the consent text version changes).

## 6. First-time admin wizard

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

This stops the container, removes it, and cleans up the AppAPI registration. The Bee Flow tenant is **not** deleted automatically — your data on the Bee Flow server (or hosted SaaS) stays until you delete the organisation explicitly via **Settings → Organisation → Danger zone**.

## Troubleshooting

If the install hangs, fails, or the heartbeat doesn't return: see [Connector → Troubleshooting](../connector/troubleshooting.md). The most common causes are:

- AppAPI's deployment daemon can't pull from `ghcr.io` (firewall / DNS)
- Port 23000 already taken on the host
- **Automations never fire.** Almost always one of: the `webhook_listeners` app
  is not enabled, or no background-job workers are running so events sit in the
  queue for up to 5 minutes. See [Enable real-time triggers](#4a-enable-real-time-triggers).
  Confirm with `occ webhook_listeners:list` — no rows means the connector never
  registered; check `docker logs nc_app_bee_flow | grep Webhooks` for the reason.
- HaRP doesn't trust a local insecure registry (dev-only)
- **Icon appears but the app is blank on a local AIO + HaRP with a self-signed certificate** — HaRP and Nextcloud's own PHP can't verify the cert, so the embedded app's requests 500. Run [`aio-trust-local-cert.sh`](local-development.md#testing-on-a-local-nextcloud-aio-harp--a-self-signed-certificate) (local testing only; a real/valid certificate needs no step).
