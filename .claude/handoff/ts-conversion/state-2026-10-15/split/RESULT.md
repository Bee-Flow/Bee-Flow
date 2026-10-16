# Test run: origin/ts-int/staging @ 435a6068 (L-C + L-A round 1), by laptop L-A

Verdict: **FAIL** (agent-hub full vitest exits 1 on one unhandled rejection; every test passes; the failing file is green in isolation; the full run is not green, so the verdict stays FAIL).

Machine: 32 cores, 58 GB (shared; other sessions running). node 22.23.2, npm 10.9.8. node_modules from `npm ci` at 0ae29a17 (package-lock.json identical in root, agent-hub, mobile, server at 435a6068). Checks run one at a time; agent-hub/mobile behind tools/heavy.sh (HEAVY_SLOTS=2).

| Check | Command | Result |
|---|---|---|
| check:fast | `npm run check:fast` | 39 passed, 0 failed |
| server typecheck | `cd server && npm run typecheck` | 1076 files, no errors |
| duplication | `node scripts/duplication-ratchet.mjs` | production 15213 ≤ 15290; test 26228 = 26228 |
| gitleaks | `npm run lint:gitleaks` | no leaks |
| agent-hub typecheck | `cd agent-hub && npm run typecheck` | 0 errors |
| agent-hub vitest (full) | `cd agent-hub && npm run test:run -- --maxWorkers=8` | **rc=1**: 1858/1858 files, 21872/21872 tests pass, **1 unhandled error** (below) |
| agent-hub vitest (failing file, isolated, once) | `npx vitest run src/pages/webpages/WebpageIDE.i18n.test.jsx` | rc=0: 1 file, 4 tests pass, 0 errors |
| mobile tsc | `cd mobile && npx tsc --noEmit` | 0 errors |
| mobile jest | `./node_modules/.bin/jest --maxWorkers=4` | 762 suites, 13428 tests pass |
| server tests | `cd server && npm test` | 2587 files, 0 fail, 0 cancelled, 0 HUNG |

## The unhandled error
```
Unhandled Rejection: ReferenceError: window is not defined
 ❯ dispatchSetState react-dom-client.development.js:9512
 ❯ src/pages/webpages/useBfMarks.ts:57:13   setState({ loading: false, error: ... })
This error originated in "src/pages/webpages/WebpageIDE.i18n.test.jsx"
```
Seen in every full run on this machine (also on ts-laptop/sweep-a at 8b6dfa68, with --maxWorkers=4), never in isolation (4/4 runs green).

Root cause (read, not fixed: outside L-A scope): `WebpageIDE.i18n.test.jsx:33-37` mocks `useBfMarks` as an export of `./WebpageCodeStrip`, but `WebpageIDE.tsx:13` imports it from `./useBfMarks`. The mock never applies, so the REAL hook runs `api('/<id>/bindings')`; under load that request rejects after the test environment is torn down, and the catch's `setState` hits a dead jsdom. Suggested fix (test only):
```js
vi.mock('./useBfMarks', () => ({ useBfMarks: () => ({ loading: false, error: null, data: null }) }));
```
(and drop the dead `useBfMarks` key from the `./WebpageCodeStrip` mock). The shape matches `BfMarksState` in useBfMarks.ts.
