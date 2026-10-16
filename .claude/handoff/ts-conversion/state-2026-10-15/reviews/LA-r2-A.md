# Opus review LA-r2-A (la-r2-jsdoc 2c807f86 JSDoc / 72d392d0 dataBatchClient.ts, la-r2-forms 1df250f3; base 0ae29a17, round-2 base fd9f2a8a, merge-tested on la-int fdb5ec64): CHANGES REQUIRED

## Gate
- Types-only commits:
  - 72d392d0 (dataBatchClient): 1 identical / 0 different.
  - 1df250f3 (forms): 5 identical / 0 different.
  - 2c807f86 (JSDoc): no renamed files, so the gate does not see it (0 of 0). Checked by hand: `git diff -w 2c807f86~1 2c807f86` changes only `/** … */` lines and the two new `.types.ts` files. BindingField.jsx:792 replaces the `// ── main ──` divider with the JSDoc line, and cellValue.jsx:444 replaces a blank line. Both keep the files at their .file-budget.json ceilings (958 / 485).
- No catch-recipe commits in this round.
- No D/A pairs: `git diff --name-status -M40%` shows only R entries (R079 to R092) for all three commits.
- Merge test: la-r2-jsdoc and la-r2-forms merge on fdb5ec64 without conflicts.

## Forbidden constructs
- No literal any / as any / as unknown as / ts-ignore / expect-error / `!` / new eslint-disable / .d.ts shims / two statements on one line in either branch.
- **But `toValueList` smuggles an `any` (Fix 1).**
  - AppInputMultiselect.tsx:26 has no return type, and `Array.isArray(value)` on an `unknown` narrows it to `any[]`, so the exported function returns `any[]`.
  - Checked in the probe: `const n: number = toValueList(1)[0]; toValueList(1)[0].notAMethod();` compiles.
  - That `any` is what lets the unknown form values reach `key={v}`, `labelFor(v: string | number)`, `remove(v)` and `commit([...selected, v])`.
  - This is the same blocker the commit message gives for keeping the other inputs JS ("unknown form value into an input value").

## Fixes (numbered; file:line on the branch tips; all types-only or comment-only, gate-identical)
1. **AppInputMultiselect goes back to JS, byte-identical to fd9f2a8a** (la-r2-forms).
   - With an honest `toValueList(value: unknown): unknown[]` the probe shows 7 errors: :73 ×2, :74, :83 (`key`), :87, :88 ×2. Each one needs a runtime `String(v)`.
   - Steps:
     - `git mv …/runtime/components/AppInputMultiselect.tsx …/AppInputMultiselect.jsx`
     - `git checkout fd9f2a8a -- …/AppInputMultiselect.jsx`
   - Importers (formFields.test.jsx, formIntegrity.test.jsx, the registry) import it without an extension. No mobile or server test reads it by path. Nothing else changes.
   - Amend the commit message: "AppButton, AppForm, AppInputCheckbox and useInputChange …; AppInputMultiselect stays JS (an unknown form value becomes a React key and a label)".
