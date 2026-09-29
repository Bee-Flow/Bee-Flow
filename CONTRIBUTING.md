# Contributing to Bee Flow AI

Thanks for contributing. This monorepo hosts several services (see
[REPO-STRUCTURE.md](./REPO-STRUCTURE.md)); the commands below are the ones a
pull request is validated with.

## Dev setup

Follow the "Run Locally Without Docker" section in the
[README](./README.md#-run-locally-without-docker-core-services): a one-time
installer (`install-local.py` / `install-local.ps1`) sets up npm dependencies,
a pgvector Postgres container and `.env`, after which `npm run dev:all` starts
the backend (`:3101`) and the frontend (`:5276`).

Database migrations: `cd server && npm run db:migrate`.

## Tests

Tests live **next to their source** (`x.js` ↔ `x.test.js`), not in a central
`tests/` directory.

### Backend (`server/`)

```bash
cd server
npm test                         # full suite (scripts/run-tests.mjs)
node --test path/to/x.test.js    # single file
```

`npm test` runs every colocated `*.test.js` minus the documented exclusions in
`scripts/test-exclusions.json`, each file in its own `node --test` process
with its own timeout. There is deliberately no `--test-force-exit`: it ended
the process as soon as the runner thought it was done and silently dropped
whatever had not been reported yet, a different part on every run, under a
`# fail 0`. A file that keeps the event loop open after its tests is now
named (`HUNG`) instead; the reasoning is in the header of
`server/scripts/run-tests.mjs`. Don't add the flag back.

### Frontend (`agent-hub/`)

```bash
cd agent-hub
npm run test:run      # vitest, single pass
npm run typecheck     # tsc --noEmit
npm run lint          # eslint 9
```

### Python services

Install-free lint for the five FastAPI services (config in `ruff.toml`):

```bash
uvx ruff check guard-service pii-service reranker search-service whisperx-service
```

### End-to-end suites

Two separate Playwright suites exist — don't mix them up:

- **`e2e/`** — the CI smoke harness. Specs are *generated* from Markdown
  scenarios (`npm run gen`) and must not be hand-edited. It runs as a reusable
  workflow on demand (`workflow_dispatch`); it is not yet wired in as a release
  gate. See [e2e/README.md](./e2e/README.md).
- **`playwright-tests/`** — hand-written UI regression tests against the
  running local stack. Start here for new UI checks and edit the specs
  directly. See [playwright-tests/README.md](./playwright-tests/README.md).

## What CI runs on a pull request

One workflow, `.github/workflows/ci.yml`: a `changes` job filters by path,
the per-tree jobs (server, frontend, mobile, Python lint and tests, guard,
Nextcloud connector and server) run for what changed, and
`checks-passed` aggregates them into one context. Two more run on every pull
request and again on every push to `main`: `scan` (`secret-scan.yml`,
gitleaks over the tree and over the commits the PR or push adds) and `audit`
(`dependency-audit.yml`, the advisory ratchet).

Those three are the required status checks of the `main` ruleset (23605458,
mirrored in `.github/required-checks.json`). A change reaches `main` only
through a pull request that has all three green. Nobody can bypass that, and
`main` cannot be force-pushed or deleted. The ruleset does not require the
branch to be up to date with `main` (`strict` is off), so the merged tree can
be one the pull request never ran against: `build-push-ghcr.yml` calls
`ci.yml` on it before it builds the `:dev` image, and on a manual run or a
push to `develop` that call is the only gate.

Every push to an open pull request runs `ci.yml` again, and Actions minutes
are billed. Check locally first (below), open the pull request once the work
is done, and bundle fixes into one push. When a run is red, read the log
before anything else; re-run only the failed jobs, never all of them.

### Before you push

```bash
npm run check:fast   # every quick ratchet and plumbing gate, in parallel, a few seconds
```

`scripts/check-fast.mjs` runs each `lint:*` script in the root `package.json`
except the ones that need the network, an install, a build or minutes
(`npm run check:fast -- --list` shows both lists), plus the i18n key guard and
the commit-range secret scan against the merge-base with `origin/main`. Add
the tests next to the files you changed (`node --test <file>` in `server/`,
`npx vitest related --run <files>` in `agent-hub/`); the full suites run in
CI.

After touching `.github/workflows/` or `scripts/`, also run
`npm run test:scripts`; `npm run check:fast` already covers
`npm run lint:workflows` and `npm run lint:checks`.

## Secret scans on every commit

This is a privacy product and the bar is strict. Enable the tracked hooks
once per clone:

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-commit` then scans what each commit records with both
scanners (`--staged`: the staged files, not the whole tree), and a finding
blocks the commit. The required `scan` check still scans the whole tree and
every commit of the pull request. The full-tree scans by hand:

```bash
npm run lint:gitleaks   # gitleaks over tracked files
npm run lint:secrets    # test-fixture keys outside test files
```

Never commit real `.env` files, credentials, keys, or customer data. See
[SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

## Conventions

- Frontend contributions: see [agent-hub/CONTRIBUTING.md](./agent-hub/CONTRIBUTING.md)
  for SPA-specific guidelines.
- Server code layout: see [server/ARCHITECTURE.md](./server/ARCHITECTURE.md) —
  new code goes in the directory of its domain (`core/llm/`, `core/documents/`,
  `core/providers/`, …), not loose at `core/` level.
- LLM providers are adapters in `server/core/providers/` behind the factory in
  `server/core/providers/index.js`; self-hosted runtimes (Ollama, vLLM, …) all
  go through `providers/local.js` + an entry in `providers/localModels.js`.
- Premium features are gated with `requireFeature` from
  `server/license/middleware.js` (exposed in `server/index.js` as
  `requireLicenseFeature`), verified against JWTs from the license server.

## License

By submitting a contribution you agree it is provided under the license of the
component you contribute to — see [LICENSE.md](./LICENSE.md). There is no CLA
and no copyright assignment; contributors retain copyright on their commits.
