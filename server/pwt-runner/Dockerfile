# Throwaway Playwright runner image.
#
# Each Studio test run executes inside a short-lived container built from this
# image. The base ships Chromium + all OS deps baked in and matches the server's
# pinned Playwright version (1.59.1), so we never download browsers at runtime.
# The same image also backs the long-lived shared `bf-browser` singleton that
# the server drives for PDF export, thumbnails, and SPA ingestion.
#
# Two sub-commands (see entrypoint.js):
#   suite  — run the bind-mounted spec via `playwright test`, write report.json
#   serve  — launch a Chromium server and print its wsEndpoint for the worker
#            to drive over the wire (explore / agent modes)
#
# IMPORTANT: this version MUST match the `playwright` version the server
# installs (server/package.json). Playwright's connect() handshake rejects a
# client/server minor-version mismatch (HTTP 428). Bump both together.
FROM mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3cb99aa7803adbc14d9027ec1785fc6e433b97e134e0f8fe61683b6b53

WORKDIR /runner

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
RUN --mount=type=cache,target=/root/.npm \
    NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=600000 \
    npm ci --omit=dev --no-audit --no-fund

COPY entrypoint.js ./

ENTRYPOINT ["node", "/runner/entrypoint.js"]
