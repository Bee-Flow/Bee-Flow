---
title: Docker Hub
---

# Docker Hub

Bee Flow images are published to **[Docker Hub](https://hub.docker.com/u/beeflowapp)** under the
`beeflowapp` namespace, as a mirror of the canonical registry `ghcr.io/bee-flow`.

Both registries serve the **same images** — identical digests, copied rather than rebuilt. Use
whichever you prefer; you can [verify they match](#verify-what-you-pulled) yourself.

This page covers only what differs when pulling from Docker Hub. For the install itself, see
[Docker Compose](./docker-compose.md); for configuration, [Environment variables](./env.md).

## What is published

| Image | Component | Listens on |
|-------|-----------|------------|
| `beeflowapp/server` | Core API — agents, automations, RAG, auth | `3001` |
| `beeflowapp/agent-hub` | Web interface (nginx + React) | `80`, published as `5176` |
| `beeflowapp/guard` | Privacy Shield — PII detection and redaction | `8100` |

The optional sidecars (`search-api`, `pii`, `whisperx`, `reranker`) are **not** on Docker Hub.
Pull those from `ghcr.io/bee-flow` — it is public and needs no login.

:::note
The license server (`license-server`) is private: its source is not in the public repository and
its image is not published to any public registry. It mints and signs licence tokens and is not
part of a self-host install.
:::

## Using it

The install is the standard one; you only change which registry the Compose file resolves images
from, with `REGISTRY`:

```bash
REGISTRY=docker.io/beeflowapp TAG=latest \
  docker compose -f docker-compose.from-registry.yml --profile core up -d
```

To make it stick, put both in your `.env` instead of typing them each time:

```bash
REGISTRY=docker.io/beeflowapp
TAG=2026.08.19-918
```

Everything else — secrets, first-run admin password, profiles — works exactly as described in
[Docker Compose](./docker-compose.md).

Because `guard` lives in its own profile, add it explicitly:

```bash
docker compose -f docker-compose.from-registry.yml --profile core --profile guard up -d
```

## Tags

| Tag | Meaning |
|-----|---------|
| `latest` | The current production release. Moves with every release. |
| `2026.08.19-918` | One specific release — the release date and its build number. |

**Pin a version in production.** `latest` is convenient for a first look, but it means a
`docker compose pull` can move you to a new release at a moment you did not choose. Set `TAG` to
a version and upgrade deliberately:

```bash
# .env
TAG=2026.08.19-918
```

Server and web interface must be on the **same version** — they are released together and the API
contract between them is not guaranteed across versions. Changing one `TAG` changes both, which
is why they share the variable.

## Upgrading

Pick the new version, then pull and recreate:

```bash
# .env → TAG=2026.09.02-931
docker compose -f docker-compose.from-registry.yml --profile core pull
docker compose -f docker-compose.from-registry.yml --profile core up -d
```

Database migrations run automatically at server start. Back up your databases first — see
[Upgrades](./upgrades.md) for backups, verification and rollback.

## Platform support

Images are published for **`linux/amd64`** only. On Apple Silicon or an ARM server, a pull
succeeds but the container fails to start with an exec-format error. Docker Desktop can emulate
amd64, which is fine for a look around and too slow for real use.

## Pull rate limits

Docker Hub limits anonymous pulls per IP over a rolling window. On a shared or NAT'd network you
can hit that limit mid-install, which shows up as a `toomanyrequests` error partway through
pulling.

Two ways around it:

```bash
docker login          # authenticated pulls get a higher allowance
```

or use the canonical registry instead, which does not rate-limit public pulls:

```bash
REGISTRY=ghcr.io/bee-flow TAG=latest \
  docker compose -f docker-compose.from-registry.yml --profile core up -d
```

## Verify what you pulled {#verify-what-you-pulled}

The Docker Hub images are copies of the GHCR ones, so the digests are identical. You do not have
to take that on faith:

```bash
docker buildx imagetools inspect docker.io/beeflowapp/server:latest --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/bee-flow/server:prod      --format '{{.Manifest.Digest}}'
```

The two `sha256:` values match. If they ever do not, trust the GHCR one — that is the registry
images are built to — and please report it.

Each image also carries the commit it was built from:

```bash
docker buildx imagetools inspect docker.io/beeflowapp/server:latest --format '{{json .Image}}' \
  | grep revision
```

:::tip
A service that did not change in a given release keeps its older commit, because builds are
per-service. The version tag names the **release** an image ships in, not the commit it was
built from.
:::
