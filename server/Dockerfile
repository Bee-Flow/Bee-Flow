# Bee Flow Server — four stages.
#   deps     toolchain + `npm ci --omit=dev` (isolated-vm compiles from source here)
#   dev      deps + devDependencies, root, nodemon — the target docker-compose.dev.yml builds
#   geo      the DB-IP Lite City + ASN databases (IP location of outbound calls)
#   runtime  slim, no toolchain, docker CLI, runs as `node` (uid 1000) — the published image
#
# No Chromium is baked in: browser work runs in a container the server launches
# over the mounted docker socket (services/pwtRunner.js, services/browserProvider.js)
# or against BROWSER_WS_ENDPOINT, so `playwright` stays a thin client.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS deps

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./

# `npm ci` never rewrites the lockfile, so this layer is only rebuilt when
# package*.json changes; a lockfile out of sync with package.json fails loudly.
# Flaky-link tolerance: npm's defaults (2 retries, 60s max back-off) give up on one
# stalled socket (`read ETIMEDOUT`) halfway through a fresh install. Scoped to this
# RUN so the settings never reach the runtime image.
RUN --mount=type=cache,target=/root/.npm \
    NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000 \
    npm ci --omit=dev --no-audit --no-fund

# ── dev ──────────────────────────────────────────────────────────────────────
# Root on purpose: the source and node_modules are bind-mounted from the host,
# and the fallback `npm ci` in docker-compose.dev.yml needs the toolchain above.
FROM deps AS dev

RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=development
ENV PORT=3001
EXPOSE 3001

CMD ["node_modules/.bin/nodemon", "--ignore", "data/", "--ignore", "components/", "--ignore", "node_modules/", "index.js"]

# ── geo ──────────────────────────────────────────────────────────────────────
# The server locates every recorded outbound call on the box itself
# (core/http/geo/geoDb.js) against DB-IP Lite: CC BY 4.0, attribution
# "IP Geolocation by DB-IP" (https://db-ip.com), see NOTICE.md. A new edition
# appears monthly at a fixed URL. GEO_DB_MONTH (YYYY-MM, passed by CI and
# scripts/build-images.*) is the cache key: the same month reuses this layer,
# a new month downloads again. Empty = the build date's month.
# This month first, then the previous one (a new edition can lag the 1st).
# Checked before use: gunzip -t (CRC), a minimum size, and the MaxMind
# metadata marker with its database_type. A failed download FAILS THE BUILD,
# because an image without it records every call as "unknown location";
# GEO_DB_OPTIONAL=1 builds without it for a hotfix when download.db-ip.com is down.
FROM node:22-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS geo

ARG GEO_DB_MONTH=""
ARG GEO_DB_OPTIONAL=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /geo

