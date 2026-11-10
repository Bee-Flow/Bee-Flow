---
title: Nextcloud connector
---

# Nextcloud connector

The connector is the Nextcloud ExApp that bridges your Nextcloud to a Bee Flow server. It runs as a Docker container next to your Nextcloud, deployed and managed by [AppAPI](https://apps.nextcloud.com/apps/app_api).

It requires AppAPI with a Docker deploy daemon; [HaRP](../getting-started/nextcloud.md#2d-harp) is recommended, and with HaRP your reverse proxy needs [one extra rule](deploy-daemon.md#exapps-rule). It cannot be installed on managed or shared hosting without Docker.

**The connector has no Bee Flow server until an administrator chooses one.** After installing, a Nextcloud administrator opens Bee Flow and [chooses where it runs](setup-picker.md): Bee Flow Cloud or your own server. Until then nothing is sent to any Bee Flow server.

- **Source**: [github.com/Bee-Flow/connector](https://github.com/Bee-Flow/connector)
- **License**: AGPL-3.0-or-later
- **Image**: `ghcr.io/bee-flow/connector:latest` (multi-arch: amd64, arm64)
- **App ID**: `bee_flow`
- **Port**: a TCP port AppAPI assigns (from 23000 up); with HaRP's tunnel a Unix socket and no published port

## What it does

| Responsibility | Mechanism |
|----------------|-----------|
| Serve the Bee Flow web UI | Static React bundle (the `agent-hub` frontend), baked into the image |
| Authenticate users | Nextcloud session validated by AppAPI's signed proxy — no second login |
| Forward API calls | Reverse-proxy `^api/` and `^auth/` to the Bee Flow service over TLS |
| Call back into Nextcloud | HMAC-signed `/nc/*` proxy lets the Bee Flow service reach Files / Mail / Calendar / Deck / Talk on the user's behalf |
| Deliver Nextcloud events to automations | Registers rows with Nextcloud's `webhook_listeners` app (Files, tags, Calendar, and Forms / Tables / Deck when installed); deliveries arrive on `/hooks/nextcloud` |
| Sync user/group changes | Periodic sync from the Bee Flow service plus a manual "Sync now" (Nextcloud's user and group events cannot be delivered as webhooks) |

## Deployment topology

```
                ┌──────────────────────────────┐
                │  Browser (Nextcloud UI)      │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Nextcloud server            │
                │  ─ AppAPI signed proxy       │
                │  ─ Auth, sessions            │
                └──────────────┬───────────────┘
                               │ AppAPI signature
                               ▼
                ┌──────────────────────────────┐
                │  Bee Flow connector (ExApp)  │
                │  ─ Express                   │
                │  ─ Static SPA + reverse proxy│
                └───┬─────────────────┬────────┘
                    │                 │
       browser SPA  │                 │ HMAC-signed /nc/*
     (agent-hub SPA)│                 │ reverse proxy
                    │                 │
                    ▼                 ▼
        ┌────────────────────┐  ┌──────────────────┐
        │  Bee Flow server   │  │  Nextcloud APIs  │
        │  the one chosen:   │  │  Files / Mail /  │
        │  Cloud or your own │  │  Calendar / ...  │
        └────────────────────┘  └──────────────────┘
```

The connector and Nextcloud always sit on the same network. The connector talks to the chosen Bee Flow server over the public internet (or a private network if you self-host both). While no server is chosen, the lower-left box does not exist: the connector serves its own setup page and talks to Nextcloud only.

## Supported Nextcloud versions

| NC | Status |
|----|:------:|
| 33 | ✅ |
| 34 | ✅ |
| 35 | ✅ |

The supported range is declared in [`appinfo/info.xml`](https://github.com/Bee-Flow/connector/blob/main/appinfo/info.xml):

```xml
<dependencies>
  <nextcloud min-version="33" max-version="35"/>
</dependencies>
```

## Compatibility {#compatibility}

What the connector runs on. The statuses mean:

- **Supported**: the connector has code and tests for it, or we run it ourselves.
- **Works, not tested by us**: the connector's code and the AppAPI, HaRP or All-in-One source say it works; we did not run this setup.
- **Not tested by us**: nothing we read rules it out, and we cannot say that it works.
- **Not possible**: it cannot work, for the reason given.

### Nextcloud version

| Configuration | Status | Note |
|---|---|---|
| Nextcloud 33, 34, 35 | Supported | The range in the manifest. |
| Nextcloud 32 and older | Not possible | Nextcloud does not offer or install the app below version 33. Update Nextcloud first. |
| Nextcloud 36 and newer | Not possible yet | The manifest ends at 35. A later connector release raises the range. |

### How Nextcloud is installed

| Configuration | Status | Note |
|---|---|---|
| Community Docker image behind your own reverse proxy, HaRP daemon | Supported | Our development sandbox runs this shape with nginx. Needs the [`/exapps/` rule](deploy-daemon.md#exapps-rule). Proxies other than nginx: works, not tested by us. |
| Bare metal or a virtual machine with Docker, HaRP daemon | Works, not tested by us | Same rule in the web server or proxy that serves Nextcloud. |
| Nextcloud All-in-One with its HaRP container | Works, not tested by us | All-in-One routes `/exapps/` by itself. On this daemon the app is reached through Nextcloud, see [Deploy daemon → All-in-One](deploy-daemon.md#aio). |
| An existing Docker Socket Proxy daemon (also All-in-One's) | Works, with a limit | Streaming answers arrive in one piece and each request holds a PHP worker; the daemon is deprecated upstream. [Migrate to HaRP](troubleshooting.md#migrate-to-harp). |
| Snap | Not tested by us | Needs Docker on the host and a place for the `/exapps/` rule. |
| NAS appliances, arm64 hosts | Not tested by us | The connector image is built for amd64 and arm64. |
| Kubernetes deploy daemon | Not tested by us | AppAPI has one from Nextcloud 34. |
| Managed or shared hosting, or any host where you cannot run Docker or Kubernetes for AppAPI | Not possible | AppAPI deploys ExApps as containers only. Use Bee Flow with that Nextcloud [without the connector](../integrations/nextcloud.md#no-docker). |

The full table per install method, with what you add yourself, is in [Deploy daemon and reverse proxy](deploy-daemon.md#per-install-method).

### Network and certificates

| Configuration | Status | Note |
|---|---|---|
| Nextcloud behind a reverse proxy, with a public name that differs from its internal one | Supported | Enter the public address as **Public Nextcloud URL** on the setup page. |
| Nextcloud with a self-signed certificate or one from your own certificate authority | Works with your own Bee Flow server, not tested by us end to end; not possible with Bee Flow Cloud | The connector trusts it for the Nextcloud address only (`BEEFLOW_NC_CA_CERT`, `BEEFLOW_NC_TLS_PIN`). The Bee Flow server calls your Nextcloud too and has to trust the certificate as well: see [Nextcloud with its own certificate](troubleshooting.md#nextcloud-certificate). |
| Your own Bee Flow server with a certificate from your own certificate authority | Supported | `BEEFLOW_SERVER_CA_CERT` at install time. Verification stays on. |
| An outbound proxy between the connector and the Bee Flow server | Supported | `HTTPS_PROXY` and `NO_PROXY` at install time. |
| Nextcloud that cannot call its own public address (hairpin NAT, tunnel) | Supported | Nextcloud delivers events to the connector through AppAPI, not through its public address. |
| Nextcloud on a private network, with Bee Flow Cloud | Not possible | Bee Flow Cloud has to reach your Nextcloud. See [Nextcloud is not reachable from the internet](troubleshooting.md#not-reachable). |
| Nextcloud on a private network, with your own Bee Flow server | Works, not tested by us | Needs one server setting, with a warning: same section. |
| Nextcloud behind Cloudflare (proxy or Tunnel) | Works, not tested by us | See [Nextcloud behind Cloudflare](troubleshooting.md#cloudflare). |

### Accounts

| Configuration | Status | Note |
|---|---|---|
| Users who sign in to Nextcloud through LDAP, SAML, OpenID Connect or with two-factor authentication | Supported | Bee Flow uses the Nextcloud session, however the user signed in. |
| A Nextcloud account without an e-mail address | Not possible for that user | Bee Flow needs an address for every user; see [Troubleshooting](troubleshooting.md#your-nextcloud-account-has-no-e-mail-address). |

## Trust model in one paragraph

The connector trusts AppAPI's shared secret on every inbound `/init`, `/enabled`, `/api/*`, `/auth/*`, `/setup/*`, `/webhook/*` request; `/heartbeat` is the one route it answers without it, and there it discloses only liveness and a coarse setup state. It trusts an HMAC signed with the tenant key on every inbound `/nc/*` request from the Bee Flow service. It trusts no other input. Outbound, it signs every request to the Bee Flow service with the same tenant-key HMAC, and signs every NC OCS / DAV call with AppAPI's user-impersonation header. There is no shared secret beyond the AppAPI app secret (set by Nextcloud) and the tenant key (issued by the Bee Flow server an administrator chose, when the connector connects to it).

## Deeper reading

- [Deploy daemon and reverse proxy](deploy-daemon.md) — which daemon applies to which install, and the `/exapps/` rule HaRP needs.
- [Choose where Bee Flow runs](setup-picker.md) — the setup page, the install-time value, and how the server is resolved.
- [Bee Flow on your own server next to Nextcloud](own-server.md) — who installs what, what the host needs, and where it does not work.
- [Architecture](architecture.md) — full request-flow diagrams, lifecycle, HMAC spec.
- [Permissions & scopes](permissions.md) — exactly what data leaves your tenant.
- [Privacy & data flow](privacy.md) — what's sent to the Bee Flow service and when.
- [Troubleshooting](troubleshooting.md) — install hangs, heartbeat failures, log locations, error matrix.
