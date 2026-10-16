# L-T result

- **Tested commit:** `c9c9d1db2ad20084bd0c4e7a1e6a1aa763aa7059` (chore(ratchets): lower the budgets to what the converted tree measures)
- **Result:** PASS
- **Run:** 2026-10-16T14:06:43+02:00 → 2026-10-16T14:25:40+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** low-memory: every check one at a time, each after >= 8 GB is free; vitest --maxWorkers=4, jest --maxWorkers=4, server TEST_CONCURRENCY=6

| Check | Command | Status | Counts | Time | Peak mem |
|---|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 5.1 s | 6 s | 2.1 GB |
| lint-budget | `npm run lint:budget` | PASS | ➖ agent-hub: 5291 warnings, at budget<br>➖ server: 0 warnings, at budget | 156 s | 4.0 GB |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 28 s | 1.7 GB |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ➖ production: 15166 duplicated lines, at budget<br>➖ test: 26188 duplicated lines, at budget | 6 s | 2.8 GB |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 6 s | 0.2 GB |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 68 s | 5.4 GB |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1864 passed (1864)<br>Tests: 0 failed \| 22005 passed \| 0 skipped/todo (22005) | 532 s | 2.0 GB |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 29 s | 1.8 GB |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 53 s | 4.5 GB |
| server-test | `cd server && npm test` | PASS | # tests 29132 · # pass 29101 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2593 | 178 s | 6.4 GB |

## L-T notes

- Peak memory is now measured over the whole process tree (fixed since 075904b9). The server suite, at
  TEST_CONCURRENCY=6, peaked at 6.6 GB, the highest step; from the next run it uses TEST_CONCURRENCY=4.
- The new budgets of c9c9d1db match what this tree measures exactly: eslint agent-hub 5291 and duplication
  15166 / 26188, all "at budget" (no slack left).
