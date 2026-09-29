# Repository structure & license model

Bee Flow AI is a single **polyglot monorepo**
([`Bee-Flow/Bee-Flow`](https://github.com/Bee-Flow/Bee-Flow)) containing
every deployable service, plus its docs and test suites. This file maps the
top-level directories and explains how paid features are gated by license keys.

> The license server that issues licence keys, and Bee Flow's own deployment
> tooling, live in private repositories and are not part of this one.

## Directory map

| Directory | Stack | What it is |
|---|---|---|
| `server/` | Node 22 / Express 5 | Core API: agents, automations, RAG, auth, licensing. The largest module — see [`server/ARCHITECTURE.md`](server/ARCHITECTURE.md). |
| `agent-hub/` | React 19 / Vite 7 / Tailwind 4 | Frontend SPA ("Agent Hub"). |
| `desktop/` | Electron 44 / TypeScript | Desktop client for Linux, macOS and Windows. The opposite choice from `mobile/`: it loads `agent-hub/` from the user's own server rather than bundling a copy, so the UI can never drift from the API. What it adds is what a browser tab cannot do — tray, global shortcut, native notifications, `beeflow://` deep links, and a bridge to the Nextcloud desktop client. See [`desktop/README.md`](desktop/README.md). |
| `mobile/` | Expo SDK 57 / React Native 0.86 | Native Android client, shipped as an APK. Not a wrapper around `agent-hub/` — it renders native views and has its own phone-shaped information architecture. See [`mobile/README.md`](mobile/README.md). |
| `nextcloud-connector/` | Node | Nextcloud ExApp wrapper (reverse proxy + AppAPI lifecycle). |
| `guard-service/` | Python / FastAPI | PII detection (GLiNER, CPU). |
| `pii-service/` | Python | Additional PII service. |
| `search-service/` | Python / FastAPI | Web/document extraction + knowledge-base chunking. |
| `whisperx-service/` | Python / FastAPI | Audio transcription + speaker diarization (WhisperX). |
| `reranker/` | Python / FastAPI | Cross-encoder search reranking. |
| `components/` | Node | n8n-compatible component nodes shipped by Bee Flow. |
| `hub-module-sdk/` | Node | Build, pack and sign Bee Flow Hub modules (`.bfmod` packages). |
| `install-wizard/` | Node | First-run visual setup wizard. |
| `nc-login-mini/` | Node | Minimal Nextcloud ExApp proving AppAPI auto-login. |
| `e2e/` | Playwright / TS | CI smoke harness — specs generated from Markdown scenarios. Runs on demand (`workflow_dispatch`) or as a reusable workflow; it does not gate releases yet. |
| `playwright-tests/` | Playwright / TS | Hand-written UI regression tests against the running local stack. |
| `docs/` | Docusaurus / TS | Documentation site (published from `docs/docs/`; `docs/design/` holds design notes). |
| `scripts/` | Bash / PowerShell / Node | Image builds, secret scans, ops helpers, and the CI plumbing checks (`*.mjs`, tested by `npm run test:scripts`). |
| `docker/` | — | Container init files (e.g. `init-db.sh`). |

The root also holds the docker-compose variants (see the table in
[README.md](README.md)), the install scripts, and `selfhost.sh`.

## Licensing

The licensing is **fair-code**: `server/`, `agent-hub/`, `desktop/` and
`mobile/` ship under the **Sustainable Use License v1.0**, while
`nextcloud-connector/` is
**AGPL-3.0-or-later** (the Nextcloud App Store requires an OSI-approved
license). The authoritative per-component table is in
[LICENSE.md](LICENSE.md).

## How features are gated (license-key based)

The full product source, premium features included, is in this repo. What a
running install may use is decided at runtime by a signed license key:

- **Tiers** are hierarchical: `community` → `enterprise` → `full`, defined in
  [`server/license/tiers.js`](server/license/tiers.js) (the single source of
  truth for which features and limits each tier unlocks). A legacy `pro` tier
  is accepted in old keys and resolves to `enterprise`.
- **Community is the free floor.** A fresh install with no license key runs the
  community tier: chat with agents, knowledge bases, the Nextcloud connector,
  multi-user with groups, and all built-in integrations.
- **Route gating** uses `requireFeature` / `requireTier` from
  [`server/license/middleware.js`](server/license/middleware.js) (imported in
  `server/index.js` as `requireLicenseFeature` / `requireLicenseTier`). Without
  a license that includes the feature, gated endpoints return `403`.
- **License keys are JWTs** minted by Bee Flow's private license server, which
  is not in this repository (the only place that can issue them; Stripe
  webhooks drive purchases). The product server only
  *verifies*: [`server/license/verify.js`](server/license/verify.js) resolves
  the verification public key from `LICENSE_PUBLIC_KEY`,
  `LICENSE_PUBLIC_KEY_FILE`, or the hub's JWKS endpoint (`LICENSE_JWKS_URL`,
  with caching and a revocation list). Private signing keys never leave the
  license server.

### Adding a new gate

1. Add the feature ID to `server/license/tiers.js` (and the feature map in
   `server/license/featureMap.js` where applicable).
2. Wrap the route with `requireLicenseFeature('your_feature')`.

## Deliberate non-choices

- **No CLA and no copyright assignment** — contributions land under the
  component's license by submission; contributors retain copyright.
- **No "Community Edition" / "Enterprise Edition" fork** — one codebase,
  runtime-gated features.
- **No license minting in the product server** — it can only verify keys,
  never issue them.
