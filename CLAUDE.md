# Bee Flow: guide for contributors and coding agents

Bee Flow is a self-hosted, privacy-first AI workspace (a GDPR-minded alternative to
ChatGPT Teams / Copilot), with zero-knowledge encryption and a fair-code licence. This is a
polyglot microservices monorepo. Run the commands below from the repository root unless a
line says otherwise.

## Services

| Directory | Stack | Role |
|-----------|-------|------|
| `server/` | Node 22 / Express 5 | Core API: agents, automations, RAG, auth, licence verification (the largest module) |
| `agent-hub/` | React 19 / Vite 7 / Tailwind 4 | Frontend SPA ("Agent Hub") |
| `desktop/` | Electron / TypeScript | Desktop client (Linux/macOS/Windows). Loads the SPA from the server, no bundled copy |
| `mobile/` | Expo / React Native | Native Android client (APK). Not a WebView wrapper |
| `guard-service/` | Python FastAPI (GLiNER) | PII detection (CPU) |
| `classify-service/` | Python FastAPI | Zero-shot topic classification |
| `reranker/` | Python FastAPI (torch) | Cross-encoder search reranking |
| `search-service/` | Python FastAPI | Web/document extraction and knowledge-base chunking |
| `whisperx-service/` | Python FastAPI (WhisperX) | Audio transcription and diarisation |
| `pii-service/` | Python | Additional PII service |
| `nextcloud-connector/` | Node | Nextcloud ExApp wrapper (AGPL) |
| `hub-module-sdk/` | Node | Build, pack and sign Bee Flow Hub modules |
| `docs/` | Docusaurus (TS) | Documentation site |

The license server that issues licence keys is a separate, private service. This repo only
verifies keys (see "Licence gating" below).

## Commands

**Run for development**
- `npm run dev:all`: server (:3101) and frontend (:5276) together
- `npm run dev:server` / `npm run dev:frontend`
- Self-host smoke test: `./selfhost.sh` (pulls the public GHCR images, waits for `/api/health`)
- DB migrations: `cd server && npm run db:migrate`

**Tests**
- Backend: `cd server && npm test`. It runs `scripts/run-tests.mjs`: every colocated
  `*.test.js` minus the documented exclusions in `scripts/test-exclusions.json`, each file in
  its own process with its own timeout. One file: `node --test path/to/x.test.js`.
  `--test-force-exit` is deliberately NOT used: it ended the process as soon as the runner
  thought it was done and silently dropped unreported results. Do not add it back; the
  reasoning is in the header of `run-tests.mjs`. A file that keeps the event loop open after
  its tests is reported by name (`HUNG`).
- Frontend: `cd agent-hub && npm run test:run` (vitest), `npm run typecheck`, `npm run lint`.
- Mobile: `cd mobile && npm test` (jest), `npm run typecheck`, `npm run lint`. Run jest via
  `./node_modules/.bin/jest` or `npm test`; a bare `npx jest` can fetch a different jest.
