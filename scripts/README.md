# scripts/

Operational and developer tooling for the Bee Flow monorepo. Run everything
from the repo root unless a script says otherwise. Purposes below are taken
from each script's own header comment — read the header before running
anything that touches production.

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
| `rotate-master-key.js` | `MASTER_ENCRYPTION_KEY` rotation utility — rotates the master key without downtime |

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
