---
title: Nextcloud connector
---

# Nextcloud connector

The connector is the Nextcloud ExApp that bridges your Nextcloud to the Bee Flow service. It runs as a Docker container next to your Nextcloud, deployed and managed by [AppAPI](https://apps.nextcloud.com/apps/app_api).

- **Source**: [github.com/Bee-Flow/connector](https://github.com/Bee-Flow/connector)
- **License**: AGPL-3.0-or-later
- **Image**: `ghcr.io/bee-flow/connector:latest` (multi-arch: amd64, arm64)
- **App ID**: `bee_flow`
- **Port**: 23000 (configurable via AppAPI)

## What it does

| Responsibility | Mechanism |
|----------------|-----------|
| Serve the Bee Flow web UI | Static React bundle (the `agent-hub` frontend), baked into the image |
| Authenticate users | Nextcloud session validated by AppAPI's signed proxy — no second login |
| Forward API calls | Reverse-proxy `^api/` and `^auth/` to the Bee Flow service over TLS |
| Call back into Nextcloud | HMAC-signed `/nc/*` proxy lets the Bee Flow service reach Files / Mail / Calendar / Deck / Talk on the user's behalf |
| Sync user/group changes | Subscribes to 5 NC events; forwards to the Bee Flow service via `/webhook/nc-events` |

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
                │  ─ Express on :23000         │
                │  ─ Static SPA + reverse proxy│
                └───┬─────────────────┬────────┘
                    │                 │
       browser SPA  │                 │ HMAC-signed /nc/*
     (agent-hub SPA)│                 │ reverse proxy
                    │                 │
                    ▼                 ▼
        ┌────────────────────┐  ┌──────────────────┐
        │  Bee Flow service  │  │  Nextcloud APIs  │
        │  server.beeflow.nl or │  │  Files / Mail /  │
        │  self-hosted       │  │  Calendar / ...  │
        └────────────────────┘  └──────────────────┘
```

The connector and Nextcloud always sit on the same network. The connector talks to the Bee Flow service over the public internet (or a private network if you self-host both).

## Supported Nextcloud versions

| NC | Status |
|----|:------:|
| 31 | ✅ |
| 32 | ✅ |
| 33.0.0 | ⚠️ broken events listener — sync degrades gracefully, fix in 33.0.1 |
| 33.0.1+ | ✅ |
| 34 | ✅ |

The supported range is declared in [`appinfo/info.xml`](https://github.com/Bee-Flow/connector/blob/main/appinfo/info.xml):

```xml
<dependencies>
  <nextcloud min-version="31" max-version="34"/>
</dependencies>
```

## Trust model in one paragraph

The connector trusts AppAPI's signature on every inbound `/init`, `/heartbeat`, `/enabled`, `/api/*`, `/auth/*`, `/webhook/*` request. It trusts an HMAC signed with the tenant key on every inbound `/nc/*` request from the Bee Flow service. It trusts no other input. Outbound, it signs every request to the Bee Flow service with the same tenant-key HMAC, and signs every NC OCS / DAV call with AppAPI's user-impersonation header. There is no shared secret beyond the AppAPI app secret (set by Nextcloud) and the tenant key (provisioned at first install).

## Deeper reading

- [Architecture](architecture.md) — full request-flow diagrams, lifecycle, HMAC spec.
- [Permissions & scopes](permissions.md) — exactly what data leaves your tenant.
- [Privacy & data flow](privacy.md) — what's sent to the Bee Flow service and when.
- [Troubleshooting](troubleshooting.md) — install hangs, heartbeat failures, log locations, error matrix.
