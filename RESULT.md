# L-T result

- **Tested commit:** `fe16bc36bafb107eeb8314777a2110276cc095a6` (merge(ts): laptop L-C round 3, Opus-reviewed)
- **Result:** FAIL
- **Run:** 2026-10-16T10:46:38+02:00 → 2026-10-16T10:53:48+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept
- **Order:** typechecks + lint in parallel first; then the full suites one at a time: agent-hub vitest (--maxWorkers=8), mobile jest, server npm test

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 2.8 s | 3 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4683 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 50 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 15 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15144 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26228 duplicated lines, at budget | 3 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 6 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 63 s |
| ah-vitest | `agent-hub: npm run test:run` | FAIL (exit 1) | Test files: 1 failed \| 1857 passed (1858)<br>Tests: 1 failed \| 21871 passed \| 0 skipped/todo (21872) | 239 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 14 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 26 s |
| server-test | `cd server && npm test` | PASS | # tests 29089 · # pass 29058 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2587 | 102 s |

## L-T note: one intermittent test, not touched by this round

Suites ran one at a time (vitest --maxWorkers=8), so this is not cross-suite load.
`AgentStudio.characterisation.test.tsx > a deep link opens that agent once the list has loaded` failed with
`onNavigate` called 0 times. On the same commit in isolation the file passed 26/26 three times in a row.
Nothing under `agent-hub/src/components/agents/AgentStudio/` changed in c02cb12a..fe16bc36 (this round is App Studio).
Likely cause, from reading the test (line 251-252): it asserts `expect(onNavigate).toHaveBeenCalledWith(...)` synchronously
right after `findByTestId('split')` resolves, so if the navigate call lands in an effect after the split renders, the
assertion races; wrapping it in `await waitFor(...)` would remove the race. Not verified beyond the 3 isolated passes.

## Failures (1)

### ah-vitest: agent-hub/src/components/agents/AgentStudio/AgentStudio.characterisation.test.tsx > AgentStudio — deep links, publishing and deleting from the editor a deep link opens that agent once the list has loaded

```
AssertionError: expected "vi.fn()" to be called with arguments: [ 'studio/agents/agent-2' ]

Number of calls: 0

    at Proxy.<anonymous> (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2249:10)
    at Proxy.<anonymous> (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:1958:14)
    at Proxy.methodWrapper (file:///home/tom/bee-flow-lt/agent-hub/node_modules/chai/index.js:1737:25)
    at /home/tom/bee-flow-lt/agent-hub/src/components/agents/AgentStudio/AgentStudio.characterisation.test.tsx:253:28
    at async file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2794:20
```
