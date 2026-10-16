# L-T result

- **Tested commit:** `0f374b295e0468823583fe1872a20dbf4ff9676a` (ci(sast): semgrep reports without failing the PR, temporarily)
- **Result:** PASS
- **Run:** 2026-10-16T15:17:30+02:00 → 2026-10-16T15:21:44+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Mode:** suites picked by the ci.yml `changes` path filters; diffed against the last PASS `414d96e7` (1 changed files)
  - server: no changed file matches the server filter of ci.yml
  - frontend: no changed file matches the frontend filter of ci.yml
  - mobile: no changed file matches the mobile filter of ci.yml
- **Order:** typechecks + lint one at a time; then the selected suites IN PARALLEL: agent-hub vitest --maxWorkers=10, mobile jest --maxWorkers=8, server npm test TEST_CONCURRENCY=8; a suite failing on a timeout/OOM is rerun alone before it counts
- **Notes:** heavy.sh not in the tested tree; used the copy from a3afd896

| Check | Command | Status | Counts | Time | Peak mem |
|---|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 1.8 s | 2 s | 0.6 GB |
| lint-budget | `npm run lint:budget` | PASS | ➖ agent-hub: 5291 warnings, at budget<br>➖ server: 0 warnings, at budget | 70 s | 4.2 GB |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 11 s | 1.7 GB |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15162 duplicated lines, under the budget of 15166. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26188 duplicated lines, at budget | 2 s | 2.9 GB |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 5 s | 0.2 GB |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 119 s | 5.0 GB |
| ah-vitest | `agent-hub: npm run test:run` | SKIPPED | frontend filter: no changed file matches the frontend filter of ci.yml | | |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 15 s | 1.9 GB |
| mobile-jest | `mobile: jest --ci (full)` | SKIPPED | mobile filter: no changed file matches the mobile filter of ci.yml | | |
| server-test | `cd server && npm test` | SKIPPED | server filter: no changed file matches the server filter of ci.yml | | |