RUN set -eu; \
    month="${GEO_DB_MONTH:-$(date -u +%Y-%m)}"; \
    prev="$(date -u -d "${month}-01 -1 month" +%Y-%m)"; \
    fetch() { \
        kind="$1"; min="$2"; \
        for m in "$month" "$prev"; do \
            out="dbip-${kind}-lite-${m}.mmdb"; \
            if curl -fsSL --retry 3 --retry-delay 5 -o "/tmp/${kind}.gz" "https://download.db-ip.com/free/${out}.gz" \
               && gunzip -t "/tmp/${kind}.gz" \
               && gunzip -c "/tmp/${kind}.gz" > "$out" \
               && [ "$(stat -c %s "$out")" -ge "$min" ] \
               && node -e 'const b=require("fs").readFileSync(process.argv[1]);const i=b.lastIndexOf(Buffer.from("abcdef4d61784d696e642e636f6d","hex"));if(i<0||b.indexOf("database_type",i)<0)process.exit(1)' "$out"; then \
                rm -f "/tmp/${kind}.gz"; echo "geo: ${out}"; return 0; \
            fi; \
            rm -f "/tmp/${kind}.gz" "$out"; \
        done; \
        return 1; \
    }; \
    ok=1; \
    fetch city 20000000 || ok=0; \
    fetch asn 1000000 || ok=0; \
    if [ "$ok" != 1 ]; then \
        if [ "$GEO_DB_OPTIONAL" = 1 ]; then \
            echo "WARNING: DB-IP Lite not available for ${month} or ${prev}; building WITHOUT the IP location database (GEO_DB_OPTIONAL=1)."; \
            rm -f ./*.mmdb; \
        else \
            echo "ERROR: could not download DB-IP Lite for ${month} or ${prev}. Retry, or build with --build-arg GEO_DB_OPTIONAL=1 for an image without it."; \
            exit 1; \
        fi; \
    fi; \
    ls -l /geo

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime

# The gid that owns /var/run/docker.sock on the host. The server runs as `node`
# and still shells out to `docker build` / `docker run` (services/pwtRunner.js,
# services/guardInstaller.js, integrations/mcpRegistryClient.js), so it must be
# in the socket's group. 999 is the usual gid on Debian/Ubuntu hosts; pass
# --build-arg DOCKER_GID=$(stat -c %g /var/run/docker.sock) when it differs, or
# add the gid at run time with compose `group_add` instead of rebuilding.
ARG DOCKER_GID=999

WORKDIR /app

# wget serves the HEALTHCHECK; docker-buildx-plugin because pwtRunner builds
# with DOCKER_BUILDKIT=1, which the CLI refuses without the plugin.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg wget \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN if ! getent group "$DOCKER_GID" >/dev/null; then groupadd -g "$DOCKER_GID" docker; fi \
    && usermod -aG "$(getent group "$DOCKER_GID" | cut -d: -f1)" node

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# The code and node_modules belong to root and are read-only for `node`: a
# process that can rewrite its own source turns one file-write bug into code
# that runs on every restart. --chmod rather than the builder's own modes: a
# local checkout can hold untracked files only their owner may read (a 0600
# key file, for one), and owned by root those would be unreadable to `node`.
COPY --from=deps --chmod=a+rX,go-w /app/node_modules ./node_modules

# The IP location databases, read-only. /app/geo and NOT /app/data: that is the
# volume mount point, and a mounted volume would hide anything baked in there.
# The opt-in monthly refresh (GEO_DB_AUTO_UPDATE=monthly) writes a newer
# edition to /app/data/geo instead; core/http/geo/geoDb.js takes the newest.
# Before the app COPY, so a code change never re-copies ~140 MB.
COPY --from=geo --chmod=a+rX,go-w /geo /app/geo

# vendor/app-runtime/ and sbom/ are gitignored and OPTIONAL: CI stages them into
# the context before the build, a plain local build has neither, and a COPY that
# names an absent folder fails — so they only ever arrive through this COPY.
COPY --chmod=a+rX,go-w . .

# What `node` may write, and nothing else. Every write the server does at run
# time lands in one of these (checked 2026-09-23 against every mkdir, write,
# rename, multer destination and cache directory under server/):
#   /app/data    uploads, generated media, saved recordings, icons, wallpapers,
#                module packages, the local storage fallback, the Transformers.js
#                model cache. The volume mount point; a fresh named volume
#                inherits this owner.
#   /components  the Component Designer's components and their npm installs
#                (core/cms/componentManager.js). Bind-mounted by
#                docker-compose.yml, -from-registry and -install; in Kubernetes,
#                Portainer and the dockerhub compose file it is this directory.
#   /tmp, $HOME  scratch files, and the docker and npm caches (/home/node).
# Two of them hold code the server runs. /components on purpose: writing
# component code is what the designer is for, behind the component_designer
# capability. /app/data/modules holds signed packages that every boot
# re-verifies and extracts afresh (modules/packageLoader.js), so an edit there
# does not survive a restart.
# /app/sbom exists in every image (empty when nothing was staged) so
# compliance/lib/sbomLocator.js probes one stable path; it is only ever read.
RUN mkdir -p /app/sbom /app/data /components && chown node:node /app/data /components

ENV NODE_ENV=production
ENV PORT=3001

# CI passes ${{ github.sha }}; a plain `docker build` leaves it empty and the
# server falls back to 'dev' (core/buildInfo.js).
ARG APP_BUILD_SHA=""
ENV APP_BUILD_SHA=$APP_BUILD_SHA

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:3001/api/health || exit 1

USER node

CMD ["node", "index.js"]
