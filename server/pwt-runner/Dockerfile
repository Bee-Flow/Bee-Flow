# Throwaway Playwright runner image.
#
# Each Studio test run executes inside a short-lived container built from this
# image. The base ships Chromium + all OS deps baked in and matches the server's
# pinned Playwright version (1.64.0), so we never download browsers at runtime.
# The same image also backs the long-lived shared `bf-browser` singleton that
# the server drives for PDF export, thumbnails, and SPA ingestion.
#
# Two sub-commands (see entrypoint.js):
#   suite  — run the bind-mounted spec via `playwright test`, write report.json
#   serve  — launch a Chromium server and print its wsEndpoint for the worker
#            to drive over the wire (explore / agent modes)

# The Playwright base ships Node 24.21.0, which has the bundled-Brotli
# out-of-bounds write (CVE-2026-111497, fixed in 24.22.1). Same major, so only
# the binary is swapped below. Drop this stage once a Playwright base ships
# 24.22.1 or later, and keep the version assert in
# scripts/check-release-container.sh in step.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node

# IMPORTANT: this version MUST match the `playwright` version the server
# installs (server/package.json). Playwright's connect() handshake rejects a
# client/server minor-version mismatch (HTTP 428). Bump both together.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

COPY --from=node /usr/local/bin/node /usr/bin/node

WORKDIR /runner

# openssl only, not a full upgrade: the base's other OS packages are the ones
# Playwright tested its browsers against. Ubuntu shipped the fixes for
# CVE-2026-45447 and CVE-2026-84782 after the pinned base digest, and the
# release container gate fails on a fixable HIGH/CRITICAL finding.
#
# gstreamer1.0-plugins-bad goes: only WebKit loads the system GStreamer, and
# both modes start Chromium alone (entrypoint.js), which decodes media with its
# own bundled stack. Ubuntu fixes its H.265 parser (CVE-2025-3887) only in ESM.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade openssl libssl3t64 \
    && apt-get purge -y gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Browsers are already baked into the base image — never re-download them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Generated specs `import { test } from '@playwright/test'` while running with
# cwd=/runner; NODE_PATH lets that resolve from /runner/node_modules even though
# the spec file lives under the bind-mounted /work.
ENV NODE_PATH=/runner/node_modules

COPY package*.json ./

# `npm ci` never rewrites the lockfile, so this layer is only rebuilt when
# package*.json changes; a lockfile out of sync with package.json fails loudly.
# Same flaky-link tolerance as server/Dockerfile: npm's defaults give up on one
# stalled socket halfway through a fresh install.
#
# npm itself leaves in the same layer: it is only needed for this install, and
# the copy the base bundles (tar, minimatch, brace-expansion, sigstore, …) is
# what the release container gate failed on. Nothing at runtime uses it:
# entrypoint.js starts the Playwright CLI with node directly, and
# scripts/check-release-container.sh asserts npm/npx are gone.
RUN --mount=type=cache,target=/root/.npm \
    NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000 \
    npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx

COPY entrypoint.js ./

ENTRYPOINT ["node", "/runner/entrypoint.js"]
