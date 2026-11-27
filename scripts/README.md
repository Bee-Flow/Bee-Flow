# scripts/

Operational and developer tooling for the Bee Flow monorepo. Run everything
from the repo root unless a script says otherwise. Purposes below are taken
from each script's own header comment — read the header before running
anything that touches production.

The sections below explain the scripts that need explaining. The complete list,
one row per script, is generated at the end: [Every script](#every-script).

## Build and dev loop

| Script | Purpose |
|--------|---------|
| `build-images.sh` | Build and optionally push Bee Flow service images with dev/prd tags (`npm run build:dev` / `push:dev` / `build:prd` / `push:prd`) |
| `build-images.ps1` | PowerShell port of `build-images.sh` (identical behaviour on Windows) |
| `dev-rebuild.sh` | Local dev-loop rebuild: only rebuilds (and recreates) images whose build context changed since the last run |
| `dev-nc.sh` | Single entrypoint for the Bee Flow + Nextcloud local dev loop (`up` / `spa` sub-commands) |
| `run-local-nc.sh` | Run Bee Flow against a local Nextcloud — no App Store, no public registry |
| `setup-local-db.sh` | One-time local PostgreSQL setup for Bee Flow without Docker |
| `learn-media-fetch.mjs` | Install a Learning Center video pack (a `.tar.gz` from `LEARN_MEDIA_PACK_URL` or a local path) into `LEARN_MEDIA_DIR`, verifying every file's sha256 against the pack's manifest before swapping it in (`npm run learn-media:fetch`) |

## CI / hygiene

| Script | Purpose |
|--------|---------|
| `check-fast.mjs` | Every cheap CI gate at once, in parallel, in a few seconds (`npm run check:fast`) — see [below](#checkfast--the-cheap-ci-gates-locally) |
| `check-editor-bundles.mjs` | The generated editor bundles in `server/core/markdown/` still match their `agent-hub/src/editor/` sources: recomputes the input sha256 in each bundle's banner (`npm run lint:editor-bundles`). `build-editor-bundles.mjs` builds and stamps them (`cd server && npm run build:editor-md` / `build:editor-collab`) |
| `check-compose-drift.mjs` | Same third-party image, same tag in every `docker-compose*.yml`; compose profiles match `ALL_PROFILES` in `selfhost.sh` (`npm run lint:compose-drift`) |
| `stage-server-context.sh` | Stages the server image's App Studio runtime bundle and SBOM into its (gitignored) build context; shared by `build-push-ghcr.yml`, `build-images.sh` and `build-images.ps1` |
| `gen-api-reference.mjs` | The REST reference in `docs/`, generated from the running app's router: every route with its gates and zod request schemas, as `docs/static/openapi.json` (OpenAPI 3.1) and the pages under `docs/docs/api/reference/` (`npm run gen:api-reference`; `--check` is `npm run lint:api-reference`, run by ci.yml's server-checks job because it loads the server app). `api-reference-walk.cjs` is the child process that does the loading |
| `gen-shared-mirror.mjs` | Generates agent-hub's copy of the expression engine from `server/shared/expr/` (`npm run gen:shared`; `--check` is `npm run lint:shared-mirror`) — see [below](#gen-shared-mirrormjs--the-expression-engines-agent-hub-copy) |
| `entry-point.mjs` | `isEntryPoint(import.meta.url)`: a script's "run as a command, not imported by a test" guard, through realpath so a symlinked path cannot make a gate skip `main()` and exit 0. A script that imports it and is copied into a test sandbox needs it copied too |
| `eslint-budget.mjs` | ESLint warning ratchet per package (`npm run lint:budget`) — see [below](#eslint-budgetmjs-windows-and---concurrency) |
| `scan-secrets.sh` | Monorepo secret scanner: gitleaks with `.gitleaks.toml`, or a regex fallback when gitleaks is absent. Default: tracked files (`npm run lint:gitleaks`, CI). `--range A..B`: the commits in a range (CI, needs gitleaks). `--changed` / `--staged`: only what a commit can contain (the commit hooks) — see [below](#secret-scan-modes---changed---staged---range) |
| `check-no-test-secrets.sh` | Test-fixture secrets (MASTER_ENCRYPTION_KEY="test-…" and similar) outside test files (`npm run lint:secrets`, CI). Reads tracked plus untracked-not-ignored files from git, so other checkouts under `.claude/worktrees/` and gitignored build output are not read. Same `--changed` / `--staged` modes |
| `generate-sbom.sh` | SBOM generator: per-workspace license reports, root CycloneDX, and `THIRD-PARTY-LICENSES.md` |
| `release-notes/` | Release-notes drafter run inside GitHub Actions (`draft.js`) |
| `release-tag.sh` | Tag a downstream repo (connector/hive) with the version from its source-of-truth file — refuses mismatched tags |

## `check:fast` — the cheap CI gates, locally

`npm run check:fast` (`check-fast.mjs`) answers "what will CI's cheap gates
say?" in a few seconds, without installing or fetching anything: 18 gates in
2.0 s of wall time on this repo (4 cores, 2026-09-25). Run it before opening a pull
request and before every push to an open one. It runs, at most
`os.availableParallelism()` at a time:

- every root `package.json` script whose name starts with `lint:`, except the
  denylist below;
- `i18n-key-guard.mjs --base <merge-base of HEAD and origin/main>` (CI runs it
  against the pull request's base);
- `scan-secrets.sh --range <merge-base>..HEAD`, the commit scan of the
  required `scan` context.

It prints a PASS / FAIL / SKIP line per gate as the gate finishes, then the
full output of every failing gate, then a summary, and exits 1 on any FAIL.
`--list` prints what would run, and the denylist, without running anything;
`--only <substring>` keeps the gates whose name contains it
(`npm run check:fast -- --only i18n`).

A SKIP always says why, and none of them is a pass: `origin/main` is not in
the clone (the two merge-base gates), there is no bash (the `.sh` gates), or
gitleaks is not installed (the range scan has no regex fallback; CI installs
it). A gate that runs over 120 s is killed and reported as FAIL.

The commands are read from `package.json` and run the way npm would run them
(the root `node_modules/.bin` on `PATH`) but without npm: one process start
less per gate, and on Windows npm's script shell is cmd.exe, which cannot run
a `.sh` file. A command that invokes a `.sh` file goes to bash (`bash`, then
Git for Windows' `bash.exe`); every other one goes to the platform shell.

Left out, and why (`DENYLIST` in `check-fast.mjs`; CI runs all of them):

| Script | Why check:fast skips it |
|--------|-------------------------|
| `lint:deps` | `npm audit`: needs the network |
| `lint:deps:test` | the unit tests of `audit-ratchet.mjs` (~8 s); `npm run test:scripts` runs them |
| `lint:budget` | full eslint over agent-hub and server (~3 min), needs their `node_modules` |
| `lint:bundle` | needs a production build of agent-hub |
| `lint:coverage` | needs a coverage run of each package |
| `lint:duplication` | jscpd over the whole tree (~7 s), needs the root `node_modules` |
| `lint:gitleaks` | full-tree scan; the commit hook scans the changed files, the range scan the commits |

**Adding a gate.** A new quick check needs nothing here: add it to the root
`package.json` as a `lint:<name>` script and check:fast runs it from then on.
One that needs the network, an install, a build or more than a second or two
goes into `DENYLIST` with its reason; `check-fast.test.mjs` fails when a
denylisted name no longer exists in `package.json`, so a rename cannot quietly
put three minutes of eslint back into the fast path. A gate that passes but
takes over 10 s is named at the end of every run as a candidate for the
denylist. A check that is not an npm script (like the two merge-base gates)
goes in `branchGates()`.

## `gen-shared-mirror.mjs` — the expression engine's agent-hub copy

The expression engine runs in the server and in App Studio. The agent-hub
image builds with context `./agent-hub` and cannot see `server/`, so agent-hub
carries its own copy (`agent-hub/src/shared/expr/`, the `@shared` alias in
`vite.config.js`). `server/shared/expr/` is the source; the copy is generated:

- `npm run gen:shared` copies every non-test file of `server/shared/expr/`
  over, byte for byte, and removes a copied file the server no longer has.
- `npm run lint:shared-mirror` (`--check`, run by `check:fast` and as the
  first step of CI's Frontend checks) writes nothing and exits 1 naming each
  file that differs (with its first differing line), is missing, or is
  extra. `sharedExpr.sync.test.js` in agent-hub's vitest suite stays as a
  backstop.

Tests (`*.test.*`, `*.spec.*`) are outside the mirror on both sides. The copy
is in `.jscpd.json`'s ignore list because it is generated, not duplication
anyone writes: 1,438 of the lines `lint:duplication` counted. The reason lives
here because `.jscpd.json` is strict JSON and jscpd 5 warns about an unknown
key such as `_comment` on every run.

## `eslint-budget.mjs`: Windows and `--concurrency`

`eslint-budget.mjs` starts eslint as
`node <package>/node_modules/eslint/bin/eslint.js`, the way
`.claude/hooks/post-edit-lint.mjs` does. It used to exec
`node_modules/.bin/eslint.cmd` on Windows, which Node refuses without a shell
since the CVE-2024-27980 fix (EINVAL on Node 18.20.2+, 20.12.2+ and 22), so
`npm run lint:budget` could not run there at all.

It passes `--concurrency <n>` when the package's installed eslint
(`node_modules/eslint/package.json`) is 9.34.0 or later, the release that
added the flag; an older eslint gets no flag. `n` is the CPUs the process may
use (`os.availableParallelism()`), capped at 4 because every worker loads its
own copy of the config and parsers, and there is no flag on a single CPU. Not
`auto`: eslint's auto starts at most half the CPUs and turns one worker into
none, so on GitHub's 2-vCPU runner it lints on one thread. Measured on
agent-hub (eslint 9.39.2, 3,398 files; runs on a shared machine, 2026-09-25):

| CPUs | No flag | `--concurrency auto` | `--concurrency 2` |
|------|---------|----------------------|-------------------|
| 2 (`taskset -c 0,1`) | 271 s | 246–251 s (no workers: the gap is noise) | 170–176 s |
| 4 | 228 s | 155 s (2 workers) | — |

Every run reported the same 0 errors and 7,132 warnings (at budget). Server
(0 warnings, at budget): 39 s before and 26 s with workers on 4 CPUs.

## Secret-scan modes (`--changed`, `--staged`, `--range`)

Both scanners take two narrow modes next to their full-tree default, which CI
uses unchanged, and `scan-secrets.sh --range A..B` scans the commits in a
range (CI's required `scan` context and `npm run check:fast`; needs gitleaks):

- `--changed`: the working-tree content of tracked files that differ from HEAD
  (staged or not) plus untracked files git does not ignore. The Claude Code
  hook `.claude/hooks/pre-commit-secret-scan.mjs` uses it because it runs
  BEFORE the command: in `git add x && git commit`, x is not staged yet when
  the hook looks.
- `--staged`: the index, i.e. exactly what `git commit` records.
  `.githooks/pre-commit` uses it (enable once per clone with
  `git config core.hooksPath .githooks`); it also covers `commit -a` and
  `commit <paths>`, which run the hook against a temporary index.

Both use the same `.gitleaks.toml`, print rule, file and line (never the
value), fall back to the regex scan over the same list without gitleaks, and
pass when the list is empty. A commit-time scan takes 0.1–0.9 s instead of the
2–10 s of the full-tree scan.

The Claude hook finds commits by parsing the command (quotes, heredocs, `cd`,
`git -C`, `bash -c`), so a commit message or PR body that mentions
`git commit` or `--dry-run` neither triggers nor skips a scan. It blocks only
on a finding. A scan that times out, is killed or cannot start is reported as
"NOT fully scanned" to the user and the model, never passed. When `.githooks`
is enabled it leaves the scan to git's hook, unless the commit uses
`--no-verify`. The hooks resolve the checkout with git from the edited file or
the command's directory, so they work in cloud sessions (CLAUDE_PROJECT_DIR is
the repo), in the Windows wrapper layout (CLAUDE_PROJECT_DIR/Bee-Flow-AI) and
in worktrees under `.claude/worktrees/`. Their tests are
`scripts/claude-hooks.test.mjs` and `scripts/scan-secrets.test.mjs`.

## Operations

| Script | Purpose |
|--------|---------|
| `server/scripts/rotateMasterKey.js` | `MASTER_ENCRYPTION_KEY` rotation utility — rotates the master key without downtime. Lives in `server/` so it ships in the server image (`cd /app && node scripts/rotateMasterKey.js` on one app node); pinned by `server/stores/keyRotationEnvelopes.test.js` |

Bee Flow's own hosted deployment (its manifests, deploy scripts and
monitoring) is maintained in a private repository and is not part of this one.
To run Bee Flow yourself, use `./selfhost.sh` or
`docker-compose.from-registry.yml` from the repo root.

## Cache TTLs and rolling deploys

The reference inventory of every **cross-process** cache in the server, and what
it means when a deploy rolls the pods (established for PLAN-APP row U14,
2026-09). All of these keys are stamped with the build sha (`:b<sha>` via
`utils/buildInfo.buildKey`), so an old and a new build never read each other's
entries — a rollout needs **no cache flush**: the new build starts cold and the
old build's entries die on their own TTL.

| Cache | Key shape | Lives in | TTL | Source |
|-------|-----------|----------|-----|--------|
| Entitlement resolution | `_ent:<user>:o<org>:v<ver>:b<sha>` | session store (PG/Redis, all replicas) | env `ENTITLEMENT_CACHE_TTL_MS`, default 30 000 ms | `server/core/entitlements/entitlements.js` |
| Licence resolution | `_lic:<user>:v<ver>:b<sha>` | session store | env `LICENSE_RESOLUTION_CACHE_TTL_MS`, default 30 000 ms | `server/license/middleware.js` (same key family read by `core/entitlements/betaFeatures.js`) |
| Permissions | `bf:perms:<user>:b<sha>` | Redis (in-memory fallback) | **30 s hardcoded** (`PERM_CACHE_TTL`) | `server/auth/permissions.js` |
| User-exists check | `bf:uex:<user>:b<sha>` | Redis (in-memory fallback) | **5 s hardcoded** (`USER_CHECK_TTL`) | `server/auth/permissions.js` |
| configStore reads | config key, e.g. `maintenance.window` | per process **+ Postgres LISTEN/NOTIFY invalidation** | 60 s (writes invalidate every replica within ms) | `server/stores/configStore.js` |
| Schema-health probe | n/a (single result) | per process | 30 s | `server/routes/healthSchema.js` |

Browser side (for completeness): the i18n catalogue cache is build-stamped
(`beeflow_i18n_<loc>_<sha>`, `agent-hub/src/utils/storageMigrations.js`) and the
available-locales list caches 24 h.

What this means for a rolling deploy:

- **Worst-case staleness after cutover is 30 s** (the longest TTL above): a
  permission or entitlement changed mid-roll can be honoured up to 30 s late on
  pods still serving. The `maintenance.window` announce itself is exempt — its
  writes broadcast over LISTEN/NOTIFY, so every replica shows/clears the banner
  within milliseconds.
- **No TTL env var is set in any compose file or `.env` example**, so the
  defaults above are what runs unless your deployment's own configuration
  overrides them.
- **Knob gap (flagged):** the upgrade plan documents "set `PERM_CACHE_TTL` to 0"
  as an emergency brake, but `PERM_CACHE_TTL` is a code constant, not an env
  var — that brake does not exist for the permissions cache without a code
  change. `ENTITLEMENT_CACHE_TTL_MS` / `LICENSE_RESOLUTION_CACHE_TTL_MS` *are*
  real knobs.

## Every script

Generated: one row per runnable file in this folder (tests left out) with the first sentence
of its header comment. `npm run gen:scripts-index` rewrites the table; `npm run
lint:scripts-index` (part of `check:fast`) fails when it is stale or when a script has no header
comment. A new script needs nothing here but a header whose first sentence says what it does.

<!-- scripts-index:start (generated by scripts/gen-scripts-index.mjs from the header comments; do not edit) -->
| Script | What it does |
|--------|--------------|
| `any-share.mjs` | any-share ratchet — how much of the server's checked code the type checker sees as `any`, in two numbers that may only go down |
| `api-reference-walk.cjs` | api-reference-walk — dump the app's real route table, with each route's gates and its zod request schemas as JSON Schema. |
| `api-relocate.mjs` | api-relocate: move the de-facto API modules that sit outside agent-hub/src/api/ into it. |
| `app-builder-live-run.sh` | Run one REAL App Studio build inside the server container and judge it against a brief's expectation — the live-run gate for App Studio builder work (the sibling of builder-live-run.sh). |
| `app-compat-pixels.mjs` | app-compat-pixels — screenshots of every App Studio compat-corpus app, written as a baseline or compared against one. |
| `app-version.sh` | The product version to stamp into the server image (build-arg APP_VERSION, read by server/modules/appVersion.js). |
| `audit-ratchet.mjs` | Dependency-audit ratchet — ISO/IEC 27001 A.8.8. |
| `body-schema-ratchet.mjs` | Body-schema ratchet: the number of mutating routes (POST, PUT, PATCH) whose chain has no `validate({ body })` may only go down. |
| `build-editor-bundles.mjs` | Builds the generated editor bundles in server/core/markdown/ with the esbuild the server's lockfile pins (no `npx -y`, which fetched whatever esbuild was newest) and stamps each with a hash of its inputs. |
| `build-images.ps1` | Build and optionally push BeeFlow service images with dev/prd tags. |
| `build-images.sh` | Build and optionally push BeeFlow service images with dev/prd tags. |
| `builder-live-run.sh` | Run one REAL automation-builder build inside the server container and judge it against a brief's expectation. |
| `bundle-ratchet.mjs` | Bundle-size budget for a Vite build — what a browser downloads, gzipped. |
| `catch-classify.mjs` | catch-classify: find the server's swallowed errors, sort them into buckets and rewrite the safe ones. |
| `check-compat-corpus.mjs` | check-compat-corpus — the App Studio compatibility corpus only grows. |
| `check-compose-drift.mjs` | The compose files must agree where they describe the same thing. |
| `check-duplicated-files.mjs` | Files that exist twice on purpose must stay byte-identical. |
| `check-editor-bundles.mjs` | The generated editor bundles must be the build of their current sources. |
| `check-fast.mjs` | check:fast — what CI's cheap gates will say, in a few seconds. |
| `check-legal-catalogue.mjs` | The legal register the Compliance Center scores against must say where its facts come from and when they were last checked. |
| `check-new-code-types.mjs` | New server code is typed from its first commit. |
| `check-no-test-secrets.sh` | Fail CI when test-fixture secrets leak into non-test source. |
| `check-package-registry.mjs` | Every package directory is in scripts/packages.json, and has a Dependabot entry. |
| `check-playwright-lockstep.mjs` | The server and the shared browser must run the same Playwright. |
| `check-release-container.sh` | Check that a built service image still meets the runtime prerequisites its reachability reviews rest on: the user it runs as, the binaries and packages removed for their advisories, and the pinned runtime versions. |
| `check-required-checks.mjs` | The contexts that gate a merge must each be produced by exactly one job. |
| `check-server-manifest.mjs` | The mobile job in ci.yml deliberately does NOT fire on server/package.json. |
| `check-version-drift.mjs` | Version drift ratchet — the same dependency on different majors in two npm packages. |
| `check-workflow-concurrency.mjs` | Concurrency policy for .github/workflows/. |
| `checkjs-ratchet.mjs` | checkJs ratchet — the number of server files that opted in to type checking with `// @typecheck` may only RISE. |
| `cleanup-test-runs.sh` | Remove what the playbook test runs left behind (playbooks, their automations, apps and created tables; with --forms also the test forms and their "Answers — …" tables). |
| `complexity-tail-ratchet.mjs` | Complexity tail ratchet — the number of functions above a cyclomatic complexity of 40 may only go down. |
| `console-to-log.mjs` | Codemod: console.* -> the package's structured logger. |
| `container-release-gate.mjs` | Container release gate: fail when the scan of an immutable image reports a high or critical finding that no valid exception with a dated reachability review covers. |
| `count-ratchet.mjs` | Count ratchets — for the metrics that are a pattern in the source. |
| `coverage-ratchet.mjs` | Coverage ratchet — the floor under each suite's line coverage, which may only rise. |
| `deep-imports.mjs` | Deep relative imports in agent-hub/src -> the `@/` alias. |
| `dev-nc.sh` | Single entrypoint for the Bee Flow + Nextcloud local dev loop. |
| `dev-rebuild.sh` | Local dev-loop rebuild: only builds (and recreates) the images whose build context actually changed since the last time THIS script built them — and reuses the same persistent BuildKit builder + per-service local layer … |
| `duplication-ratchet.mjs` | Duplication ratchet — copy-pasted lines across the repository may only fall. |
| `effect-fetch.mjs` | Does a file make a network call inside a useEffect? |
| `entry-budget.mjs` | Entry budget for a Vite build: what the public entry (dist/index.html) loads before it can paint. |
| `entry-point.mjs` | isEntryPoint — is this module the script node was started with, rather than one a test (or another script) imported? |
| `env-inventory.mjs` | Environment inventory: which environment variables the server reads, and a ratchet on the ones no document mentions. |
| `eslint-budget.mjs` | ESLint warning budget — a ratchet, not a threshold. |
| `eslint-service-config.cjs` | The ESLint flat config shared by the small Node services: nextcloud-connector and hub-module-sdk. |
| `file-budget.mjs` | File budget — the largest files may not grow. |
| `frontend-shards.mjs` | Which agent-hub test file runs where in CI, and the guard that proves every file runs exactly once. |
| `gen-api-reference.mjs` | gen-api-reference — the REST reference, generated from the server's own router. |
| `gen-api-types.mjs` | gen-api-types — the request types of every server route, for agent-hub and mobile. |
| `gen-app-catalog.mjs` | Generate the web's copies of the App Studio catalog from the server spec (server/appStudio/componentSpecs.js), so nothing in agent-hub mirrors it by hand |
| `gen-i18n-defaults.mjs` | gen-i18n-defaults — write the frontend's English dictionary from the server's. |
| `gen-routes-contract.mjs` | gen-routes-contract — server/auth/routes.contract.json from the server's own router. |
| `gen-row-types.mjs` | Generate server/types/rows.d.ts: one TypeScript interface per table, read from the `CREATE TABLE` / `ALTER TABLE ... ADD COLUMN` statements in the server sources (the stores create their own schema; there is no migration … |
| `gen-scripts-index.mjs` | Write the index of scripts/ at the end of scripts/README.md, or check that it is current. |
| `gen-shared-mirror.mjs` | gen-shared-mirror — write the generated copies of server/shared code that other packages need in their own tree, from a manifest. |
| `gen-step-kinds.mjs` | Write server/shared/appDefinition/stepKinds.generated.mjs from the App Studio step registry (server/appStudio/componentSpecs/steps/\<kind>.js), or check that it is current. |
| `generate-sbom.sh` | Software Bill of Materials generator for Bee Flow. |
| `i18n-key-guard.mjs` | i18n-key-guard — no English key disappears without saying so. |
| `i18n-ratchet.mjs` | Untranslated-string ratchet — the OTHER direction of the i18n guard. |
| `i18n-split.mjs` | i18n-split — split the monolithic English dictionary into one file per namespace. |
| `impact.mjs` | impact: given changed files, the minimal set of tests to run and the exact commands, so an agent on a shared laptop neither guesses nor runs a whole suite. |
| `jsdoc-convert-server.mjs` | JSDoc types for the server, by tooling. |
| `jsdoc-express-params.mjs` | Type the Express handler parameters that nothing types for us. |
| `jsdoc-loose-types.mjs` | Replace a server JSDoc parameter type that says nothing - {any}, {*}, {Object}, {object}, {Function} - with the type the checker infers from how the parameter is used and called. |
| `jsdoc-lower.mjs` | Lowers the inference edits of scripts/ts-callsite-types.mjs (TypeScript syntax: `x: T`, `interface P {...}`, `(e as Error)`, `import type`) to JSDoc, for a JavaScript file that stays JavaScript (the server: CommonJS, … |
| `jsdoc-round.sh` | Mechanical JSDoc rounds over server/ by tooling, one local commit per batch that passes every gate. |
| `jsdoc-row-types.mjs` | Type the row a store mapper takes from the generated table types. |
| `jsdoc-widen-initializers.mjs` | Widen the initializers that strictNullChecks narrows too far. |
| `jsx-extract.mjs` | jsx-extract: shorten a React component over 200 lines by lifting its largest JSX blocks into components of their own, with the TypeScript language service doing the work |
| `learn-media-fetch.mjs` | Install a Learning Center video pack from a tarball into LEARN_MEDIA_DIR: the OFFLINE route (the server fetches the pinned pack by itself at startup, see server/learning/learnMediaSync.js). |
| `link-module-node-modules.mjs` | Link every module root to the core's installed packages. |
| `module-boundary.mjs` | The module boundary ratchet: what the core still needs from the first-party modules may only go down, and a module may only use the modules it declares. |
| `module-map-edges.mjs` | The run-time import edges of a source tree, for the ownership map (scripts/module-map.mjs). |
| `module-map.mjs` | The ownership map: which first-party module owns which file of the server and of the web client (scripts/module-map.json; packages `server` and `agent-hub`). |
| `module-move.mjs` | Move the server files of a first-party module from server/ to modules/\<id>/server, every file on its own tree path, in one commit that is green by itself. |
| `mts-coverage.mjs` | `.mts` coverage ratchet — the floor under the line coverage of a package's TypeScript sources, which may only rise. |
| `mutation-sample.mjs` | Mutation sample — do the tests next to a file notice when its logic is changed? |
| `playbook-live-run.sh` | Run one REAL playbook case inside the server container — the whole film: table → automation builder → fill → app builder → app turns — and judge it against the case's expectation. |
| `port-jsdoc-branch.mjs` | Port the server changes of a paused JSDoc-conversion branch onto the working tree. |
| `prefetch-node-headers.sh` | Download the Node headers into node-gyp's cache BEFORE `npm ci` runs. |
| `ratchet-budget.mjs` | The budget step shared by scripts/theme-ratchet.mjs and scripts/vendor-name-ratchet.mjs: compare a measured count with the committed budget file, refuse a rise, and with --update record a lower count (never a higher … |
| `release-manifest.mjs` | The release candidate manifest: which image digests one build produced, that its security checks passed, and that staging accepted exactly those digests. |
| `release-tag.sh` | Tag a downstream repo with the version found in its source-of-truth file. |
| `release-workflow-evidence.mjs` | Verify that release evidence comes from a successful, manually started run of the named workflow on main, and hand its commit and attempt to the next step. |
| `roots-inventory.mjs` | Check scripts/roots-inventory.json: every script, runner and config that walks, globs or names a package directory, with whether it knows about module roots. |
| `rq-codemod.mjs` | rq-codemod: move agent-hub data fetching onto react-query, for the canonical shapes only. |
| `run-local-nc.sh` | Run Bee Flow against a local Nextcloud — no App Store, no public registry. |
| `runtime-watch.mjs` | runtime-watch — is a runtime we ship behind on a security release, or past its end of life? |
| `scan-secrets.sh` | Bee Flow — monorepo secret scanner. |
| `scc-ratchet.mjs` | SCC ratchet — the largest import cycle may only shrink. |
| `server-mv.mjs` | server-mv: move CommonJS files inside server/ and fix every reference, leaving no shim. |
| `setup-local-db.sh` | One-time local PostgreSQL setup for Bee Flow (no Docker). |
| `source-text-tests.mjs` | Count the tests that assert on SOURCE TEXT instead of on behaviour. |
| `split-big.mjs` | split-big: bring a server source file under the file-budget limit by moving a cohesive group of top-level declarations (roots plus everything they reference, transitively) into a same-directory sibling. |
| `split-plan.mjs` | split-plan: split the agent-hub files over the line limit by role, then check every split before it is kept. |
| `stage-installer-context.sh` | Stage the build context of the installer image (installer/Dockerfile): the four files of this checkout that the image carries, in installer/bundle. release-latest.yml runs it on the release tag before building the image. |
| `stage-server-context.sh` | Stage what the server image takes from gitignored folders of its build context (./server), so a local image carries the same extras as the one CI pushes. |
| `store-write-tx.mjs` | Store functions that write two or more tables without a transaction. |
| `theme-ratchet.mjs` | Theme ratchets for agent-hub: colours and theme variables that bypass the theme, counted so they can only go down. |
| `ts-behaviour-diff.mjs` | The behaviour diff of a conversion round, over EVERY changed source file: not only the files a tool converted (scripts/ts-equivalence.mjs checks those renames), but every modified or renamed .js/.jsx/.ts/.tsx/.mjs/.cjs … |
| `ts-callsite-types.mjs` | Call-site type inference for scripts/ts-convert-codefix.mjs. |
| `ts-cast-loop.mjs` | Remove type casts one by one and keep every removal the type check accepts. |
| `ts-convert-codefix.mjs` | JavaScript -> TypeScript conversion of agent-hub files by TOOLING, no model. |
| `ts-convert-gate.mjs` | The gate after scripts/ts-convert-codefix.mjs has converted files in the working tree: only what is green in every respect stays TypeScript. |
| `ts-convert-local.mjs` | First-pass JavaScript -> TypeScript conversion of agent-hub files by a LOCAL model (anything that speaks the OpenAI chat API: llama.cpp's llama-server, ollama, LM Studio). |
| `ts-convert-references.mjs` | After a JS -> TS conversion: every place that names a converted file by its old path follows it to the new one. |
| `ts-equivalence.mjs` | Proves a JavaScript -> TypeScript conversion changed nothing at runtime. |
| `ts-fix.mjs` | Apply TypeScript quick fixes headlessly, by fix id, to a list of files. |
| `ts-merge-type-imports.mjs` | Merges `import type { A } from 'x'; import type { B } from 'x';` into one `import type { A, B } from 'x';` per module specifier (the converter writes one line per type it imports). |
| `ts-move-types.mjs` | Moves a converted file's top-level interfaces and type aliases into a sibling `<Name>.types.ts`: for a file the added types pushed past its line ceiling (scripts/file-budget.mjs) the types go, the code stays. |
| `ts-outline.mjs` | Outline of a source file for agents that must split it with minimal reading. |
| `ts-ratchet.mjs` | TypeScript ratchet — a count that may only fall. |
| `ts-remove-unused-imports.mjs` | Removes unused imports from TypeScript files with TypeScript's own quick fix ("Remove unused declaration"), and only imports: an unused `const x = f()` stays, because deleting it would delete the call. |
| `ts-runtime-recorder.mjs` | Vitest setup file for scripts/ts-runtime-types.mjs: defines the global __tcRec the instrumented sources call, describes each value it is handed (a small JSON descriptor, never the value itself) and writes them to … |
| `ts-runtime-types.mjs` | Runtime type observation for scripts/ts-convert-codefix.mjs. |
| `ts-split.mjs` | Moves top-level declarations of a file into a sibling file, with the old file still working for every importer. |
| `ts-type-at.mjs` | Ask the checker for a type, or for the best replacement of an explicit `any`, without reading the files around it. |
| `tsc-error-ratchet.mjs` | tsc error ratchet: the number of errors `tsc -p <package>/tsconfig.strict.json` reports may only go DOWN. |
| `typecheck-settle.mjs` | Make a mechanical round clean again by undoing what broke it. |
| `vendor-name-ratchet.mjs` | Vendor-name ratchet: English UI strings in the admin namespaces that name an AI vendor or model may only go down. |
| `vuln-watch-gate.mjs` | vuln-watch gate — turns the OSV-Scanner report and the runtime-watch report into one verdict, one SARIF file for the Security tab and one summary. |
<!-- scripts-index:end -->
