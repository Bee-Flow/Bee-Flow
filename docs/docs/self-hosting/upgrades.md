---
title: Upgrades
---

# Upgrades

How to move a self-hosted Bee Flow install to a newer release, verify that the upgrade actually
landed, and get back out if you have to.

This page is written for the [Docker Compose install](docker-compose.md). If you use the hosted
SaaS at [beeflow.nl](https://beeflow.nl), upgrades are done for you and nothing here applies.

## How releases are versioned

A release covers the **whole stack**: it is the unit you upgrade to, and `latest`/`prod` always
point at it. Images are built per service, so a service that did not change in a release keeps its
existing build — the version names the release an image ships in, not a rebuild of every image.
Releases are listed on the
[GitHub Releases page](https://github.com/Bee-Flow/Bee-Flow/releases) (tags like
`prod-2026.08.19-918` — the release date plus a build number). There are **no semver image tags**.

| Registry | Tags per release |
|----------|------------------|
| `ghcr.io/bee-flow` (canonical) | `latest` and `prod` (always the current release) + an immutable `sha-<full commit>` on each image the release built |
| `docker.io/beeflowapp` ([mirror](docker-hub.md)) | `latest` (moves) + an immutable `2026.08.19-918`-style version tag |

`dev` and `dev-sha-<commit>` tags also exist on GHCR — those are continuous development builds
from every merge, not releases. Don't run them in production.

Two rules follow from how releases are cut:

- **Upgrade the whole stack at once.** The server and the web UI are released together and the API
  contract between them is not guaranteed across versions. The compose file uses a single `TAG`
  variable for both on purpose — a partial upgrade (only the server, or only the frontend) is not
  supported.
- **Pin your version.** With `TAG=latest`, a routine `docker compose pull` can move you to a new
  release at a moment you did not choose — and afterwards "the previous version" is not something
  you can name. Set `TAG` to an immutable tag and upgrade deliberately.

## Before you upgrade

1. **Read the release notes** for the release you are moving to — and for every release you are
   skipping over. Manual steps (rare) are listed there with their exact commands; they do not run
   themselves.
2. **Note what you are running now**, so rollback is a known destination rather than a guess:
   the `TAG` value in your `.env`, or — if you run `latest` — the digest:

   ```bash
   docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/bee-flow/server:latest
   ```

3. **Back up the databases.** The stack uses
   [three Postgres databases](docker-compose.md#three-databases-not-one), and `beeflow_core` alone
   is not a full backup:

   ```bash
   for db in beeflow_core beeflow_tasks monitoring_db; do
     docker exec -t beeflow-postgres pg_dump -U beeflow -d "$db" -Fc \
       > "backup-${db}-$(date +%F).dump"
   done
   ```

   Uploaded documents and meeting recordings live in object storage (the `rustfs-data` volume),
   not in Postgres — include that volume if you want a complete point-in-time copy.

## Upgrade a Docker Compose install

**1. Pick the version** and set it in `.env`:

```bash
# .env — GHCR (canonical):
TAG=sha-<full commit from the release notes>
# or, pulling from Docker Hub:
# REGISTRY=docker.io/beeflowapp
# TAG=2026.09.02-931
```

:::caution `sha-` tags exist per built image

Builds are per service: an image that did not change in a release is not rebuilt, and then has no
`sha-` tag at that release's commit — a pinned pull for it fails with *manifest unknown*. A normal
release builds the server and web UI together, so the pin above works for the `core` profile.
Running more profiles? Pin the [Docker Hub version tag](docker-hub.md#tags) if everything you run
is published there (`server`, `agent-hub`, `guard`); otherwise stay on `prod` and record the
digests you are running ([Before you upgrade](#before-you-upgrade), step 2) so rollback remains a
known destination.

:::

**2. Pull and recreate the whole stack**, with every profile you run:

```bash
docker compose -f docker-compose.from-registry.yml --profile core pull
docker compose -f docker-compose.from-registry.yml --profile core up -d
```

:::caution Upgrading from a build older than the non-root server image

The server used to run as root and now runs as the `node` user, so a `beeflow-data` volume created
by the older image is owned by root and the new container cannot write to it. The same goes for
whatever the old image wrote into the `components/` folder next to the compose file. Hand both over
once, before the `up`:

```bash
docker compose -f docker-compose.from-registry.yml run --rm --user root server \
    chown -R node:node /app/data /components
```

On a fresh install the data volume inherits the right owner from the image. The `components/`
folder is a bind mount, so it must be writable by uid 1000 (the `node` user). It is not when
Docker created it (a first `docker compose up` without `./selfhost.sh`), when `./selfhost.sh` ran
with `sudo` or as another user, or under rootless Docker. Run the same command then; until you do,
the Component Designer cannot save.

:::

Add each extra profile you use (`--profile guard`, `--profile search`, …) to **both** commands.
If you installed with `./selfhost.sh`, re-running it does the same pull + up for your `PROFILES`
and leaves your `.env` untouched:

```bash
PROFILES="core guard" ./selfhost.sh
```

**3. Migrations run at server start.** The server brings its schema up to date every time it
starts. Each step is recorded in a `schema_migrations` table once it succeeds, so a later start
skips it; the steps are idempotent anyway, and a step whose file changed runs again. The first
start after upgrading to a build that has the ledger runs the whole ladder once more and records
it. You don't have to do anything for a normal upgrade, but you should verify (next section)
rather than assume.

## Verify the upgrade

Two unauthenticated endpoints tell you, in one call each, which build you are running and whether
the schema is in place:

```bash
curl -s http://127.0.0.1:3001/api/health          # {"status":"ok", ..., "appVersion":"<commit sha>"}
curl -s http://127.0.0.1:3001/api/health/schema   # {"ok":true,"schemaReady":true,"build":"<commit sha>"}
```

- `appVersion` / `build` is the commit the running server image was built from — compare it with
  the commit named in the release notes. (Empty means the image predates the build stamp; after an
  upgrade to a current release it should never be empty.)
- `ok` says the database answered; `schemaReady` says the core tables exist, i.e. the migration
  ladder has run. The result is cached for ~30 seconds, so give it a moment after start-up.

If `schemaReady` is `false`, or you want positive proof rather than a probe, run the migration
runner explicitly:

```bash
docker exec beeflow-server node migrateDb.js
```

This runs the **same** ladder the server runs at start, but awaited and loud: it prints a line per
component, exits `0` when everything applied, and exits `1` with the names of the failures
otherwise. It is safe to run any number of times. On a very large database, raise the watchdog
(default 10 minutes):

```bash
docker exec -e MIGRATE_TIMEOUT_MS=1200000 beeflow-server node migrateDb.js
```

A failure here is almost always environmental — Postgres permissions, connectivity, or disk. Fix
the cause and run it again; because the ladder is idempotent, a re-run picks up exactly where
things stand.

Finally: if the release notes listed manual steps (typically
`docker exec beeflow-server node migrations/<name>.js`), run them now. They are manual on purpose
— the notes say what each one does and when it is safe.

## Skipping versions

Skipping releases is supported at the schema level: since the whole ladder replays on every start,
upgrading from an older release simply runs everything that install has not seen yet. Two things
still apply:

- Read the release notes of **every** release you skip — a manual step from a skipped release
  still has to be run.
- Take the [backup](#before-you-upgrade) first, as always.

## Rollback

There is no automatic downgrade. The way back is the previous image version plus, if needed, the
backup you took:

1. Set `TAG` back to the previous immutable tag (the `sha-<commit>` from the previous release
   notes, or the previous version tag on Docker Hub) and run the same `pull` + `up -d` as above.
2. Schema changes are additive, so the database usually needs no action — an older server ignores
   tables and columns it does not know. Rows written by the newer version (and its config values)
   stay behind; that is expected.
3. If the release notes for the version you are leaving say otherwise, or the database itself is
   the problem, restore the dumps you took before the upgrade:

   ```bash
   cat backup-beeflow_core-YYYY-MM-DD.dump | docker exec -i beeflow-postgres \
     pg_restore -U beeflow -d beeflow_core --clean --if-exists
   ```

   Restore all three databases from the same backup run, not a mix.

:::danger Never "reset" with `--uninstall` or `down --volumes`

`./selfhost.sh --uninstall` and `docker compose down --volumes` delete the **data volumes** —
the Postgres data and every uploaded file in object storage. Neither is a rollback tool. To
restart the stack, the same `up -d` with your profiles as above (or re-running `./selfhost.sh`
with your `PROFILES`) is always enough.

:::

## The Nextcloud connector

The connector (the `bee_flow` ExApp) is versioned and updated separately, through Nextcloud:
**Apps → Updates** in the Nextcloud admin area, or `occ app_api:app:update bee_flow` from the CLI.
It is built to keep working against current servers — keep both sides reasonably up to date rather
than trying to match exact versions.

## The Android app

The Android app has **no auto-update** and no store channel — you install a newer APK from the
[GitHub Releases page](https://github.com/Bee-Flow/Bee-Flow/releases) yourself. An older APK
keeps working against an upgraded server; it just lacks the newest screens. See
[Android app](../getting-started/android.md).
