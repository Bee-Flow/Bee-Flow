---
title: Connect to Bee Flow Cloud or self-hosted
---

# Connect to Bee Flow Cloud or self-hosted

The connector ships with a **setup picker** — a small page hosted by the connector itself where an admin chooses whether this Nextcloud talks to **Bee Flow Cloud** (`server.beeflow.nl`) or to a **self-hosted Bee Flow server**.

This page is what lets you switch targets without ever touching the command line.

## Where to find it

From inside Nextcloud, with the Bee Flow connector installed:

```
http://<your-nextcloud>/index.php/apps/app_api/embedded/bee_flow/setup
```

Direct (only reachable from the host running the connector container):

```
http://localhost:23000/setup
```

(Replace `23000` with the connector's actual port — check with `docker ps`.)

The page is admin-gated through AppAPI, so only Nextcloud admins can open it through the embedded URL.

## What it looks like

Two big cards:

- **☁️ Bee Flow Cloud** — recommended. One click and you're done.
- **🏠 Self-hosted server** — paste the URL of your own server. Test it before saving.

After saving, the connector:

1. Persists the choice to `${APP_PERSISTENT_STORAGE}/setup-config.json` (`mode 0600`, alongside the tenant-key cache).
2. Updates the in-memory `apiBaseUrl` so the SPA picks up the new target on its next request — no container restart needed.
3. **Discards the existing tenant key** if the SaaS target changed (the old key was issued by a different service) and triggers a fresh background bootstrap against the new target.

## Three configuration paths

The effective `apiBaseUrl` is resolved at every startup using this priority:

| # | Source | Set how |
|---|--------|---------|
| 1 | `BEEFLOW_API_BASE_URL` env var | `occ app_api:app:setenv bee_flow BEEFLOW_API_BASE_URL <url>` |
| 2 | `setup-config.json` (the picker) | The `/setup` page |
| 3 | `https://server.beeflow.nl` | Default — Bee Flow Cloud |

If the env var is set, the picker shows a **🔒 Env-locked** badge and the form is disabled. To unlock:

```bash
sudo -u www-data php occ app_api:app:setenv bee_flow BEEFLOW_API_BASE_URL ''
```

## "Test connection" before saving

The form has a **Test connection** button that probes `<your-url>/api/health` from the connector container's perspective and reports:

- HTTP status (200, 404, …)
- `version` and `tier` if the server includes them
- Network error class (DNS failure, connection refused, TLS error, timeout)

This is the same hostname/network the connector itself will use, so a green test means the save is going to work.

## Switching back

The picker is reachable any time. Switching from self-hosted back to Cloud is a single click — same flow, no manual cleanup.

When you switch:

- The previous tenant key is dropped.
- A fresh bootstrap runs against the new target.
- Existing chat history / agents / KBs in the SPA are tied to the old tenant; they won't follow you to the new SaaS.

## Programmatic alternative

For automated provisioning (Ansible, Terraform, CI):

```bash
# Lock the choice via the env var — picker stays read-only.
sudo -u www-data php occ app_api:app:setenv bee_flow \
    BEEFLOW_API_BASE_URL https://beeflow.example.com

# Or POST directly to the connector if you want the picker to remain editable.
curl -sX POST http://localhost:23000/setup \
    -H 'Content-Type: application/json' \
    -d '{"mode":"self-hosted","apiBaseUrl":"https://beeflow.example.com"}'
```

The `POST /setup` endpoint is admin-gated through AppAPI's signed proxy when called via Nextcloud, so the curl-from-host shortcut only works on the same machine where the connector is running.

## What about the tenant key?

`BEEFLOW_TENANT_KEY=auto` (default) plays nicely with the picker — switching SaaS targets triggers a re-bootstrap that mints a new key against the new service. If you've explicitly set `BEEFLOW_TENANT_KEY` to a fixed value (e.g. for an enterprise reinstall against an existing tenant), you'll want to update that too via `occ app_api:app:setenv` before / after switching targets. See [Connector → Architecture](architecture.md#bootstrap-flow) for the full key-resolution order.

## OAuth callback URL — `connectorCallbackUrl`

OAuth flows initiated by the connector (e.g. linking Google or Microsoft from inside Nextcloud) need a stable, publicly-reachable URL to return to. The connector derives this at startup as:

```
<NC public URL>/index.php/apps/app_api/proxy/bee_flow/auth/<provider>/callback
```

— routed through NC's AppAPI proxy path, not the Docker-internal `nc_app_bee_flow:23000` hostname. Earlier builds used the internal hostname, which broke OAuth from App Store installs (the provider redirected the user's browser to a host it couldn't reach).

If OAuth round-trips break with `redirect_uri_mismatch` or land on a blank page, check the `BEEFLOW_NC_PUBLIC_URL` env var (or NC's `overwrite.cli.url` / `trusted_domains`). It needs to match the URL users actually browse to. The connector logs the resolved callback URL on every OAuth start — grep for `[OAuth] callback resolved to` in `docker logs nc_app_bee_flow`.
