# L-T result

- **Tested commit:** `177babc8d8fbe2404f651dc71b5805a297addcca` (merge(ts): laptop L-C round 1 (utils/lib, shared, editor, meeting-notes: 43 files), Opus-reviewed)
- **Result:** FAIL
- **Run:** 2026-10-16T09:08:23+02:00 → 2026-10-16T09:14:29+02:00, node v22.23.2, 32 cores
- **Installs:** root: unchanged lock, kept; server: unchanged lock, kept; agent-hub: unchanged lock, kept; mobile: unchanged lock, kept

| Check | Command | Status | Counts | Time |
|---|---|---|---|---|
| check-fast | `npm run check:fast` | PASS | check:fast: 39 gate(s), up to 32 at a time<br>check:fast: 39 passed, 0 skipped, 0 failed in 14.2 s | 14 s |
| lint-budget | `npm run lint:budget` | PASS | ✅ agent-hub: 4763 warnings, under the budget of 6674. Run `node scripts/eslint-budget.mjs agent-hub --update` to lower it.<br>➖ server: 0 warnings, at budget | 278 s |
| server-typecheck | `cd server && npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 83 s |
| duplication | `node scripts/duplication-ratchet.mjs` | PASS | ✅ production: 15225 duplicated lines, under the budget of 15290. Run `node scripts/duplication-ratchet.mjs --update` to lower it.<br>➖ test: 26228 duplicated lines, at budget | 4 s |
| gitleaks | `npm run lint:gitleaks` | PASS | ✓ gitleaks: no leaks in tracked files | 8 s |
| ah-typecheck | `agent-hub: npm run typecheck` | PASS | 0 error TS line(s) in 0 file(s) | 273 s |
| ah-vitest | `agent-hub: npm run test:run` | FAIL (exit 1) | Test files: 4 failed \| 1854 passed (1858)<br>Tests: 5 failed \| 21867 passed \| 0 skipped/todo (21872) | 305 s |
| mobile-tsc | `mobile: npx tsc --noEmit` | PASS | 0 error TS line(s) in 0 file(s) | 123 s |
| mobile-jest | `mobile: jest --ci (full)` | PASS | Test files: 0 failed \| 762 passed (762)<br>Tests: 0 failed \| 13428 passed \| 0 skipped/todo (13428) | 138 s |
| server-test | `cd server && npm test` | PASS | # tests 29089 · # pass 29058 · # fail 0 · # cancelled 0 · # skipped 29 · # todo 2 · # files 2587 | 171 s |

## L-T note: isolated rerun of the failing vitest files

The verdict above is the full run's. Rerunning only the 4 failing files on the same commit
(`npx vitest run src/demo/ComplianceDemo.test.tsx src/demo/DemoHost.test.jsx src/components/projects/workspace/chat/ProjectTeamChat.reading.test.tsx src/components/automation/Builder/flow/settings/actionEditors/codeFields.test.jsx`):
**Test Files 4 passed (4), Tests 83 passed (83).** The failures (Loading… never resolving, a 20 s timeout, then a
leftover textbox) look load-sensitive under the full parallel suite rather than deterministic; the same files passed
in a full run on origin/main 77c40ea. Treat as flaky-under-load until a later full run confirms either way.

## Failures (5)

### ah-vitest: agent-hub/src/demo/ComplianceDemo.test.tsx > the Compliance demo, section by section has a fixture for every route the rail and the header tabs lead to

```
AssertionError: expected null not to be null

Ignored nodes: comments, script, style
<html
  data-theme="light"
>
  <head />
  <body>
    <div>
      <div
        class="demo-host h-[100dvh] flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden"
        data-demo-feature="compliance"
      >
        <div
          class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        >
          <div
            class="p-6 text-sm text-[var(--text-secondary)]"
          >
            Loading…
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
    at timeout (/home/tom/bee-flow-lt/agent-hub/src/demo/ComplianceDemo.test.tsx:54:101)
    at runWithExpensiveErrorDiagnosticsDisabled (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/config.js:47:12)
    at checkCallback (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/wait-for.js:124:77)
    at Timeout.checkRealTimersCallback (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/wait-for.js:118:16)
