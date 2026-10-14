# server/scripts

Scripts that ship in the server image (the image context is `server/`, so a
script an operator runs "on one app node" belongs here, not in the root
`scripts/`). Run them from `server/` locally, or from `/app` in the container.
Tests sit next to the script (`x.js` next to `x.test.js`).

The files are grouped by role below. They are not (yet) moved into
`test/`, `ops/`, `dev/` and `content/` subfolders: many are referenced by path
from `server/package.json`, `server/Dockerfile`, `.github/workflows/`,
`docker-compose*.yml`, docs and runtime modules, and a move has to update all
of those in one change.

## Ops: run by an operator against a live database

Mutating ops scripts are dry runs by default and parse their flags with
`lib/opsArgs.js` (`node:util` `parseArgs`, strict): only `--apply` mutates, and
an unknown flag, a typo or a missing value stops the script before it touches
anything (exit 1).

| Script | Role | Flags |
|--------|------|-------|
| `rotateMasterKey.js` | Rotate `MASTER_ENCRYPTION_KEY` (env `MASTER_ENCRYPTION_KEY` + `_NEW`) | none |
| `backfill-encryption.js` | Encrypt rows written before an encryption tier was switched on | `--org`/`--all-orgs`, `--dry-run`, `--surface`, `--limit` |
| `backfillSavedAudioKeys.js` | Upload saved recordings to object storage | `--apply` (opsArgs), `--batch` |
| `check-legacy-dek.js` | Count accounts still on legacy encryption paths (read-only) | `--json` |
| `cleanupAzureDuplicates.js` | Merge duplicate Azure AD users | `--apply` (opsArgs), `--force` |
| `deleteOrgs.js` | Delete organisations by explicit id | `--orgs`, `--apply` (opsArgs), `--yes`, `--force-remote` |
| `detachMisassignedFreeEmailUsers.js` | Detach free-mail users from a wrong org | `--apply` (opsArgs), `--org`, `--since` |
| `microsoft-sso-upgrade.js` | Inspect / apply the Microsoft SSO hardening | `--apply` (opsArgs) |
| `migrateStudioAppsToPg.js` | Move App Studio apps to Postgres | `--all`/`--app`, `--dry-run`, `--keep-going`, `--report` |
| `datatable-orphan-scan.mjs` | Find orphaned data-table storage | |
| `mint-mcp-token.js` | Mint or revoke an MCP token | `--revoke`, ... |
| `generate-opaque-setup.js` | Generate the OPAQUE server setup secret | |
| `verifyEvidenceChain.js` | Verify the compliance evidence hash chain (read-only) | `<orgId>`, `--limit`, `--json` |
| `healthcheck-wget.js` | Container health check (`Dockerfile`) | |
| `fetch-geo-db.mjs` | Download the GeoIP database | |
| `assistantInstall.js` | Install-time data for the assistant | |

## Test: the backend test runner and CI helpers

`run-tests.mjs` (with `test-exclusions.json`, `test-durations.json`),
`testShards.mjs`, `check-test-shards.mjs`, `merge-coverage.mjs`,
`typecheck.mjs`, `azure-release-smoke.js`, `test-automation-e2e.js`,
`cleanup-test-runs.js` (copied into the container by
`scripts/cleanup-test-runs.sh`, so it stays dependency-free).

## Dev: harnesses and local tooling

`drive-builder.js`, `drive-app-builder.js`, `drive-playbook.js`,
`builder-trace-from-log.mjs`, `builder-briefs/`, `playbook-cases/`,
`print-playbook-briefs.js`, `playbook-compliance-dry-run.js`,
`print-model-prompt.js`, `eval-auto-tier.mjs` (+ corpus), `seed-usage.js`,
`run-usage-push.js`, `generate-test-invoices.js`, `template-to-file.js`,
`research/`.

## Content: generators and seeds for shipped data

`content/`, `seedBeeflowSite.js`, `renderOgImages.js`,
`genComplianceDemoCatalog.js`, `mergeComplianceKeys.mjs`,
`build-gene-catalog.js`, `build-iata-airports.mjs`.

## Shared code

`lib/opsArgs.js` (flag parsing for ops scripts), `lib/userDataFootprint.js`
(per-user data inventory for the user-cleanup scripts).