- Desktop: `cd desktop && npm run verify` (typecheck, lint, tests). The tests run with
  `node --test` on the TypeScript sources themselves (Node 22 strips types), so syntax that
  needs a transform (enums, parameter properties) compiles but fails in tests; eslint blocks
  both. Install without the Electron binary: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`.
  End to end: `npm run e2e` (Playwright starts the real app against a fake server; on Linux
  via `xvfb-run`, with the Electron binary).

**Secret scanning** runs by itself on every commit: the hooks scan only what that commit can
contain (`scripts/scan-secrets.sh --changed` and `scripts/check-no-test-secrets.sh --changed`
from the Claude Code hook; `--staged` from the opt-in git hook, `git config core.hooksPath
.githooks`). A finding blocks the commit. By hand, over the whole tree: `npm run lint:gitleaks`
and `npm run lint:secrets`.

**Repository plumbing** (run after any change in `.github/workflows/` or `scripts/`)
- `npm run check:fast` runs all fast checks in parallel in a few seconds
  (`scripts/check-fast.mjs`): every `lint:*` script from the root `package.json` except a
  denylist of slow or install/network-dependent ones, plus the i18n key guard and a range
  secret scan against the merge base with `origin/main`. A new `lint:*` ratchet joins
  automatically. `--list` shows what runs, `--only <text>` filters.
- `npm run test:scripts`: unit tests of all `scripts/*.mjs`. Not part of `check:fast`.
- `npm run lint:workflows`: every workflow sits in exactly one concurrency bucket
  (`scripts/check-workflow-concurrency.mjs`). A NEW workflow fails with "in no bucket" until
  you add it to the table with a reason.
- `npm run lint:checks`: every required status context is produced by exactly one
  non-matrix, unfiltered, PR-triggered job. All test and lint jobs live in `ci.yml` (path
  filters in its `changes` job); `checks-passed` is the aggregate.
- `npm run lint:deps`: the audit ratchet (`npm audit` may not get worse than the recorded floor).
- `npm run lint:budget`: the eslint warning ratchet for `agent-hub` and `server`
  (`scripts/eslint-budget.mjs`, budget in `<package>/.eslint-budget.json`; `--update` only
  lowers it). The server is at 0.
- `npm run lint:ts-ratchet`: the number of `.js`/`.jsx` files under `agent-hub/src` may only
  go down. Write new files in TypeScript.
- `npm run lint:i18n-ratchet`: the number of user-facing strings WITHOUT a key under
  `agent-hub/src` may only go down.
  **Serialisation rule:** the English dictionary is `server/i18n/defaults/en/<namespace>.js`,
  one file per namespace (the part of the key before the first dot), merged by `en/index.js`
  (which throws on an unlisted file, a key in the wrong namespace, or a duplicate key).
  `agent-hub/src/i18n/en-defaults.js` is GENERATED from it: never edit it by hand; after a
  change run `npm run i18n:gen` and commit both. CI runs `npm run lint:i18n-gen` and, on PRs,
  `scripts/i18n-key-guard.mjs`: a key that exists on the base and is now missing fails unless
  it is listed in `server/i18n/defaults/removed-keys.txt`. Keep one writer per namespace file:
  two branches adding to the same file merge without a visible conflict, and the second one
  silently wins.
- `npm run lint:shared-mirror`: `server/shared/expr/` (the expression engine) and
  `server/shared/mapping/` (the binding core behind `automation/bind.js`) are the sources;
  `agent-hub/src/shared/{expr,mapping}/` and mobile's `src/shared/{expr,mapping}/vendor/` are
  byte-for-byte GENERATED copies (the agent-hub image cannot see `server/`, Metro cannot import
  outside `mobile/`), listed in the `MIRRORS` table of `scripts/gen-shared-mirror.mjs`. After
  changing a source run `npm run gen:shared` and commit all copies.
- Count ratchets (`scripts/count-ratchet.mjs`, budget in `agent-hub/.<metric>-ratchet.json`,
  `--update` only lowers, `--list` shows where they are): `lint:style-ratchet` (`style={{…}}`
  objects; use a Tailwind class on the theme variable, `text-[var(--x)]`),
  `lint:fire-event-ratchet` (`fireEvent` calls that `userEvent` can replace),
  `lint:module-mock-ratchet`, `lint:authfetch-effect-ratchet`, `lint:big-file-ratchet` and
  `lint:dutch-comment-ratchet`.
- `npm run lint:source-text`: tests that read a source file and run a regex over it may only
  go down (`scripts/source-text-tests.mjs`).
- `cd agent-hub && npm run lint:dead`: `knip`, no source file that nothing imports.

## Pull requests and CI

- Before opening a PR, and before every push to an open PR: run `npm run check:fast` and the
  tests next to the files you changed: `node --test <file>` (server),
  `npx vitest related --run <files>` (agent-hub),
  `./node_modules/.bin/jest --findRelatedTests <files>` (mobile). The full suites run in CI.
- A draft PR runs the fast tier (lint, typecheck, build, ratchets, the small suites). Mark it
  ready when the work is done; the full run and the `checks-passed` aggregate then gate the merge.
- Bundle fixes into one push: every push to an open PR starts `ci.yml` again.
- A red test is never a flake by default: read the log first, and re-run only the failed jobs.
- Workflows from forks run only after a maintainer approves them.

## Architecture conventions

- **LLM providers**: an adapter factory in `server/core/providers/index.js` with one file per
  provider (`claude.js`, `openai.js`, `google.js`, `googleVertex.js`, `azure.js`,
  `mistral.js`, `scaleway.js`, `eugpt.js`). Add new providers there, not ad hoc elsewhere.
  - **Scaleway Generative APIs** (`scaleway.js` + `scalewayModels.js`): OpenAI-compatible,
    so the adapter holds only the differences (per-model `reasoning_effort` vocabulary,
    `max_tokens` cap, `stream_options.include_usage`). Every model there is open-weight and
    also sold by other hosts, and a fuzzy price match would pick one at random: always price
    through the exact `scaleway/<vendor>/<id>` key.
  - **EU GPT** (`eugpt.js` + `eugptModels.js`): one endpoint (`POST /v1/responses`), the
    router always picks the model (`eugpt-auto`), there are no client tools, the history goes
    as a transcript inside the user message (never in `instructions`), and the answer carries
    no token usage. It is in `NATIVE_TYPES` (`chatStream/roundRequest.js`).
  - **Mistral** (`mistral.js` + `mistralModels.js`): official SDK v2, which silently drops
    unknown request keys, so always use the SDK's camelCase names (`reasoningEffort`,
    `promptCacheKey`); `mistral.test.js` pushes our params through the SDK's real outbound
    schema. Tool-call ids must be exactly 9 alphanumeric characters and are hashed
    deterministically. Never set `MISTRAL_SDK_TELEMETRY`.
  - **Self-hosted runtimes** (Ollama, vLLM, llama.cpp, LM Studio, SGLang, ...): ONE adapter,
    `local.js`, with an instance per flavour. Adding a runtime is one entry in
    `LOCAL_RUNTIMES` in `localModels.js`; factory, presets, admin UI and autodetect follow.
    Marking a model as local (priced at zero) happens on the STORED provider type, never on an
    adapter guessed from a URL, or a paid endpoint would silently be priced at zero.
- **Context management in chats**: two mechanisms, do not mix them up.
  `core/llm/compaction.js` is the lossy local variant (a fast-tier summary plus truncated
  tool results) and is opt-in per organisation, off by default (`core/llm/contextPolicy.js`).
  The lossless variant is Anthropic's `context_management` in `core/providers/claude.js`,
  on by default. With compaction off, one emergency brake remains: a fold when the
  conversation nears the model's context window. Thinking blocks are replayed
  (`replayThinkingBlocks`), so `sanitizeMessages` must keep `thinking`; adapters that pass
  `messages` straight through strip it themselves (`utils/messageUtils.stripInternalFields`).
- **Orchestration**: `server/core/llm/` (`llmClient.js`, `modelResolver.js`,
  `modelCosts.js`, `pricingService.js`, `tokenBudget.js`, prompt helpers) and
  `server/core/aiAgent.js`. Provider adapters stay in `server/core/providers/`.
- **Logging in the server**: `server/telemetry/log.js` (`log.info/warn/error/debug`). In
  production JSON lines with a `reqId`; under `NODE_ENV=test` and in dev everything goes to
  `console`. `no-console` is a lint error outside `scripts/`, `migrations/`, the runners,
  `mcpServers/` and tests.
- **Errors in routes**: throw, or `next(err)`; `core/http/terminalErrorHandler.js` answers
  with a `correlationId`. An error the client may see is an `HttpError(status, code,
  message)` from `core/http/errors.js`; anything else becomes a generic 500.
  `res.status(5xx).json({ error: e.message })` is a lint error. Express 5 catches the
  rejection of an async handler, so a try/catch that only logs and answers 500 is redundant.
- **MCP**: `server/core/mcpManager.js` (the product talks to MCP servers itself).
- **Layout of `server/core/`**: see `server/ARCHITECTURE.md`. New code goes in its domain
  folder (`core/llm/`, `core/documents/`, `core/providers/`, ...), not loose in `core/`.
- **Licence gating**: premium features sit behind `requireLicenseFeature('...')`. Licence keys
  are signed JWTs issued by Bee Flow's private license server; this repo only verifies them
  (`server/license/verify.js`). See `REPO-STRUCTURE.md`.
- **Desktop client** (`desktop/`): the main window loads the SPA from the server itself, not a
  bundled `agent-hub` build, so the UI can never drift from the API a customer runs. The
  client adds what a browser tab cannot: tray, global shortcut, OS notifications,
  `beeflow://` deep links and the Nextcloud bridge.
  - Everything with a decision in it lives in a module with injected dependencies and tests
    next to it; only `index.ts`, `app.ts`, `tray.ts`, `menu.ts` and `windows/` import
    `electron` at module level.
  - The preload (`src/preload/index.ts`) is the whole renderer/main boundary: a fixed list of
    channels, no generic `invoke(channel, ...)`. New functionality is a channel in
    `shared/ipc.ts` plus a handler. The preload runs with `sandbox: true` and may require
    nothing but `electron`; esbuild bundles it and the build fails on any other require.
  - IPC trust is decided by the sender's URL (`senderTrust`), never by a flag from the
    renderer. Every `handle(...)` in `ipc/handlers.ts` starts with `requireShell` or
    `requireTrusted`.
  - The server probe (`server/probe.ts`) goes through Chromium's network stack
    (`chromiumFetch.ts`), so it agrees with the window about proxy, certificates and HSTS.
- **Nextcloud bridge** (`desktop/src/main/nextcloud/`): reads the Nextcloud desktop client's
  config (`nextcloud.cfg`, including the Flatpak and Snap locations) and optionally talks to
  its local socket. An attachment from a sync folder goes to the server as a WebDAV reference
  (read via `server/integrations/nextcloudFiles/`), not as a second copy.
- **Tests live next to the source** (`x.js` next to `x.test.js`), not in a central `tests/` folder.
- **Anthropic SDK**: `@anthropic-ai/sdk`.

## Security and privacy (this is a privacy product)

- Never commit secrets, keys or filled-in `.env` files. Only `*.example` files belong in git.
- Zero-knowledge envelope encryption (AES-256-GCM, Argon2id, OPAQUE).
- **Personal data does not leave Bee Flow, except by e-mail** (the data goes to the person
  themselves). To every other outbound destination (issue trackers, chat, and whatever comes
  later) send only a ticket reference, plus at most the subject when an org setting allows it
  (off by default). Never a name, e-mail address, organisation, phone number, IP, user agent,
  verbatim customer text or attachments. Build such payloads from an explicit allow-list of
  fields, never by deleting keys from a row, or a column added next year leaks along. The
  direction matters: fetching data from an external system is not covered by this rule.
- Report vulnerabilities privately, see `SECURITY.md`.

## Environment

Node 22.12.x, npm 10.9. Paths may contain spaces: quote them.
