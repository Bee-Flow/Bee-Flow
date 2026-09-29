---
title: Docker Compose
---

# Docker Compose

The fastest way to self-host Bee Flow on a single host. Production-ready for small/mid orgs.

## Easy install (recommended) {#easy-install}

Pulls prebuilt **public** images from `ghcr.io/bee-flow` — no registry login, no source build.

**Prerequisites:** a Linux/macOS host with Docker and the Docker Compose plugin.

1. Get the three install files (from a release bundle, or copied out of the repo):
   - `selfhost.sh`
   - `docker-compose.from-registry.yml`
   - `.env.selfhost.example`
2. Run the installer:

   ```bash
   ./selfhost.sh
   ```

   It checks Docker, generates fresh secrets into `.env`, pulls the images, starts the **core** stack,
   waits for the server to report healthy, and prints your URL and the generated `admin` password.

3. Open **http://localhost:5176**, sign in as `admin` with the printed password, and change it.

Add optional sidecars by passing profiles:

```bash
PROFILES="core search guard" ./selfhost.sh   # adds knowledge search + PII guard
```

To run models on your own hardware instead of a cloud API, add the `local-llm`
profile — it starts an Ollama container alongside the stack:

```bash
PROFILES="core local-llm" ./selfhost.sh
```

Then set `OLLAMA_URL=http://ollama:11434` in `.env`, restart, and download a model
from **Admin → AI → Providers → Local models**. Full guide:
[Local models](../admin/local-models.md).

