# L-T result

- **Tested commit:** `075904b9e1b76fc8337d55a3ffe5bc127a0bd04d` (merge(ts): laptop fix-b3 (final-review blocker), Opus-reviewed)
- **Result:** PASS
- **Run:** 2026-10-16T13:49:35+02:00 → 2026-10-16T14:03:48+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** low-memory: every check one at a time, each after >= 8 GB is free; vitest --maxWorkers=4, jest --maxWorkers=4, server TEST_CONCURRENCY=6

| Check | Command | Status | Counts | Time | Peak mem |
|---|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 1.8 s | 2 s | 0.1 GB |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 5291 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 68 s | 4.2 GB |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 12 s | 1.7 GB |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15166 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>✅ test: 26188 duplicated lines, under the budget of 26228. Run `node scripts/duplication-ratchet.mjs --update` to lower it. | 2 s | 2.8 GB |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 5 s | 0.2 GB |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 67 s | 5.4 GB |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1864 passed (1864)<br>Tests: 0 failed \| 22005 passed \| 0 skipped/todo (22005) | 383 s | 2.0 GB |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 14 s | 1.8 GB |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 51 s | 4.3 GB |
| server-test | `cd server && npm test` | PASS | # tests 29132 · # pass 29101 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2593 | 248 s | 0.2 GB |

## L-T notes

- First run in low-memory mode: every check one at a time, each after >= 8 GB was free. Total 14 min.
- Peak mem for `server-test` (0.2 GB) is an UNDERCOUNT: `run-tests.mjs` spawns each test file `detached`
  (its own session), which the sampler did not follow. Fixed for the next runs (it now walks the process tree).
- agent-hub eslint warnings rose 4589 -> 5291 (+702) since 0058a60e, still under the budget of 6674.
  Most likely from 6b1d2fa4 "lint(agent-hub): the JS policy rules also cover TypeScript source" (more files in scope);
  not attributed per commit.
