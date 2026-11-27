# Task `ci-core-start`: CI holds the core start

The core now starts without any module. Nothing in CI holds that: the next import from a core
file into a module is caught by the boundary ratchet, but a core file that needs a module's
TABLE, or a boot step that needs a module, is not. This task adds the check (plan step 1.6).

## 1. A script: `scripts/core-boot-check.mjs`

One command that proves an edition starts. Header comment as every script has (the scripts
index is generated from it: `npm run gen:scripts-index`), a sibling `core-boot-check.test.mjs`
for its pure parts (`npm run test:scripts`), an entry in `scripts/roots-inventory.json`
(`node scripts/roots-inventory.mjs --check` tells you).

`node scripts/core-boot-check.mjs --database <url> [--hide-modules all | --edition core | --modules a,b] [--port n] [--expect-tables n]`

1. runs `node migrateDb.js` in `server/` against the (empty) database with the chosen edition;
   fails on a non-zero exit, and prints every log line of level error;
2. runs it a second time (the schema on what the first run left), same check;
3. counts the tables in `public`; with `--expect-tables` fails when the number differs, and
   always prints it;
4. starts `node index.js` on the port, polls `GET /api/ready` until 200 (fail after 90 s, or at
   once when the process exits), then probes: `/api/health` 200; one core route that needs a
   session answers 401 (`/api/kb`); with modules left out, `/api/automation` and `/api/datatables`
   answer 404; with every module, they answer 401;
5. sends SIGTERM and fails unless the process exits 0 within 30 s;
6. fails when the server log holds a line matching `is not present` or `Cannot find module`
   (a core file reached for a module), and prints the error-level lines it saw (some are
   expected on a bare install: no SERVICES_API_KEY, an ephemeral OPAQUE setup, pricing fetch).

The environment the server needs here: `NODE_ENV=production OTEL_ENABLED=false`, a
`SESSION_SECRET` and a `MASTER_ENCRYPTION_KEY` of 32+ characters (throwaway CI values, clearly
named as such: `scripts/check-no-test-secrets.sh` scans for real-looking ones; see how ci.yml's
`server-postgres` job names its value), `CORE_DATABASE_URL`. The shell version this replaces is
`/tmp/claude-0/-home-user-Bee-Flow/b2742a31-8d43-5614-b066-2234a2f0d9f7/scratchpad/boot-check.sh`
(read it; it worked against a local Postgres 16 on 127.0.0.1:5544, user `beeflow`, trust auth,
which you can use: create databases named `r2_ci_*`).

Run it yourself three times and report the output: `--hide-modules all` (expect 138 tables),
`--edition core`, and with no edition (expect 280 tables).

## 2. A CI job in `.github/workflows/ci.yml`

`server-core`, modelled on `server-postgres` (same Postgres service container, same
`needs: changes` / `if: needs.changes.outputs.server == 'true'`, the pinned action shas already
used in the file):

- `node scripts/core-boot-check.mjs --hide-modules all --expect-tables 138` on the service database;
- `cd server && node scripts/run-tests.mjs --scope core --hide-modules all` (the core's own
  tests with every module hidden). Until the driver says that run is green, write the step
  with `continue-on-error: false` anyway and say in your report that the job will be red until
  the list in `failing-core-tests.txt` is empty: the driver decides when the job joins
  `checks-passed`.
- a second database (`createdb` through psql in a step) for `--edition core`.

Then the repository's own plumbing, which fails until the job is known to it:
`npm run lint:checks` (every required status context has exactly one job),
`npm run lint:workflows` (concurrency buckets), `npm run lint:compose-drift` (the Postgres image
tag is compared across compose files and ci.yml service containers), and the `checks-passed`
job's `needs` list. Read `scripts/check-required-checks.mjs` (or what `lint:checks` runs) for
how a new job is declared; do not add the job to the REQUIRED contexts, only make the lints
pass with it present.

## 3. Report

The three local runs, the lints, `npm run check:fast`, `npm run test:scripts`. You cannot run
GitHub Actions here: say what is unverified (the service container wiring) and how the first CI
run will show it.

## Out of scope

Editing `server/` code. If the script finds a real problem in the server (a boot step that
needs a module, an error line that is a defect), report it with the log line; do not fix it.
