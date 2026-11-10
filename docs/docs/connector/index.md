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