```

### ah-vitest: agent-hub/src/demo/DemoHost.test.jsx > the demo route automations renders its sample data without crashing

```
AssertionError: expected 'Loading…' to contain 'Weekly AI/SaaS spend report'

Ignored nodes: comments, script, style
<html
  data-theme="light"
>
  <head />
  <body>
    <div>
      <div
        class="demo-host h-[100dvh] flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden"
        data-demo-feature="automations"
      >
        <div
          class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        >
          <div
            class="p-6 text-sm text-[var(--text-secondary)]"
          >
            Loading…
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
    at timeout (/home/tom/bee-flow-lt/agent-hub/src/demo/DemoHost.test.jsx:109:53)
    at runWithExpensiveErrorDiagnosticsDisabled (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/config.js:47:12)
    at checkCallback (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/wait-for.js:124:77)
    at Timeout.checkRealTimersCallback (/home/tom/bee-flow-lt/agent-hub/node_modules/@testing-library/dom/dist/wait-for.js:118:16)
```

### ah-vitest: agent-hub/src/components/projects/workspace/chat/ProjectTeamChat.reading.test.tsx > says the thread start could not be loaded, instead of an empty panel, and retries

```
Error: Unable to find role="alert"

Ignored nodes: comments, script, style
<body>
  <div>
    <div
      class="relative h-full flex min-h-0 bg-[var(--bg-primary)]"
      data-testid="project-team-chat"
    >
      <div
        class="flex-1 min-w-0 flex flex-col min-h-0"
      >
        <div
          class="@container/objhead flex items-center gap-x-2.5 px-3 h-12 flex-nowrap min-w-0 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]"
          data-testid="team-chat-header"
        >
          <button
            aria-label="Back to chats"
            class="grid place-items-center w-8 h-8 rounded-lg flex-shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition"
            data-testid="studio-section-back"
            title="Back to chats"
            type="button"
          >
            <svg
              aria-hidden="true"
              class="lucide lucide-arrow-left"
              fill="none"
              height="16"
              stroke="currentColor"
              stroke-linecap="round"
```

### ah-vitest: agent-hub/src/components/automation/Builder/flow/settings/actionEditors/codeFields.test.jsx > there is always a box to type code into uses the real editor when the chunk is there, and edits reach the draft

```
Error: Test timed out in 20000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
    at task (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2692:43)
    at Object.<anonymous> (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2709:16)
    at Object.<anonymous> (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2482:28)
    at chain (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1870:14)
    at /home/tom/bee-flow-lt/agent-hub/src/components/automation/Builder/flow/settings/actionEditors/codeFields.test.jsx:130:5
    at file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2774:52
    at runWithSuite (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:3263:8)
    at Object.collect (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2774:22)
    at Object.collect (file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:2779:51)
    at async file:///home/tom/bee-flow-lt/agent-hub/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:3464:26
```

### ah-vitest: agent-hub/src/components/automation/Builder/flow/settings/actionEditors/codeFields.test.jsx > there is always a box to type code into BITES — a missing Monaco chunk leaves a working textarea, not an empty panel

```
TestingLibraryElementError: Found multiple elements with the role "textbox" and name `/javascript code/i`

Here are the matching elements:

Ignored nodes: comments, script, style
<textarea
  aria-label="JavaScript code"
  class="rounded-md border bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-colors border-[color-mix(in_srgb,var(--text-secondary)_70%,transparent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus-visible:border-[var(--accent-primary-hover)] w-full px-2 py-1.5 text-sm resize-y font-mono "
  rows="14"
  spellcheck="false"
>
  return 1;
</textarea>

Ignored nodes: comments, script, style
<textarea
  aria-label="JavaScript code"
  class="rounded-md border bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-colors border-[color-mix(in_srgb,var(--text-secondary)_70%,transparent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus-visible:border-[var(--accent-primary-hover)] w-full px-2 py-1.5 text-sm resize-y font-mono "
  rows="14"
  spellcheck="false"
>
  return 1;
</textarea>

(If this is intentional, then use the `*AllBy*` variant of the query (like `queryAllByText`, `getAllByText`, or `findAllByText`)).

Ignored nodes: comments, script, style
<body>
  <div>
    <div
```