This runs in `DEPLOYMENT_MODE=self-hosted`: no billing, and paid features unlock when you activate a
server-wide licence key (see [Activate a licence](#activate-a-licence)).

### What the core profile starts

| Service | Image | Address |
|---|---|---|
| Bee Flow server (API) | `ghcr.io/bee-flow/server` | `localhost:3001` |
| Web UI (`agent-hub`) | `ghcr.io/bee-flow/agent-hub` | `localhost:5176` |
| PostgreSQL + pgvector | `pgvector/pgvector:pg15` | internal |
| Object storage (RustFS) | `rustfs/rustfs` | internal |

Health check once it's up:

```bash
curl http://127.0.0.1:3001/api/health   # {"status":"ok",...}
```

## Three databases, not one {#three-databases-not-one}

The stack uses **three** Postgres databases on the same instance:

| Database | What it stores | Env var |
|---|---|---|
| `beeflow_core` | Users, agents, conversations, KBs, audit log, settings — the bulk of state | `CORE_DATABASE_URL` |
| `beeflow_tasks` | Project / reminder / aiTasks rows for the productivity layer | `DATABASE_URL` |
| `monitoring_db` | Long-tail metrics | `MONITORING_DATABASE_URL` |

`docker/init-db.sh` (bind-mounted into the Postgres container, and materialised by `selfhost.sh` if
missing) creates the two auxiliary databases and enables the `pgvector` extension on first start.

## Activate a licence (unlock paid features) {#activate-a-licence}

Self-hosted installs run on the free **community** tier by default — **no licence key is required**, and
community is a fully usable floor (chat, knowledge bases, multi-user, the Nextcloud connector). You only
need a licence to unlock premium features (automations, meeting notes, guardrails, and more).

To unlock enterprise features for the whole install, sign in as a super-admin → **Admin → Licence** →
paste your **server-wide** licence key (a JWT issued by Bee Flow, or an admin-issued blob). Pricing and
keys are at [beeflow.nl](https://beeflow.nl); see [Applying a licence key](../licensing/apply.md). To
verify production keys, set `LICENSE_PUBLIC_KEY` (or `LICENSE_PUBLIC_KEY_FILE`) in `.env`.

## Connect your Nextcloud {#connect-nextcloud}

You do **not** need to set any Nextcloud env vars on the server. Instead, point the Bee Flow connector
(the Nextcloud ExApp) at your self-hosted server from the Nextcloud admin UI:

1. Install the Bee Flow connector on your Nextcloud (App Store, or `occ app_api:app:register bee_flow …`
   — see [Getting started → Nextcloud](../getting-started/nextcloud.md)).
2. In Nextcloud, go to **Settings → Administration → AI → Bee Flow**.
3. Set **Deployment mode** to **Self-hosted server** and enter your server's base URL
   (e.g. `https://bee-flow.your-domain.com`, or `http://<host>:5176` on a LAN).

   :::caution The API port is loopback-only by default
   The connector runs on your **Nextcloud** host, so it reaches Bee Flow across the network. Since
   the API container publishes port `3001` on `127.0.0.1` only, `http://<host>:3001` is not
   reachable from another machine. Use the frontend URL (`http://<host>:5176`, or whatever you put
   in front of it) — nginx proxies `/auth` and `/api` to the backend. If you specifically need the
   API port exposed, set `SERVER_BIND_HOST=0.0.0.0` in `.env` and restart the stack.
   :::
4. Within ~60 s the connector re-bootstraps against your server (it provisions an organisation and a
   tenant key automatically). Nextcloud users can now open Bee Flow and sign in.

The connector keeps working against Bee Flow Cloud by default — switching to *Self-hosted server* is
opt-in per Nextcloud and is reversible (a bad URL rolls back to the previous target).

## Manual / advanced installs {#manual}

- **Build from source:** clone the repo and use `docker-compose.install.yml` with `--build` instead of
  the registry compose file.
- **Credentialed wizard:** `install-from-registry.sh` launches a graphical wizard that pulls from a
  private registry (requires a `.credentials` file). Prefer `selfhost.sh` for the public path.
  The wizard's update check sends the registry credentials over HTTPS with a verified certificate
  only. For a registry with a self-signed certificate, add `REGISTRY_INSECURE_TLS=1` to
  `.credentials`; for a plain-HTTP registry, add `REGISTRY_ALLOW_HTTP=1`. The HTTP request never
  carries the credentials, so it only reports updates from a registry that allows anonymous reads.

## Reverse proxy + TLS

To expose the install on a public hostname, terminate TLS in a reverse proxy.

:::tip Easy install topology
With the [easy install](#easy-install), the `agent-hub` container already serves the SPA **and**
proxies `/api`, `/auth`, `/agents`, `/ai` to the server internally. So you only need to reverse-proxy
your domain to the **agent-hub** container (`localhost:5176`) — no per-path rules required:

```caddyfile
bee-flow.example.com {
    reverse_proxy 127.0.0.1:5176
}
```

The per-path examples below are for the manual/source topology where you serve a static frontend
separately and talk to the server on `localhost:3001` directly.
:::

### Caddy (simplest)

```caddyfile
beeflow.example.com {
    handle /api/* { reverse_proxy 127.0.0.1:3001 }
    handle /auth/* { reverse_proxy 127.0.0.1:3001 }
    handle /webhook/* { reverse_proxy 127.0.0.1:3001 }
    handle { root * /var/www/beeflow-frontend; file_server; try_files {path} /index.html }
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name beeflow.example.com;
    ssl_certificate /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    root /var/www/beeflow-frontend;
    index index.html;

    location / { try_files $uri /index.html; }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;          # SSE
        proxy_read_timeout 600s;
    }
    location /auth/   { proxy_pass http://127.0.0.1:3001; }
    location /webhook/{ proxy_pass http://127.0.0.1:3001; }
}
```

The `proxy_buffering off` + `proxy_read_timeout` lines are required for chat streaming to work.

### Traefik (Docker Compose labels)

```yaml
services:
  beeflow-server:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.beeflow.rule=Host(`beeflow.example.com`) && (PathPrefix(`/api`) || PathPrefix(`/auth`) || PathPrefix(`/webhook`))"
      - "traefik.http.routers.beeflow.tls.certresolver=letsencrypt"
      - "traefik.http.services.beeflow.loadbalancer.server.port=3001"
      - "traefik.http.services.beeflow.loadbalancer.server.scheme=http"
```

## Serving the frontend (manual topology only)

The [easy install](#easy-install) already serves the web UI from the `agent-hub` container — you do not
need to build it yourself. Build a standalone static bundle only if you want to host the frontend
elsewhere (CDN, separate static host):

```bash
# from the agent-hub/ directory of the source repo
npm install
VITE_API_URL=https://bee-flow.example.com npm run build   # outputs dist/
```

Then serve `dist/` from any static host and point it at your server URL.

## Licence and Nextcloud

- **Unlock paid features:** see [Activate a licence](#activate-a-licence) above.
- **Connect a Nextcloud:** see [Connect your Nextcloud](#connect-nextcloud) above — done from the
  Nextcloud admin UI, no server env vars required.

## Backups

Everything durable lives in Postgres. Back up daily with `pg_dump`:

```bash
# back up each database (beeflow_core holds the bulk of state)
docker exec -t beeflow-postgres \
  pg_dump -U beeflow -d beeflow_core -Fc > /backups/beeflow_core-$(date +%F).dump
```

Restore:

```bash
cat beeflow_core-YYYY-MM-DD.dump | docker exec -i beeflow-postgres \
  pg_restore -U beeflow -d beeflow_core --clean --if-exists
```

The `beeflow-data` volume holds short-lived state only — losing it is recoverable from Postgres on restart.

## Swap Postgres for managed

Bee Flow needs Postgres 15+ with `pgvector` (the bundled image is `pgvector/pgvector:pg15`) if you
want vector KBs. Tested managed providers:

| Provider | Notes |
|----------|-------|
| Neon | ✅ — pgvector built-in. |
| Supabase | ✅ — pgvector built-in. |
| AWS RDS | ✅ — install `pgvector` extension (RDS supports it). |
| Google Cloud SQL | ✅ — install `pgvector` extension. |
| Heroku Postgres | ⚠️ — works for non-vector KBs only (no pgvector). |

The server itself is configured with three connection URLs (`CORE_DATABASE_URL`, `DATABASE_URL`,
`MONITORING_DATABASE_URL`), which the compose file builds from `DB_USER` / `DB_PASSWORD` /
`DB_NAME` and points at the bundled `postgres` service. To use a managed instance: create the
[three databases](#three-databases-not-one) there (with `pgvector` enabled), edit those three URLs
in the compose file (or an override file) to point at it, and remove the `postgres` service.

## Restart and update

```bash
# Restart the server only (the compose service is named `server`;
# the container it runs is `beeflow-server`)
docker compose -f docker-compose.from-registry.yml --profile core restart server

# View server logs (same as ./selfhost.sh --logs)
docker compose -f docker-compose.from-registry.yml logs -f server
```

To move to a new release, don't pull a single service — the stack is released and upgraded as one
unit (set `TAG`, pull, `up -d`, verify). The full procedure, including backups and rollback:
[Upgrades](upgrades.md).

## Production hardening checklist

- [ ] `SESSION_SECRET` and `MASTER_ENCRYPTION_KEY` set to fresh random values (`selfhost.sh` does this)
- [ ] First admin password (`INIT_ADMIN_PASSWORD`) changed after first login
- [ ] `DB_PASSWORD` / `RUSTFS_SECRET_KEY` set; Postgres and object storage not exposed publicly
- [ ] HTTPS in front of the stack (`COOKIE_SECURE=true` once behind TLS)
- [ ] `LICENSE_PUBLIC_KEY` set if you activate production licence keys
- [ ] Daily `pg_dump` running and tested-restored at least once
- [ ] At least one model provider key set (in-app, Admin → AI settings)
- [ ] Rate limit at the reverse proxy (e.g. Caddy `request_body max_size 10MB`, Nginx `limit_req_zone`)
- [ ] Audit log shipped off-host (Loki / ELK / Splunk) — see [Reference → Telemetry](../reference/telemetry.md)
