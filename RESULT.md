# L-T result

- **Tested commit:** `ba8ba338231c8bdf099f66205dd7259ee0860025` (fix(ts): integrate S1, S3 and L-C typings)
- **Result:** PASS
- **Run:** 2026-10-16T10:56:38+02:00 → 2026-10-16T11:05:35+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** typechecks + lint in parallel first; then the full suites one at a time: agent-hub vitest (--maxWorkers=8), mobile jest, server npm test

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 4.2 s | 4 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4600 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 128 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 35 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15165 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>✅ test: 26188 duplicated lines, under the budget of 26228. Run `node scripts/duplication-ratchet.mjs --update` to lower it. | 3 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 6 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 140 s |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1860 passed (1860)<br>Tests: 0 failed \| 21895 passed \| 0 skipped/todo (21895) | 286 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 60 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 22 s |
| server-test | `cd server && npm test` | PASS | # tests 29126 · # pass 29095 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2591 | 89 s |
