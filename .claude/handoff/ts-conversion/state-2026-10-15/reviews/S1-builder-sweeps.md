# Opus review S1 Builder sweeps A+B + retries — CHANGES REQUIRED

Everything required below is types only or a move of a type declaration. The gate stays as it is, and nothing needs to go back to JS.

## What I checked
- **Merge test (sweepint, 359bc187).**
  - `heavy.sh npm run typecheck` in agent-hub: exit 0, **0 errors**. The personaFacts break is fixed by 23f88adf.
  - Gate: `node scripts/ts-equivalence.mjs 81d6bedfc HEAD` gives `289 identical, 10 different of 299 converted files`.
  - The 10 DIFFERENT files are useAgentApi, AgentEditorBootstrapContext, BuilderConfigPanel, builderSplitActions, refineActions, useKnowledgeBases, FilesUploadModal, useAgentAutosave and ScheduleBuilder (the 9 already integrated), plus HttpAuthPicker. That is as expected.
  - I read the `--diff` output: every changed line is a recipe substitution (`messageOf`, `isAbortError`, …) plus its import. So the type commits 2235a5b5, 22522c3e, 43732bf8, c76a7f22 and 1f7cffce are all 0 different.
- **Mobile.** `cd mobile && heavy.sh ./node_modules/.bin/jest outline canvas editorWords params trigger palette run route`: 79 suites and 1179 tests pass.
  - The lockstep edits are minimal and correct: path renames, plus the `(?:: [^=]+)?` regex for a typed `const X: T = {` in trigger.lockstep:70,77.
  - palette.lockstep's `jest.mock` specifier has no extension, so it needed no change.
- **Forbidden constructs.** None written: no `any`, `as unknown as`, `@ts-*`, `!` or new eslint-disable. c76a7f22 even removes an `as unknown as` (BuilderTabPanels SkillsCard).
- **API shapes against the server.**
  - `HttpConnection` is an honest subset of `shapeConnection` (server/stores/integrationConnectionStore.js:126-143). `access` is added only by `includeShared` (:632-633). POST returns `{ connection }` (routes/integrations/connections.js:427).
  - previewSchedule `{ valid, error, next }` matches routes/automation/runs.js:338+.
  - `AutomationSummary extends CallableAutomation` is honest. GET /api/automation (crud.js:213) returns `projectForViewer` rows, which spread the whole automation (`definition` and `triggerType` included; automation/access.js:206), and a `run` role keeps `definition.trigger(s)`.
- **One home per shape.**
  - `HttpConnection` is a raw row. `ConnectionOption` (stageSettingsApi.ts:115) is a normalized projection with a required label, so they are different shapes and both are fine.
  - `focusField.types.ts` is the first concrete home. The existing sites use `unknown` or `(handle: unknown) => void`.
  - Two real duplicates turned up: fixes 2 and 3.

## KEY QUESTION: function-type casts on JS helpers
**Verdict: acceptable when the asserted parameter types are ones the JS body handles. Not acceptable when the asserted type smuggles in `any`.**

- **`(humanizeExpression as HumanizeExpression)(…)` (Guard, Loop, Tokenize, Untokenize): OK.**
  - tsc-probed: the JS signature is inferred as `(expr: any, stepLabelById?: null) => string`.
  - The body handles exactly the asserted wider input: `!expr || typeof expr !== 'string'` and `stepLabelById?.get?.(stepId) || stepId` (displayHelpers.js:73-94).
  - This is an honest widening of an inferred `null`, the same pattern approved in wave1 b02 #3 (DescribeActionFn/ResolveTargetFn) and already on the branch (runIo.ts:128, AppRefBreadcrumb.tsx:51).
  - The value is not asserted to a type it lacks: at runtime the function does have that type.
- **TriggerNode `appRefDisplay` cast: the widening of `ref` from `null` to the AppRef shape is fine**, because the body does `ref || {}` and then reads properties.
  - But `ReturnType<typeof useAppRefLabel>` is **`any`** (tsc-probed: `useState(() => fresh(key))` over an untyped `Map`).
  - So `AppRefPlace`'s `record` prop and the cast's first parameter are an `any` under another name. That is fix 1. The sibling AppRefBreadcrumb.tsx:51 already does it right with `unknown` and `AppRef | null`.
- No file needs to go back to JS ("blocked by flow/displayHelpers.js" is not needed).

## Required fixes
1. **TriggerNode.tsx: no `any` through `ReturnType` of a JS hook.**
   - Add the import `import type { AppRef } from '../../../../admin/Studio/AppStudio/inspector/appDefinition';`
   - :240 → `function AppRefPlace({ record, appRef, t }: { record: unknown; appRef: AppRef | null; t: TFn }) {`
   - :242 → `const d = (appRefDisplay as (record: unknown, ref?: AppRef | null) => ReturnType<typeof appRefDisplay>)(record, appRef);`
   - This is the same shape as AppRefBreadcrumb.tsx:51. `record === undefined` still narrows, and `triggerAppRef` returns `{appId,screenId,nodeId} | null`, which is assignable to `AppRef | null`.
