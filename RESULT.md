# L-T result

- **Tested commit:** `30bc20fd8123e27c8133b30600a6fa1caec414e4` (ci: point the server filter and the lesson test at the renamed TypeScript files)
- **Result:** PASS
- **Run:** 2026-10-16T12:06:29+02:00 → 2026-10-16T12:13:45+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** typechecks + lint in parallel first; then the full suites one at a time: agent-hub vitest (--maxWorkers=8), mobile jest, server npm test

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 3.0 s | 3 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4589 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 64 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 21 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15165 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>✅ test: 26188 duplicated lines, under the budget of 26228. Run `node scripts/duplication-ratchet.mjs --update` to lower it. | 2 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 6 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 76 s |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1864 passed (1864)<br>Tests: 0 failed \| 22004 passed \| 0 skipped/todo (22004) | 235 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 19 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 26 s |
| server-test | `cd server && npm test` | PASS | # tests 29126 · # pass 29095 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2591 | 99 s |
