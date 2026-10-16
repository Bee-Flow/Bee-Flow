# L-T result

- **Tested commit:** `cfb10394c2540fb1a67a74b831674ffc2fecd4ce` (test(agent-hub): mock useBfMarks where WebpageIDE imports it)
- **Result:** PASS
- **Run:** 2026-10-16T09:48:48+02:00 → 2026-10-16T09:59:01+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** typechecks + lint in parallel first; then the full suites one at a time: agent-hub vitest (--maxWorkers=8), mobile jest, server npm test

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 11.9 s | 12 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4750 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 143 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 66 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15213 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26228 duplicated lines, at budget | 7 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 8 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 155 s |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1858 passed (1858)<br>Tests: 0 failed \| 21872 passed \| 0 skipped/todo (21872) | 333 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 75 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 28 s |
| server-test | `cd server && npm test` | PASS | # tests 29089 · # pass 29058 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2587 | 97 s |