2. **One home for the app-event filter.** nodeProps.ts:49-78 `AppEventFilter` (from 699e9561) and the new triggerFilters.types.ts:5 `TriggerFilterValues` describe the same stored object (`draft.filter`, which buildPatch writes to `step.appEvent.filter`).
   - In `TriggerFilterValues`, add `cc?: string;`, `labelIds?: string[];` and a final `[key: string]: unknown;` (the server owns the schema, as the nodeProps header says).
   - In nodeProps.ts, replace the `AppEventFilter` interface (:49-78) with `import type { TriggerFilterValues } from '../settings/triggerFilters.types';` (at the top) and `export type AppEventFilter = TriggerFilterValues;`.
   - TriggerNode.tsx:373 → `function truncate(s: unknown, n: number): string {`.
     - `calendarId` really is `string | number`: the Nextcloud calendar form stores `Number(...)` (triggerFilters.tsx:473). The old `AppEventFilter.calendarId: string` was too narrow.
     - The body is `String(s ?? '')`, so the type stays honest.
   - Typecheck after the change.
3. **`TriggerAutomation` (triggerEditors.types.ts:27-38) duplicates FormTriggerFields.tsx:33-48 `PersistedTrigger` + `UrlPanelAutomation`** field for field, and TriggerFields passes the same object into it (triggerEditors.tsx:101).
   - In FormTriggerFields.tsx, delete :33-48 and add `import type { TriggerAutomation } from './triggerEditors.types';`.
   - Replace `UrlPanelAutomation` with `TriggerAutomation` at :60, :119 and :180. The import is type-only, so it is outside the SCC graph.
4. **New types between a JSDoc block and its function** (brief: "New types go ABOVE a function's JSDoc block"). The component doc now attaches to an interface.
   - ScheduleBuilder.tsx (43732bf8): move `ScheduleBuilderProps` and `PreviewState` (:31-41) above the `/** Visual schedule builder…` block (:16).
   - SkillsCard.tsx (c76a7f22): move `SkillCardRow` and `SkillsCardProps` (:33-44) above the `/** De Skills-kaart…` block (:11).
   - BuilderConfigPanel.tsx (fe56baec): move `OpenSetter` and `BuilderConfigPanelProps` (:30-79) above the `/** De ROL-tab…` block (:19).

## Nits
1. Give `HumanizeExpression` one home: runIo.ts:128 → `const humanizeExpression = humanizeExpressionJs as HumanizeExpression;` (import the type from `../flow/nodes/nodeProps`), if `LabelMap` is `Map<string, string> | null | undefined`.
   - Follow-up for the coordinator: a JSDoc `@param {Map<string, string>|null} [stepLabelById]` on displayHelpers.js:73 is a comment-only, gate-neutral edit. It would remove all five casts.
2. TriggerNode.tsx:92 → `let sub: React.ReactNode | SummaryText = null;` (import `SummaryText` from `./nodeProps`).
3. Restore three removed blank lines:
   - between imports and code at triggerEditors.tsx:19-20 and triggerFilters.tsx:8-9;
   - useAutomationApi.ts:5, between `import type { HttpConnection }` and the JSDoc.
   - The useAgentApi.ts blank-line removals in 1f7cffce are a budget fix, as the commit says. They are OK.
4. useAutomationApi.types.ts: `access?: 'own' | 'lent';` (store :632-633).
5. SetOperationsEditor.tsx:14 `EditableOp`: `start?: number | ''` describes a field of the stored op. It could live on `SetOperation` (setOperations.ts:21) instead of a local intersection. Optional.
6. Some card row types inherit inferred `any` from JS producers (tsc-probed): `KbCardRow` (name, lastContentAt), `TableCardRow` (name), `SkillCardRow` (name, icon, stepCount, ruleCount) and `AutomationCardRow` (name, confirm).
   - They are not written `any`, and they become real when canUseFacts.js and toolGrants.js convert. Put them on the phase-2 list beside "AgentSkillsTab: tighten Skill.name".
7. useRenderedGraph.ts:259 still carries casts written for the old JS `identityColorForEdge`. `srcRun as object | undefined` even drops `null`, which the new signature accepts.
   - Follow-up: `identityColorForEdge(e.data, edgeColorMode, srcRun, piiGroupColors)`, plus `groups?: Record<string, unknown> | null` on `PiiRunRow.piiSummary` (:19). Typecheck first. The weak-type check on `piiSummary` is why `groups` must be added.
8. 43732bf8 does not typecheck on its own (ScheduleBuilder `e.message` until c4c8b5e1). The commit says so. That is fine for this pair, but squash it next time so bisect stays clean.
9. BuilderConfigPanel's behaviour note is correct. The untranslated fallback 'Failed to create skill' matches skills.ts:80 and SkillsPopover.jsx:164.
10. Out of scope, pre-existing: FormTriggerFields.tsx:180 `(automation as UrlPanelAutomation).id as string` is a null-removing cast inside an async handler. Leave a phase-2 note.

## Merge notes
- Apply fixes 1-4 in one commit on top of 359bc187 (or on sweep-b and builder/agents-int): `fix(ts): S1 builder sweeps + retries review`.
  - Then run the agent-hub typecheck, eslint on the touched files and the gate. Expect the same 10 DIFFERENT files: fix 4 only moves declarations.
  - Then rerun `cd mobile && ./node_modules/.bin/jest outline trigger canvas`. TriggerNode and the filters are read by source text, and the regexes do not touch the changed lines.
- Kept-JS: the sweep commit messages list no kept-JS files, and none of the three sweep commits modifies a `.js`/`.jsx` file (checked with `git show --stat`). The retry labels in c76a7f22 are plausible (each names a blocker or a runtime construct), but I did not re-prove them one by one.
- After fixes 1-4, sweep-b (2235a5b5, 22522c3e, 95d84105) and the retries (43732bf8, c4c8b5e1, c76a7f22, fe56baec, 1f7cffce, 23f88adf) are approved for the convert branch.
