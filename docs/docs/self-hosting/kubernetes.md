---
title: Kubernetes
---

# Kubernetes

:::warning[No published manifests, no Helm chart]

**Docker Compose is the supported self-host path.** Bee Flow's own cloud runs on Kubernetes, but
those manifests are tied to that environment and are not published, and there is no Helm chart
today. This page describes the *pattern* for running the same public images on your own cluster —
it is a map for someone who already operates Kubernetes, not a paste-ready deployment.

The authoritative contract for what each container needs — environment variables, ports, service
dependencies, health checks — is
[`docker-compose.from-registry.yml`](docker-compose.md#easy-install). Where anything on this page
and that file disagree, the compose file wins.

:::

## What you run

The images are the same public ones the compose install pulls — per service, from
`ghcr.io/bee-flow` (or the [Docker Hub mirror](docker-hub.md)). There is no all-in-one image.

| Workload | Image | Listens on | Notes |
|----------|-------|-----------|-------|
| Server (Deployment) | `ghcr.io/bee-flow/server` | `3001` | Core API. Durable state lives in Postgres + object storage, not in the pod. |
| Web UI (Deployment) | `ghcr.io/bee-flow/agent-hub` | `80` | nginx: serves the SPA **and** proxies `/api`, `/auth`, `/agents`, `/ai` to the server. |
| PostgreSQL + pgvector | `pgvector/pgvector:pg15` | `5432` | StatefulSet, or a managed Postgres with the `pgvector` extension. |
| Object storage | `rustfs/rustfs` (or any S3) | `9000` | Required — documents and meeting recordings live here. |
| Guard (optional) | `ghcr.io/bee-flow/guard` | `8100` | Privacy Shield PII detection. CPU, ~1.2 GB model at start-up. |
| Classify (optional) | `ghcr.io/bee-flow/classify` | `8300` | Zero-shot topic classifier for the Condition node. CPU only. |

Run the **server and web UI on the same image tag**, and upgrade them together — see
[Upgrades](upgrades.md) for how versions and immutable tags work. (There is no image called
`beeflow`; the per-service images above are what CI builds.)

## Configuration

The server is configured entirely through environment variables. Mirror the `server:` service in
`docker-compose.from-registry.yml`; the load-bearing ones are:

- **`CORE_DATABASE_URL`**, **`DATABASE_URL`**, **`MONITORING_DATABASE_URL`** — three connection
  URLs for the [three databases](docker-compose.md#three-databases-not-one) (`beeflow_core`,
  `beeflow_tasks`, `monitoring_db`). Create all three and enable the `pgvector` extension on
  `beeflow_core` and `beeflow_tasks` — the compose install does this with
  [`docker/init-db.sh`](docker-compose.md#three-databases-not-one); on Kubernetes an init Job is
  the natural place.
- **`SESSION_SECRET`**, **`MASTER_ENCRYPTION_KEY`** — required secrets (fresh random values).
- **`RUSTFS_ENDPOINT`**, **`RUSTFS_ACCESS_KEY`**, **`RUSTFS_SECRET_KEY`** — object storage.
- `SERVICES_API_KEY` — shared secret between the server and the sidecars. Required: the guard and classify pods refuse to start without it.
- `PII_SERVICE_URL` (+ `PII_SERVICE_API_KEY`) — points the server at the guard, if you deploy it.
- `PORT` — the server's listen port (`3001` in the compose setup).
- **`STUDIO_APP_ENGINE`** — set it to `pg` before you run more than one server replica; the
  default (`sqlite`) supports one. See [the warning below](#server-replicas).

The full variable reference is [Environment variables](env.md). Do not carry over folklore from
generic Node deployments: the server reads no `JWT_SECRET`, `DB_HOST` or `DB_NAME` — database
access is the three URLs above.

A server Deployment skeleton, to show the shape (not a complete install — the env list is
abbreviated on purpose):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: beeflow-server
spec:
  replicas: 1   # raise only with STUDIO_APP_ENGINE=pg, see "More than one server replica" below
  selector:
    matchLabels: { app: beeflow-server }
  template:
    metadata:
      labels: { app: beeflow-server }
    spec:
      terminationGracePeriodSeconds: 60   # the graceful shutdown takes up to ~40 s
      containers:
        - name: server
          image: ghcr.io/bee-flow/server:sha-<commit from the release notes>
          ports: [{ containerPort: 3001 }]
          envFrom:
            - configMapRef: { name: beeflow-config }   # non-secret vars
            - secretRef: { name: beeflow-secrets }     # SESSION_SECRET, MASTER_ENCRYPTION_KEY, …
          readinessProbe:
            httpGet: { path: /api/ready, port: 3001 }    # 503 until the pod can serve
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health, port: 3001 }   # 200 while the process runs
            initialDelaySeconds: 30
            periodSeconds: 30
```

The two probes ask different questions, so point them at different paths:

- **`/api/health`** is liveness: `200` for as long as the process runs. It does not touch the
  database, so a database outage never makes Kubernetes restart healthy pods.
- **`/api/ready`** is readiness: `200 {"ready":true}` when the pod can serve, otherwise `503`
  with a `reason`: `starting` (the schema and the boot migrations are still running; after
  `BOOT_READY_TIMEOUT_MS`, 5 minutes by default, a step that is still running no longer holds
  the pod back), `database` (unreachable), `schema` (the core tables are missing) or
  `shutting_down`. A rolling update therefore only sends traffic to a new pod once its
  migrations have run, and stops sending it to a pod that received `SIGTERM`.

On `SIGTERM` the server stops accepting connections, lets running automations finish (25 s at
most, `AUTOMATION_DRAIN_TIMEOUT_MS`), flushes what it still holds in memory and exits `0`. That
takes up to about 40 seconds, which is more than the Kubernetes default of 30: keep
`terminationGracePeriodSeconds` at 60, and keep the image's own command (`node index.js`), so
the signal reaches the server instead of a wrapper.

### More than one server replica {#server-replicas}

:::warning[Two replicas need `STUDIO_APP_ENGINE=pg`]

The default App Studio engine (`STUDIO_APP_ENGINE=sqlite`) keeps the records of each app in one
SQLite file in object storage, written by a single server process. With two replicas, two pods
end up writing the same app: the pod that saves second has its save refused, loses the changes
it had not saved yet (up to a few seconds of work) and refuses every further write to that app.
Run more than one replica only on the Postgres engine, which keeps each app in its own schema in
`beeflow_core`:

- **New install:** put `STUDIO_APP_ENGINE: "pg"` in the `beeflow-config` ConfigMap before anyone
  makes an app.
- **Apps already exist:** with one replica running, move them (the first command is a rehearsal
  that changes nothing), then set the variable, let the Deployment roll and scale out:

  ```bash
  kubectl exec deploy/beeflow-server -- node scripts/migrateStudioAppsToPg.js --all --dry-run
  kubectl exec deploy/beeflow-server -- node scripts/migrateStudioAppsToPg.js --all
  ```

  The script moves each app into its own schema, checks the row counts before it commits and
  leaves the old file in object storage as a backup. A moved app is not served by a pod that
  still runs the default engine, so do the move and the roll in one maintenance window.

Until then keep `replicas: 1`. A server that starts in a cluster on the default engine logs a
warning about this; with one replica that line can be ignored.

The database a page of the Webpages feature can have is the same kind of single-writer file
and has no Postgres engine: with several replicas, a page database that two pods write is
refused on the second pod in the same way.

:::

Sessions are stored in Postgres, so multiple server replicas work without sticky sessions or
Redis. The guard needs a generous readiness window (it loads its model before `/ready` goes
green) — and note it [fails closed](env.md#service-to-service-sidecars): chat is blocked while no guard replica
is ready, so run two guard replicas if a restart must not interrupt service.

### Token-signing secrets: leave these to the server

Public share links, public forms, public Studio app pages and Learning Center certificates are
signed with HMAC secrets that do **not** belong in your Secret. On first boot the server
writes one random value per feature into its `config` table with an `ON CONFLICT DO NOTHING`
insert, so with `replicas: 2` the first pod to boot wins and every other pod reads the same row
back. Nothing to generate, nothing to distribute.

:::danger[Do not set `PUBLIC_SHARE_TOKEN_SECRET`]

It is tempting to pin these as env vars, and an env var does win over the bootstrapped value —
but `PUBLIC_SHARE_TOKEN_SECRET` is read by the Learning Center certificate signer as well as the
public-share signer. Setting it re-derives every certificate serial, so every `/verify/<token>`
link you have already handed out returns 404, permanently. Let the server bootstrap them.

:::

Because the secrets live in the database, they survive pod restarts and rescheduling, but not a
restore into an empty `config` table. After such a restore, tokens that were in flight — magic
links, unlock cookies, a public form somebody had open — stop verifying and have to be
re-requested. Public share links themselves are unaffected: those are database rows, not signed
tokens.

If a public form reports **"This form expired"** on the first submit and then works on retry, the
bootstrap is not running: check the startup logs for a `[PublicShareToken]` warning, which means
the pods are each signing with their own per-process key.

## Ingress

The simplest correct routing mirrors the compose topology: send **everything** to the `agent-hub`
Service. Its nginx serves the SPA and proxies the API paths to the server internally, so you need
no per-path rules. If you route API paths straight to the server instead, two settings are
mandatory for chat streaming (SSE):

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"   # required for SSE
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
```

## Upgrades on Kubernetes

The [upgrade model](upgrades.md) is the same as on compose — whole stack, one version, immutable
tags:

1. Set the server **and** agent-hub Deployments to the new release's `sha-<commit>` tag and let
   them roll. The server updates its own schema at start; the ladder is idempotent, so old and
   new replicas can coexist during the rollout.
2. Verify with the same two endpoints:
   `GET /api/health` (check `appVersion`) and `GET /api/health/schema` (expect
   `{"ok":true,"schemaReady":true}`).
3. For positive proof — or if `schemaReady` stays `false` — run the migration runner to
   completion in one pod and check its exit code:

   ```bash
   kubectl exec deploy/beeflow-server -- node migrateDb.js
   ```

   It exits `0` when everything applied and `1` with the names of the failures otherwise, and is
   safe to run repeatedly.

## If you build this out

The gaps you will need to fill yourself: storage classes and PVCs (Postgres, object storage),
network policies, an init Job for the three databases, resource limits (the guard is the
memory-hungry sidecar), and TLS. None of that is Bee Flow-specific.

If you get a clean, reusable setup working and want it cross-linked here, open an issue at
[Bee-Flow/Bee-Flow](https://github.com/Bee-Flow/Bee-Flow/issues).
