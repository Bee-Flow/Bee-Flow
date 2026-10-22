# Wave 3 (paused): the last 432 agent-hub files

Paused on request. Everything below is in git; nothing lives only in /tmp.

## Where it stands

- Last green commit: `4c5dba38` (157 files TypeScript, every check green). It is also the BASE that
  still holds the JavaScript of every wave-3 file: compare against it, send back to it.
- On top: work-in-progress commits. All 432 remaining JavaScript source files of agent-hub/src are
  `.ts`/`.tsx` (tooling run: `scripts/ts-convert-codefix.mjs` with runtime observations), agents fixed
  part of the type errors. `npm run typecheck` is RED until the wave is finished.
- Per chunk (`chunks.json`, 14 chunks by path), at the pause:

| chunk | files | clean | errors left |
|---|---|---|---|
| 1 | 30 | 22 | 15 |
| 2 | 35 | 32 | 6 |
| 3 | 35 | 27 | 23 |
| 4 | 31 | 29 | 3 |
| 5 | 31 | 26 | 8 |
| 6 | 35 | 20 | 44 |
| 7 | 35 | 25 | 24 |
| 8 | 35 | 13 | 374 |
| 9 | 35 | 16 | 73 |
| 10 | 35 | 3 | 444 |
| 11 | 11 | 4 | 697 |
| 12 | 21 | 0 | 421 |
| 13 | 35 | 0 | 715 |
| 14 | 28 | 0 | 503 |
| **all** | **432** | **217** | **3350** |

Plus ~200 errors in 93 other TypeScript files, caused by the new types (an importer's call no longer
fits a now-typed prop): the "integration" step below fixes those.

- Fix agents (Sonnet, effort low) done: chunks 1-7. Stopped midway: 8-14 (their partial edits are in).
- Reviews of every code change done: chunks 1-4. Stopped midway: 5, 6, 7. Not started: 8-14.

## What is allowed in wave 3

Types first. Where types cannot do it, a minimal code change of exactly these kinds: a null/undefined
guard (`?.`, an early `if (!x) return;` that leaves the non-null path as it was), an explicit
conversion JavaScript already did (`String(n)`, `Number(s)`), Date arithmetic via `.getTime()`, or a
prop/name TypeScript proves wrong. Never refactors, changed arguments or conditions, new fallbacks,
moved or removed code. Forbidden always: `any`, `as unknown as`, assertions with `never`, `Function`,
ts-comments, non-null `!`, eslint-disable. Every code change is reviewed (see PROMPTS.md).

## How to resume

```
cd agent-hub && node ./node_modules/typescript-7/bin/tsc --noEmit --pretty false > /tmp/tsc.txt; cd ..
node .claude/handoff/ts-conversion/wave3/chunk.mjs 8 /tmp/wave3 /tmp/tsc.txt     # per chunk: errors -> /tmp/wave3/c3-8.json
```

1. Finish the fixes of chunks 8-14 (fix prompt in PROMPTS.md, one agent per chunk, at most ~5 at once:
   each runs the full typecheck through `tsc-locked.sh`, which serialises them).
2. Review every chunk 5-14 (review prompt in PROMPTS.md).
3. Integration: one pass over the errors that sit between chunks (a prop type in one chunk vs. the
   caller in another) and in the 93 other files.
4. Gate: `node scripts/ts-convert-gate.mjs --result <all 432 pairs> --base 4c5dba38 --changes-report changes.json --report back.json`
   keeps the green files and sends the rest back to the JavaScript of 4c5dba38.
5. Finish like waves 1-2: `scripts/ts-convert-references.mjs` (paths in tests, ci.yml, mobile lockstep
   tests), `scripts/ts-merge-type-imports.mjs`, `scripts/ts-remove-unused-imports.mjs`, import/order
   fix, `scripts/ts-move-types.mjs` for files over their line ceiling, `.tsx` without JSX to `.ts`,
   regenerate the editor bundles (`cd server && npm run build:editor-md && npm run build:editor-collab`:
   their inputs in agent-hub/src/editor were renamed), `npm run check:fast`, vitest on the tests that
   import a converted file, mobile jest on the suites that read agent-hub, ts-ratchet and eslint-budget
   `--update`.
6. When everything is done: delete `.claude/handoff/ts-conversion/` (README, SERVER.md, batches,
   wave3) and the comments in scripts that point to it.

## Real bugs found (not fixed by the conversion unless noted; worth their own small PRs)

- AgentChatView: a thread's parent object is passed as `sendMessage`'s `isHidden` argument, so every
  message sent in a thread is hidden. Left as is (behaviour), typed to match.
- RoadmapEditor: `Toggle` got `checked=` instead of `value=` (fixed in the review: the toggle shows its state).
- InputHtmlInspector: `hint` on `Toggle` (prop is `description`; fixed, the hint shows).
- AppFileGallery: read `mimeType`/`type` instead of `mime` (fixed, the type icon works).
- ActionFlowEditor: issues passed as strings, the tooltip read `.message` (fixed).
- AnswersDashboard: illustration `"EmptyInbox"` (valid: `"empty-inbox"`), and `totals` can be null in
  the stat tiles (guarded).
- QueryBuilder: reads `chrome?.openTables`, which no provider supplies (the "go to tables" link never shows).
- HeatmapSection reads `scrollReach.pageW` (never set); PerformanceSection's ref-line `label` is never drawn.
- AnswerTracePanel reads `row.ms` on rows without it; IncidentsPage passes a string id where the table
  types a number; IntegrationsAdminPanel passes a number setter where a string one is expected.
- PlaybookRun: `onClick={reload}` passes the click event as `reload`'s options.
- FollowUpTab / ChatModelsSection: a number passed to `.replace()` (works by coercion).