2. **BindingField.types.ts:8: `BuiltView.chart` duplicates bi/ChartDataPanel.tsx `ChartMapping`/`ChartSeries` (one home).**
   - QueryBuilder.jsx:284 sends exactly `effectiveMapping` (a `ChartMapping`, from `deriveChartMapping` or ChartDataPanel's onChange) or null.
   - Add after :1 `import type { ChartMapping } from '../../bi/ChartDataPanel';`
   - :8 → `    chart?: ChartMapping | null;`
3. **cellValue.types.ts: three fields narrower than the data.**
   - :4 → `    align?: 'auto' | 'left' | 'right' | 'center';`
     - The spec enum is `['auto','left','right','center']`, default 'auto' (server analyticsSpecs.js:54, recordListSpecs.js:46).
     - `alignFor` handles 'auto' by falling through.
   - :13 → `    emptyTone?: string | null;`
     - The spec default is `null`.
     - The body reads `col?.emptyTone && ROLE_COLORS[…]`.
   - :35 → two lines:
     ```ts
         /** Read only after a `typeof row === 'object'` check. */
         row?: unknown;
     ```
     - Every read of `row` in cellValue.jsx (:64, :153, :402, :451, :453) is guarded by `row && typeof row === 'object'`.
     - `unknown` is honest, and it is what gridCells' EditableCell has (`row: unknown`, gridCells.tsx:177). Fix 6 needs it.
4. **gridColumnFilters.js `describeFilter`: the JSDoc contradicts itself and duplicates TranslateFn.**
   - The problem:
     - With `label?: unknown`, the 'select' branch (`hit?.label ?? String(value)`) does not return the promised `string`.
     - `kind` is declared `string`, but the body takes anything and GridChrome passes `string | null`.
     - `FilterTranslate` is a second spelling of hooks/useTranslation `TranslateFn`.
   - The label really is text: options come from facetValues (strings) or toneMap (`label: { type: 'string' }`, analyticsSpecs.js:95).
   - Comment-only changes:
     - Delete :25 ` * @typedef {(key: string, fallback: string, params?: Record<string, unknown>) => string} FilterTranslate`
     - :207 → ` * @param {string | null | undefined} kind A FilterKind. Decides the shape \`value\` must have; anything else is quoted as text.`
     - :210 → two lines:
       ```
        * @param {{ options?: ReadonlyArray<{ value: unknown, label?: string | null }> | null, locale?: string, t?: import('../../../../../../hooks/useTranslation').TranslateFn | null }} [opts]
        *   A 'select' chip shows the matching option's `label` as is, so it must be text.
       ```
5. **dataErrors.js:61: `isRateLimited`'s param is a weak type.**
   - `{ status?: unknown } | null | undefined` has only optional members, so a TS caller passing an `Error` (TanStack's retry `err`) gets TS2559 "no properties in common".
   - The body (`err?.status === 429`) accepts any value.
   - :61 → ` * @param {unknown} err Any thrown value; only an object's \`status\` is read.`
6. **Stale shims the JSDoc commit was written to retire (same kind as LA-r1-A Fix 2).** The commit message says the `= null` defaults "kept every TS caller JS". Two shims still restate those props. The fix keeps the alias and drops only the cast, so the compiled text is identical (checked with transpileModule, removeComments, isolatedModules).
   - a. ActionEffectEditors.tsx:36-46 (fdb5ec64) → two lines:
     ```ts
     // logic/ExpressionInput.jsx is still JavaScript; its JSDoc types the props.
     const Expression = ExpressionInput;
     ```
     Keep `import React, { useState }`: under isolatedModules TS keeps the default import, so dropping it would change the output.
   - b. gridCells.tsx:
     - :7-10 → two lines:
       ```ts
       // cellValue.jsx is still JavaScript; its JSDoc types the props.
       export const CellValue = CellValueJs;
       ```
       This drops an `as unknown as`.
     - :2 → `import type { KeyboardEvent } from 'react';`
     - Needs Fix 3's `row?: unknown`. Without it gridCells.tsx:240 errors (TS2322).
   - GridChrome.tsx:18 (`describeFilterJs as unknown as`) cannot go yet. GridColumnMeta.filterOptions is `unknown[] | null` and `f.value` is `unknown`, against Fix 4's typed options. That is a follow-up (below).
7. **resolveBinding.types.ts: `BindingFieldProps.onChange: (next: BindingInput) => void` promises shapes the field does not emit.**
   - BindingField.jsx's skeletonFor (:92-93) and selectDataset (:639) emit `datasetId: null` and `connectorId: null`.
   - Widen them (0 new errors; resolveBinding reads both defensively):
     - :36 → `    datasetId?: string | null;`
     - :48 → `    connectorId?: string | null;`
   - `actionId: null` (skeletonFor :94, the select at :928) is also emitted. Widening `ActionResultBinding.actionId` breaks resolveBinding.ts:366 (`actionState[binding.actionId]`, TS2538), and fixing that needs a runtime change. That is a follow-up.

Fixes 1-7 were checked together in the probe (merge of fdb5ec64 + both branches):
- typecheck: 0 errors
- gate-identical compiled output for every edited TS file
- Diff: /tmp/claude-1000/-home-tom-Projects-Bee-Flow/ea43414a-061f-49c2-9608-e64f103495c6/scratchpad/LA-r2-A-fixes.diff

## Accepted as is
- **JSDoc vs body and callers (2c807f86).** Every typedef was compared with its body and its callers. Apart from Fixes 2-5 and 7 they are honest:
  - ConditionField: `onChange?` (ConditionBuilder calls `onChange?.(…)`); `value: string | null`, which `parseExprToRows(unknown)` and `isTrivialValue` take.
  - ExpressionInputProps: every prop optional. It matches useExpressionEditing's `ExpressionEditingOptions` (`value?: string | null`, `onChange?`, `roots?: string[] | null`). `label` is used as an aria string. FormulaField spreads into it, which is honest.
  - BindingFieldProps:
    - `onChange` is required (`emit` calls it unguarded). The rest are optional, matching the defensive reads (`definition?.actions`).
    - `value: unknown` is right.
    - All BindingField callers are JS today.
  - CellColumn: every member the body reads (format, align, truncate, toneMap, toneFrom, tone, emptyTone, flagFrom, flagTone, subtextFrom, subtextToneFrom, labelFrom, badgeStyle, max) is optional. `toneMap` entries may be null (`m && …`). `now` is epoch ms (`now - then`).
  - gridColumnFilters: filterKindFor/canFacet/facetValues/isActiveFilter/makeFilterFn match their bodies. `GridFilterFn` with `autoRemove` is exact.
  - dataErrors: DataError's optional members are set only when truthy or finite. `makeDataError` and `dataErrorFromResponse` (a `Response` fits `res`) are honest.
- **Proof that TS reads the JSDoc.** With Fix 6 the TS callers (ActionEffectEditors, gridCells, useGridColumns, ComputedPropsEditor, ValidationRuleEditor, VisibilityControls, TableDesigner) typecheck against the JSDoc, not against the `= null` defaults.
- **dataBatchClient.ts (72d392d0).**
  - Shapes match server/appStudio/dataReadRunner.js runBatch (`{id, ok:true, data}` / `{id, ok:false, status, error}`) and appDataQuery.js:232 (`{ results, appVersion: publishedVersion ?? null }`). `code`/`provider` are optional and never sent for batch reads, which is harmless.
  - `res.json()` → `BatchBody` and `Array.isArray(body?.results)` → `any[]` elements in the local `byId` loop are the usual unchecked JSON, not exported (same as the bi hooks in LA-r1-A).
  - `subscribeBatchAvailability(): () => boolean` is runtime-true (`Set.delete`) and fits useSyncExternalStore.
  - `flush(appId: string)` inside the queueRead closure is fine: the `!appId` return guards it, and `appId` is a parameter that is never reassigned.
- **la-r2-forms (rest).**
  - `(node.style as NodeStyle).gap` (AppForm.tsx:286): a null removal guarded at the site by `Number.isFinite(node.style?.gap)` in the same ternary, the same as the accepted `SIZE_FONT[..] as string`.
  - `RuleProps.min/max?: number` read through `Number.isFinite`.
  - The ValidationRule / AppNode / NodeStyle / FormFieldMeta imports come from their homes (inspector/appDefinition.ts, the formContext.jsx JSDoc). NodeProps comes from appNode.types.ts.
  - `useInputChange(node: Pick<AppNode, 'onChange'> | null | undefined, …)`: runtime-true.
  - useActionRunner.appEffects.test.jsx:235 path updated (it reads AppForm by path).
- **One home.**
  - BatchRead / ReadResult / BatchAnswer, DataError and BindingFieldProps are new and unique.
  - CellColumn vs useGridColumns `GridColumn` / gridCells `GridColumnSpec`: the cell's read view against the grid's column config. Keep them, see follow-up 2.
- **Kept JS.** Every kept file is byte-identical to 0ae29a17 at both tips. The only .js/.jsx files that differ are the 7 JSDoc files and formContext.jsx (b2-B, already in fd9f2a8a). Reasons spot-checked:
  - AppInputText (`value={value ?? ''}` with an unknown value) and GridFilterControl (unknown TanStack value into `<select value>`): real blockers.
  - AiActionEditors: real. `writeTo.tableId` is read in handlers that are defined without a guard; only the rendered UI depends on `enabled`, which is an outer-scope guard.
  - **inputPanels: the stated reason is not a blocker.** `Number.isFinite(props.rows) ? (props.rows as number) : 4` is a null-removing cast guarded at the site, the accepted AppEditorContext `(d as number)` pattern. It is a follow-up candidate if nothing else in the file blocks.

## Follow-ups (not blocking)
1. GridChrome.tsx:18: type `GridColumnMeta.filterOptions` as `Array<{ value: unknown; label?: string | null }> | null` along the useGridColumns filterMeta chain, then drop the `describeFilterJs as unknown as` shim. `f.value` (unknown) needs Fix 4's `value` to accept `unknown`; the body tolerates it because isActiveFilter runs first.
2. Make useGridColumns `GridColumn` extend `CellColumn` and drop its duplicate `format`/`truncate`/`toneMap`.
3. `ActionResultBinding.actionId: string | null` together with a guarded read at resolveBinding.ts:366 (behaviour commit plus test).
4. server/appStudio/readError.js:25 comment still says `runtime/dataBatchClient.js`.
5. inputPanels.jsx: reconvert with the guarded cast.
6. Nit: the new `@param` blocks sit between an existing description JSDoc and the function (ExpressionInput, FormulaField, gridColumnFilters ×5, dataErrors ×3). TS reads both blocks; the drafter brief's placement rule is for TS types. Merging each into the block above saves a line apiece if a budget gets tight.

## Checks run (merge of fdb5ec64 + la-r2-jsdoc + la-r2-forms, in /home/tom/Projects/bee-flow-la-wt/review-r2-A)
- agent-hub typecheck (heavy.sh, HEAVY_SLOTS=2): 0 errors without the fixes; 0 errors with Fixes 1-7 (1m56s).
- eslint on the 18 touched files: 0 errors, 38 warnings (complexity/length on existing functions; none from unused imports).
- vitest `runtime`, `inspector` and `bi` dirs with the fixes: 156 files, 1968 tests pass.
- mobile jest: no mobile or server test reads a changed path (grep of mobile/src and server for the basenames with extensions: only the readError.js comment), so there was nothing to run.
- duplication-ratchet: ✅ production 15088 / budget 15290; test 26228 at budget.
- file-budget agent-hub: ✅ none past its ceiling.

## Merge order
1. Amend 1df250f3 with Fix 1.
2. Add one `fix(ts)` commit on la-r2-jsdoc with Fixes 2-7 (or amend 2c807f86 for 2-5 and 7, and put 6 on top since it edits la-int files).
3. Merge both on la-int, then typecheck and run the runtime, inspector and bi vitest dirs.
