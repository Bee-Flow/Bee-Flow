# L-T result

- **Tested commit:** `060da5ca21fda3a0f8d0d8127d1ce022a26a91d2` (fix(forms): public form routes keep the sentence visitors read on an unexpected failure)
- **Result:** FAIL
- **Run:** 2026-10-16T12:16:15+02:00 → 2026-10-16T12:25:17+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** typechecks + lint in parallel first; then the full suites one at a time: agent-hub vitest (--maxWorkers=8), mobile jest, server npm test

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 6.6 s | 7 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4589 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 79 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 31 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15165 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>✅ test: 26188 duplicated lines, under the budget of 26228. Run `node scripts/duplication-ratchet.mjs --update` to lower it. | 3 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 7 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 98 s |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1864 passed (1864)<br>Tests: 0 failed \| 22004 passed \| 0 skipped/todo (22004) | 335 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 27 s |
| mobile-jest | `mobile: jest --ci (full)` | FAIL (exit 1) | Test files: 1 failed \| 761 passed (762)<br>Tests: 1 failed \| 13427 passed \| 0 skipped/todo (13428) | 23 s |
| server-test | `cd server && npm test` | PASS | # tests 29132 · # pass 29101 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2593 | 86 s |

## L-T note: deterministic, introduced by 060da5ca; the server response itself looks unchanged

- Bisected over 30bc20fd..060da5ca with `jest src/features/forms/api/serverShapes.lockstep.test.ts`:
  1e42bfe1, c0413774, f5349a4c pass 4/4; **060da5ca fails 1/4** (fails the same way in isolation, not flaky).
- Cause: the lockstep test reads the server SOURCE. Its `handler()` (`mobile/src/features/forms/api/serverShapes.lockstep.test.ts:48`)
  finds a route's handler by a registration line ending in `, <name>);`. 060da5ca changed
  `server/routes/automation/formPublic/page.js` to `router.get('/form/:token', ..., friendly(renderForm, 'form_load_failed', 'Could not load this form'));`,
  so the regex no longer matches, it falls back to the inline slice (just that line), and reports
  `multiPage`, `csrf`, `issuedAt` (and `form`) as missing. `renderForm` itself is not changed by 060da5ca.
- The `/upload` and `/pick` registrations are wrapped the same way and will fail the same test's next two
  `expect`s once the first is fixed (jest stops at the first). Other formPublic files touched by 060da5ca
  (results.js, session.js, submit.js) may affect other lockstep lines too.
- Either the test's `handler()` must see through `friendly(<name>, ...)`, or the registrations must keep the handler
  name in the position it expects. That is a code decision for the integrator; L-T changes nothing.

## Failures (1)

### mobile-jest: mobile/src/features/forms/api/serverShapes.lockstep.test.ts > still answers filling a form in with the shapes the phone reads

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 5

- Array []
+ Array [
+   "multiPage",
+   "csrf",
+   "issuedAt",
+ ]
    at Object.toEqual (/home/tom/bee-flow-lt/mobile/src/features/forms/api/serverShapes.lockstep.test.ts:102:114)
    at Promise.finally.completed (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1834:28)
    at new Promise (<anonymous>)
    at callAsyncCircusFn (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1774:10)
    at _callCircusTest (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1167:40)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at _runTestInContext (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1103:3)
    at runTestWithContext (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:996:5)
    at _runTestsForDescribeBlockOnce (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1008:11)
    at _runTestsForDescribeBlock (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:824:5)
    at run (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:789:3)
    at runAndTransformResultsToJestFormat (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:2300:21)
    at jestAdapter (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/runner.js:111:19)
    at runTestInternal (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:247:16)
    at runTest (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:315:7)
    at Object.worker (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:479:12)
```
