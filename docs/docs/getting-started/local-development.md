---
title: Run locally with a local Nextcloud
---

# Run locally with a local Nextcloud

This page walks you through running the Bee Flow connector on your laptop, against a local Nextcloud, **without** publishing anything to the Nextcloud App Store. Useful for:

- Testing connector changes you haven't released yet
- Verifying an end-to-end install on your machine before submitting to the App Store
- Demoing Bee Flow on an air-gapped laptop

Two paths, pick one:

- **Fast (recommended)** — run the [`local-sandbox.sh`](https://github.com/Bee-Flow/connector/blob/main/scripts/local-sandbox.sh) helper. One command does the whole setup.
- **Manual** — every step, so you can swap in your own pieces.

:::tip[Working in the Bee Flow monorepo]

If you're working in the private Bee Flow monorepo (not the public connector clone), the same script is wrapped at `scripts/run-local-nc.sh` for convenience:

```bash
./scripts/run-local-nc.sh up        # build + run
./scripts/run-local-nc.sh status    # state + heartbeat
./scripts/run-local-nc.sh logs      # combined NC + connector tail
./scripts/run-local-nc.sh down      # stop
./scripts/run-local-nc.sh clean     # nuke everything
```

Both wrappers call the same `local-sandbox.sh` underneath — pick whichever is closer to where you're working.

:::

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Docker | recent | `docker info` must work without `sudo` |
| Git | any | for cloning |
| Node.js | 20+ | only needed if you want to run the Bee Flow server / frontend locally |

You don't need a public hostname, OAuth apps, model API keys, or anything paid. The local sandbox uses a dummy tenant key so the connector never reaches out to the production Bee Flow service.

---

## Path A — fast path (the helper script)

This is what works today; it's how I (the maintainer) test connector changes.

### 1. Clone the connector repo

```bash
git clone https://github.com/Bee-Flow/connector.git
cd connector
```

### 2. Bring the sandbox up

```bash
./scripts/local-sandbox.sh up
```

What it does, in order:

1. **Builds** `bee-flow-connector:dev` from the local `Dockerfile`. The Dockerfile clones [`Bee-Flow/hive`](https://github.com/Bee-Flow/hive) anonymously over HTTPS at build time and bakes the SPA into the image — no SSH key or GitHub token required.
2. **Launches** a `nextcloud:31` container at [http://localhost:8080](http://localhost:8080) with admin/admin.
3. **Installs** AppAPI inside Nextcloud (`occ app:install app_api`).
4. **Registers** a `manual_dev` deployment daemon — uses your host's Docker daemon directly, so HaRP / insecure-registry trust doesn't apply.
5. **Registers** the ExApp via `occ app_api:app:register bee_flow manual_dev --info-xml /tmp/info.xml`.
6. The connector container starts, runs the async `/init`, registers its top-bar entry + embed script, subscribes to NC events.
7. Prints a final URL.

End state: [http://localhost:8080](http://localhost:8080), log in `admin` / `admin`, click the bee in the top bar.

### 2b. HaRP mode (optional)

```bash
HARP=1 ./scripts/local-sandbox.sh up      # or: ./scripts/local-sandbox.sh up --harp
```

The default sandbox reaches the connector through Nextcloud's AppAPI PHP proxy, which buffers every response until the ExApp is done — so streamed replies (chat, the automation builder) arrive in one burst at the end. `HARP=1` reproduces the production shape instead: a HaRP container plus an nginx front door on `:8080` (`/exapps/` → HaRP, everything else → Nextcloud), the connector dialling out over the FRP tunnel with no published port, a `bee_flow_harp` daemon instead of `manual_dev`, the shared key in `.sandbox/harp.key` (gitignored) and the tenant key cached in a named volume so recreates don't re-provision an org. A plain `up` switches back. Details in the [connector README](https://github.com/Bee-Flow/Bee-Flow/tree/main/nextcloud-connector#harp-mode-streams-arrive-live).

### 3. Useful subcommands

```bash
./scripts/local-sandbox.sh status   # is it up?
./scripts/local-sandbox.sh logs     # tail connector + NC logs
./scripts/local-sandbox.sh down     # stop containers (keep state)
./scripts/local-sandbox.sh clean    # stop + remove containers + volumes
FORCE=1 ./scripts/local-sandbox.sh up  # force re-register from info.xml
HARP=1 ./scripts/local-sandbox.sh up   # HaRP mode — see 2b
```

### 4. Iterating on connector code

After you change `nextcloud-connector/src/*.js` or `appinfo/info.xml`:

```bash
docker rmi bee-flow-connector:dev          # invalidate the cached image
./scripts/local-sandbox.sh up              # rebuild + re-register
```

The script detects when `info.xml` is newer than the registered row and re-registers automatically — handy when you tweak routes.

### 5. Talking to a local Bee Flow server (optional)

By default the connector points at `http://host.docker.internal:3101` for the Bee Flow service. If you've cloned `Bee-Flow/beeflow` and run it locally on `:3101`, this Just Works™. Otherwise the connector will log "SaaS unreachable" — that's fine; the chat UI can still load, and you can verify NC integration plumbing without a backend.

To point at a different URL:

```bash
API_BASE_URL=http://host.docker.internal:9000 ./scripts/local-sandbox.sh up
```

---

## Path B — manual setup

This is the same flow, expanded so you can swap pieces.

### 1. Clone the three repos

```bash
git clone https://github.com/Bee-Flow/connector.git
git clone https://github.com/Bee-Flow/hive.git
git clone https://github.com/Bee-Flow/beeflow.git    # optional, only if you want a real backend
```

### 2. Build the connector image

The Dockerfile clones `Bee-Flow/hive` itself at build time, so you don't need to pre-build the frontend.

```bash
cd connector
docker build -t bee-flow-connector:dev .
```

If you want to use a **local** version of hive (with your changes):

```bash
# Build hive's dist/ first
cd ../hive
npm install
npm run build

# Now build the connector with that dist/ baked in instead of the cloned one
cd ../connector
docker build -t bee-flow-connector:dev \
    --build-arg HIVE_REPO=local \
    --build-context hive=../hive \
    .
```

### 3. Run a local Nextcloud

```bash
docker run -d --name bee-flow-nc-sandbox \
    -p 8080:80 \
    --add-host=host.docker.internal:host-gateway \
    nextcloud:31
```

Wait ~10 s for Apache, then:

```bash
docker exec -u www-data bee-flow-nc-sandbox php occ \
    maintenance:install \
    --database=sqlite \
    --admin-user=admin \
    --admin-pass=admin

docker exec -u www-data bee-flow-nc-sandbox php occ \
    config:system:set trusted_domains 1 --value=host.docker.internal
```

### 4. Install AppAPI

```bash
docker exec -u www-data bee-flow-nc-sandbox php occ app:install app_api
```

### 5. Register a `manual-install` deployment daemon

This daemon uses your host's Docker daemon directly — no HaRP, no insecure-registry trust dance.

```bash
docker exec -u www-data bee-flow-nc-sandbox php occ \
    app_api:daemon:register \
    manual_dev \
    "Manual Local" \
    manual-install \
    http \
    host.docker.internal \
    "http://host.docker.internal:8080"
```

### 6. Register the ExApp

The image is `bee-flow-connector:dev` on your host; the daemon will find it via the host Docker socket.

```bash
docker cp connector/appinfo/info.xml bee-flow-nc-sandbox:/tmp/info.xml

docker exec -u www-data bee-flow-nc-sandbox php occ \
    app_api:app:register \
    bee_flow \
    manual_dev \
    --info-xml /tmp/info.xml \
    --env "BEEFLOW_TENANT_KEY=dev-tenant-key" \
    --env "BEEFLOW_API_BASE_URL=http://host.docker.internal:3101"
```

`BEEFLOW_TENANT_KEY=dev-tenant-key` skips the bootstrap-against-SaaS step — the connector starts with the dummy key.

### 7. Verify

```bash
# Heartbeat from NC's perspective
docker exec -u www-data bee-flow-nc-sandbox php occ app_api:app:heartbeat bee_flow
# → {"status":"ok"}

# Connector logs
docker logs nc_app_bee_flow --tail 50
# → [Init] Background setup complete

# Open in browser
open http://localhost:8080
```

Log in as `admin` / `admin`, click the bee icon in the top bar. The Bee Flow SPA should render.

---

## What you can verify locally

| Verification | How |
|--------------|-----|
| AppAPI signature is honoured | Try `curl -i http://localhost:23000/init` (no auth) — expect 401. |
| HMAC `/nc/*` proxy works | From a separate shell, sign a request with `dev-tenant-key` and POST to the connector's `/nc/ocs/v2.php/cloud/users` — expect a list. |
| Async `/init` is fast | `time docker exec -u www-data bee-flow-nc-sandbox php occ app_api:app:enable bee_flow` — should return in &lt;1 s. |
| Top-bar entry registers | Reload NC; bee icon visible. |
| Embed script registers | Click the bee; SPA loads in the iframe. |
| Event subscriptions work | Create a new NC user (`occ user:add`); see `[Webhook] user.created` in connector logs. |
| Privacy-only mode | Without `BEEFLOW_API_BASE_URL` reachable, the SPA's chat panel will show "Backend unreachable" but the install / NC plumbing still verifies. |

---

## Common issues

### Image not found / pull errors

The `manual-install` daemon looks up images via the host's Docker daemon. If you see "image not found" make sure:

```bash
docker images | grep bee-flow-connector
```

…actually shows your image. If not, rebuild.

### Heartbeat times out

Make sure NC can reach the connector container:

```bash
# From inside the NC container:
docker exec bee-flow-nc-sandbox curl -i http://host.docker.internal:23000/heartbeat
```

If that hangs, your Docker network setup doesn't have `host-gateway` mapping. The `--add-host=host.docker.internal:host-gateway` flag in the run command is required on Linux; macOS / Windows have it built-in.

### Stuck "Setup in progress" forever

The SPA polls `/api/...` against the configured `BEEFLOW_API_BASE_URL`. With the default `http://host.docker.internal:3101` and no Bee Flow server running, it'll never resolve.

Fix: either run the Bee Flow server locally on `:3101`, or override:

```bash
docker exec -u www-data bee-flow-nc-sandbox php occ \
    app_api:app:setenv bee_flow BEEFLOW_API_BASE_URL https://server.beeflow.nl
```

…and restart the connector container.

### Wiped sandbox after testing

```bash
./scripts/local-sandbox.sh clean
```

…or, manually:

```bash
docker stop nc_app_bee_flow bee-flow-nc-sandbox
docker rm   nc_app_bee_flow bee-flow-nc-sandbox
docker rmi  bee-flow-connector:dev
```

---

## Pointing at a real Bee Flow server

Once you have the local install working, swap the dummy tenant key for the bootstrap flow against a real Bee Flow service:

```bash
# Remove the dummy key, switch to "auto"
docker exec -u www-data bee-flow-nc-sandbox php occ \
    app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY auto

# Point at server.beeflow.nl (or your self-hosted server)
docker exec -u www-data bee-flow-nc-sandbox php occ \
    app_api:app:setenv bee_flow BEEFLOW_API_BASE_URL https://server.beeflow.nl

docker restart nc_app_bee_flow
```

The connector now bootstraps a real tenant key against the SaaS on next start. Watch the logs:

```bash
docker logs nc_app_bee_flow -f | grep -i bootstrap
```

---

## Testing on a local Nextcloud AIO (HaRP + a self-signed certificate)

In its default mode the sandbox above uses a `manual-install` daemon and avoids HaRP entirely (`HARP=1` adds a HaRP without TLS, so this section still doesn't apply to it), so the certificate of your local Nextcloud never matters. If instead you want to test against a **local Nextcloud All-in-One with the HaRP daemon** — closer to a real production setup — and your AIO is served with a **self-signed or internal-CA certificate** (Caddy `tls internal`, a `*.nip.io` test domain, mkcert, …), there's one extra step.

### Why

On AIO, three different components call Nextcloud over HTTPS and **verify the TLS certificate**. With a self-signed cert, the ones that don't trust it fail and **every** ExApp browser request returns HTTP 500 — the Bee Flow icon appears in the top bar but clicking it shows a **blank page**. This is a Nextcloud-AIO/HaRP limitation that affects **all** ExApps, not just Bee Flow:

| Hop | Trusts a self-signed cert? |
|---|---|
| Bee Flow connector → Nextcloud | ✅ **Automatic** — the connector detects an untrusted Nextcloud cert and trusts it for the Nextcloud origin only (the Bee Flow server channel stays verified). |
| **HaRP → Nextcloud** | ❌ HaRP resolves every ExApp by calling back into Nextcloud over HTTPS; on a self-signed cert it errors `SSLCertVerificationError`. |
| **Nextcloud PHP → its own URL** | ❌ AppAPI's proxy makes Nextcloud call its own public URL; PHP's cURL rejects the self-signed cert (`error 60`). |

On a **production / real AIO with a valid (publicly-trusted) certificate, none of this applies** — every component trusts it and the released connector just works.

### Fix it with one command

The connector repo ships a helper that makes the AIO HaRP **and** Nextcloud containers trust your local CA:

```bash
# from a connector checkout (or the monorepo's nextcloud-connector/)
./scripts/aio-trust-local-cert.sh
```

It auto-detects the CA (mkcert, or a Caddy `tls internal` root), adds it to the Nextcloud container's trust store, rebuilds the read-only HaRP container with `SSL_CERT_FILE` pointed at a CA bundle in its `/certs` volume, and verifies the browser-proxy returns `200`. Pass `--ca <root-ca.pem>` if your CA can't be auto-detected, and `--harp` / `--nc` / `--caddy` to override container names.

After it prints `✅ Browser-proxy returns 200`, hard-refresh Nextcloud (`Ctrl+Shift+R`) and the embedded Bee Flow app loads.

:::note[Caveats]
The script recreates the `nextcloud-aio-harp` container — it's recoverable (restart the containers from the AIO interface and AIO rebuilds HaRP fresh). An AIO/Nextcloud update recreates these containers from stock config and drops the change, so **re-run the script** if the app goes blank again. For a fully production-like local env, use a real domain with a valid certificate (e.g. Caddy ACME DNS-01) instead — then no script is needed.

**Caddy `tls internal` issues short-lived (~12 h) leaf certificates.** When the leaf expires, NC↔HaRP TLS breaks and the app goes blank — but you do **not** need to re-run this script (it trusts the long-lived root CA, which still signs the new leaf). Just renew the leaf with `docker restart aio-caddy`.
:::

---

## Where to next

- [Connector → Architecture](../connector/architecture.md) — what's actually happening during `/init` + bootstrap.
- [Connector → Troubleshooting](../connector/troubleshooting.md) — broader error matrix.
- [Self-hosting → Docker Compose](../self-hosting/docker-compose.md) — run the Bee Flow server too, instead of pointing at the SaaS.
