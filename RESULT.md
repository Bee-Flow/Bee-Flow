# L-T result

- **Tested commit:** `414d96e791ad2a42d1a8dae698e8a4e9a94740c2` (merge(ts): laptop fix-b2p3 (B2 part 3: 111 stale as-unknown-as shims removed, types only), Opus-reviewed)
- **Result:** PASS
- **Run:** 2026-10-16T15:00:01+02:00 → 2026-10-16T15:14:55+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** low-memory: every check one at a time, each after >= 8 GB is free; vitest --maxWorkers=4, jest --maxWorkers=4, server TEST_CONCURRENCY=4
- **Notes:** heavy.sh not in the tested tree; used the copy from a3afd896

| Check | Command | Status | Counts | Time | Peak mem |
|---|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 3.6 s | 5 s | 1.9 GB |
| lint-budget | `npm run lint:budget` | PASS | ➖ agent-hub: 5291 warnings, at budget<br>➖ server: 0 warnings, at budget | 60 s | 4.4 GB |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 11 s | 1.7 GB |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15162 duplicated lines, under the budget of 15166. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26188 duplicated lines, at budget | 2 s | 2.5 GB |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 5 s | 0.2 GB |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 56 s | 5.4 GB |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1864 passed (1864)<br>Tests: 0 failed \| 22005 passed \| 0 skipped/todo (22005) | 370 s | 2.1 GB |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 13 s | 1.8 GB |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 81 s | 4.3 GB |
| server-test | `cd server && npm test` | PASS | # tests 29132 · # pass 29101 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2593 | 291 s | 4.1 GB |
