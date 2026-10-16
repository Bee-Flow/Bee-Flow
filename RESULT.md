# L-T result

- **Tested commit:** `cfb10394c2540fb1a67a74b831674ffc2fecd4ce` (test(agent-hub): mock useBfMarks where WebpageIDE imports it)
- **Result:** FAIL
- **Run:** 2026-10-16T09:26:42+02:00 → 2026-10-16T09:33:10+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 12.6 s | 13 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4750 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 237 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 80 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15213 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26228 duplicated lines, at budget | 4 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 7 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 246 s |
| ah-vitest | `agent-hub: npm run test:run` | PASS | Test files: 0 failed \| 1858 passed (1858)<br>Tests: 0 failed \| 21872 passed \| 0 skipped/todo (21872) | 298 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 77 s |
| mobile-jest | `mobile: jest --ci (full)` | FAIL (exit 1) | Test files: 1 failed \| 761 passed (762)<br>Tests: 1 failed \| 13427 passed \| 0 skipped/todo (13428) | 71 s |
| server-test | `cd server && npm test` | PASS | # tests 29089 · # pass 29058 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2587 | 137 s |

## L-T note: the one failure is a load timeout in a file this commit does not touch

- The agent-hub unhandled rejection from 435a6068 is gone: vitest 21872/21872, 0 errors.
- mobile-jest: `Markdown.test.tsx > draws every prefix of a streaming answer...` hit jest's default 5000 ms
  timeout during the full run. This commit only changes `agent-hub/src/pages/webpages/WebpageIDE.i18n.test.jsx`.
  On the same commit in isolation: the file passed 20/20 three times, and that test took 449 ms. That is more
  than 10x slower under the full parallel load (jest, vitest, server tests and tsc together on 32 cores).
  It passed in all three earlier full runs. Flaky under load; a larger per-test timeout or a cheaper loop
  would make it robust.

## Failures (1)

### mobile-jest: mobile/src/shared/markdown/Markdown.test.tsx > Markdown draws every prefix of a streaming answer exactly as a single pass does

```
Error: thrown: "Exceeded timeout of 5000 ms for a test.
Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."
    at _getError (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1985:12)
    at Array.map (<anonymous>)
    at makeSingleTestResult (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1915:38)
    at makeTestResults (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1945:26)
    at makeRunResult (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:1876:18)
    at run (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:797:35)
    at runAndTransformResultsToJestFormat (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:2300:21)
    at jestAdapter (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/runner.js:111:19)
    at runTestInternal (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:247:16)
    at runTest (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:315:7)
    at Object.worker (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:479:12)

[cause]: Error: thrown: "Exceeded timeout of 5000 ms for a test.
Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."
    at it (/home/tom/bee-flow-lt/mobile/src/shared/markdown/Markdown.test.tsx:147:5)
    at _dispatchDescribe (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:626:26)
    at describe (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/jestAdapterInit.js:594:44)
    at Object.describe (/home/tom/bee-flow-lt/mobile/src/shared/markdown/Markdown.test.tsx:129:1)
    at ModuleExecutor.exec (/home/tom/bee-flow-lt/mobile/node_modules/jest-runtime/build/index.js:3055:26)
    at CjsLoader.loadModule (/home/tom/bee-flow-lt/mobile/node_modules/jest-runtime/build/index.js:440:36)
    at CjsLoader.requireModule (/home/tom/bee-flow-lt/mobile/node_modules/jest-runtime/build/index.js:335:12)
    at Runtime.requireModule (/home/tom/bee-flow-lt/mobile/node_modules/jest-runtime/build/index.js:4981:27)
    at jestAdapter (/home/tom/bee-flow-lt/mobile/node_modules/jest-circus/build/runner.js:96:13)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at runTestInternal (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:247:16)
    at runTest (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:315:7)
    at Object.worker (/home/tom/bee-flow-lt/mobile/node_modules/jest-runner/build/testWorker.js:479:12)
```
