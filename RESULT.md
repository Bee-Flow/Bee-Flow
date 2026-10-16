# L-T result

- **Tested commit:** `435a6068362ffd83b9742a9e0f0a7e02a4f5b724` (merge(ts): laptop L-A round 1 (App Studio core, inspector logic, tables: 21 files), Opus-reviewed)
- **Result:** FAIL
- **Run:** 2026-10-16T09:15:31+02:00 → 2026-10-16T09:21:29+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 14.6 s | 14 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4750 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 284 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 103 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15213 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26228 duplicated lines, at budget | 4 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 9 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 298 s |
| ah-vitest | `agent-hub: npm run test:run` | FAIL (exit 1) | Test files: 0 failed \| 1858 passed (1858)<br>Tests: 0 failed \| 21872 passed \| 0 skipped/todo (21872)<br>Unhandled: Errors  1 error | 297 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 138 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 144 s |
| server-test | `cd server && npm test` | PASS | # tests 29089 · # pass 29058 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2587 | 184 s |

## L-T note: the vitest failure is an unhandled rejection, not a failing test

All 21872 tests pass; vitest exits 1 on 1 unhandled error: `useBfMarks.ts:57` calls `setState` after
jsdom was torn down (`window is not defined`), while `src/pages/webpages/WebpageIDE.i18n.test.jsx` ran.
Rerunning that one file in isolation 3x on this commit: unhandled error in 1 of 3 runs (tests 4/4 pass every
time), so it is a real intermittent leak (the hook's fetch settles after the test ends), not load alone.
Neither `useBfMarks.ts` nor the test changed in 177babc8..435a6068 (last change: a766e3e6), and the previous
staging run did not hit it, so it is pre-existing and timing-dependent rather than introduced by this round.
The 4 vitest failures reported for 177babc8 did not recur in this full run.

## Failures (1)

### ah-vitest: unhandled error (during src/pages/webpages/WebpageIDE.i18n.test.jsx): ReferenceError: window is not defined

```
ReferenceError: window is not defined
 ❯ resolveUpdatePriority node_modules/react-dom/cjs/react-dom-client.development.js:1498:7
 ❯ requestUpdateLane node_modules/react-dom/cjs/react-dom-client.development.js:17840:15
 ❯ dispatchSetState node_modules/react-dom/cjs/react-dom-client.development.js:9512:14
 ❯ src/pages/webpages/useBfMarks.ts:57:13
     55|             setState({ loading: false, error: null, data: body && body…
     56|         } catch (e) {
     57|             setState({ loading: false, error: (e as Error | null)?.mes…
       |             ^
     58|         }
     59|     }, [webpageId]);
 ❯ process.processTicksAndRejections node:internal/process/task_queues:103:5

This error originated in "src/pages/webpages/WebpageIDE.i18n.test.jsx" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
```
