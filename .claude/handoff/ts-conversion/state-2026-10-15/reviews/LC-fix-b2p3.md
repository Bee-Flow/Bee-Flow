# Opus review L-C fix-b2p3 (B2 part 3: stale `as unknown as` shims whose target is TS): CHANGES REQUIRED (small: stale comments, dead imports, dead second-home shapes); the type work itself is honest and the compiled JS is identical
Base 075904b9 (= origin/ts-int/staging). Head aee23dc4 = a23adc1c (group A) + 04743747 (group B). I verified in a scratch worktree at aee23dc4 with the fixes applied, then removed it.

## Compiled-JS gate (every changed .ts/.tsx, `compile` from scripts/ts-equivalence.mjs)
- Script: scratchpad/b2p3-eq.mjs (`node b2p3-eq.mjs <base> <head>`).
- 075904b9 → aee23dc4: **76 identical, 0 different of 76**.
  - a23adc1c alone: 56/56. 04743747 alone: 20/20.
- aee23dc4 → aee23dc4+fixes (scratchpad/b2p3-eqwt.mjs): **24 identical, 0 different of 24**. The fixes change no runtime.

## Numbers
- 114 sites listed in b2p3-ts.txt: 111 shims removed and 3 kept.
- Group A: 55 removed, not the "56 of 58" the commit message says. 58 sites minus 3 kept is 55, and the diff removes 55 `as unknown as` lines.
- Group B: 56 removed.
- No `as unknown as` is added anywhere.
- Classifier after the fixes: TS 3 (the 3 kept shims), JS 72, OTHER 30.

## Fixes (verified diff: scratchpad/reviews/LC-fix-b2p3-fixes.diff, 24 files, 25+/112−, applies to aee23dc4)
1. **Comments that still give a JS reason for a shim that is gone.** Group B left almost all of them standing.
   - Deleted:
     - headerParts.tsx:28, FindingDecision.tsx:14, IncidentReporting.tsx:8, RopaScc.tsx:23, ObjectiveDrawer.tsx:22
     - registerSpecs.tsx:41 ("StatusPill is .jsx"), MemberColorPicker.tsx:11, TeamChatHeader.tsx:24, sprintUi.tsx:17, taskDialogParts.tsx:9
   - DpiaDrawer.tsx: the ".jsx/.js exports" line moves to the one cast left, `useResource` (data/useResource.js is still JS).
   - RunsTab.tsx: the "ExecutionView is plain JS" comment sat above `useRunStream`. It now sits above `ExecutionView`.
   - appIcon.ts docblock: "AppIcon is plain JS behind a forwardRef" is replaced.
   - tasksMenu.tsx: "The shared AnchoredMenu, typed:" becomes "The shared AnchoredMenu:".
   - typedShared.ts / studioParts.ts headers: both said "still plain JavaScript".
     - typedShared.ts: the header is rewritten. It wraps only DataTable, which is TS now.
     - studioParts.ts: the header now names the two that are still JS (StudioSectionHeader.jsx, DangerZone.jsx).
2. **Second-home shapes that only the removed casts used** (one home per shape):
   - typedShared.ts: `DataTableProps`, `TableRowProps` and `TableCellProps` are deleted (DataTable.tsx has its own).
     - `TableColumn` becomes `export type { TableColumn } from '../../../shared/DataTable'`.
     - The local copy was narrower (`label` required, `foldBelow: 1180 | 900`). Both content tables still typecheck.
   - studioParts.ts: `FilterPillOption` / `FilterPillsProps` are deleted (FilterPills.tsx exports both). Nothing imported them.
   - tasksMenu.tsx: `TaskMenuProps` is deleted (AnchoredMenu.tsx types its own props). Nothing imported it.
3. **Imports and types left dead by the deleted shims** (`tsc --noUnusedLocals`, filtered to the changed files, only names that were used at BASE):
   - VersionsTab.tsx `type Confirm`.
   - The `React` default import in MemoryFilters.tsx, PageEditor.tsx and AddSourcePanels.tsx. At BASE each was used only as `React.ComponentType` in the shim.
   - Left alone, because they were already unused at BASE: the other `React` default imports and FindingDecision `DAY_MS`.
4. **FlattenNode: the narrowed copy of the label map is gone.**
   - The draft typed `data` as `StepNodeData & { stepLabelById?: Map<string, string> }` to dodge the `| null` that StepNodeData carries. It added a comment to explain the intersection.
   - flattenSummary passes the map to `humanizeExpression`, whose parameter defaults to `null`. So the honest fix is in the JSDoc: `stepLabelById?: Map<string, string> | null` in nodeSummaries.js (a comment, no runtime change). FlattenNode's data is now plain `StepNodeData`.
5. **notificationSettings.ts**: `NOTIFICATION_SETTINGS_DEFAULTS: NotificationSettings = NOTIFICATION_DEFAULTS`. The cast used to state this contract; it is now an annotation, which the compiler checks.
6. **FormEditorModal.tsx KEPT comment, corrected.** The draft blamed only the theme. Without the casts, tsc reports at :226/:227 that the preview config is not a `FormDef` (checked by removing both casts):
   - `theme: unknown`;
   - fields built from `Loose`: `name`/`type` are not proven strings, and `maxSizeMb` types as `{}` (`f.maxSizeMb || 10`).
   - The comment now names all three.

## Group A type changes: checked, honest
- **OutputView `onPickPath` opts? / InsertHandler: not a runtime bug.**
  - VariableTree.tsx:323 calls `onInsert(path)` without opts.
  - The only producer of `onPickPath` is InputDataPanel `onPick` (declared `opts?`). It reaches NodeDetailView.jsx:97 `onInsertFromTree = (path, opts) => activeFieldRef.current?.insert?.(path, opts)`.
  - Every `insert` implementation tolerates undefined:
    - BindingField `opts = {}`, useValuePick `opts: PickOptions = {}`;
    - TemplateField / ConditionBuilder / PathField / FieldPicker / FieldKeyCombobox / LoopOverPicker take only `path`.
  - MapCtx's own callers (mapAttrs:62, ColHeader:70) always pass `{ raw }`.
- **notificationDefaults Channel/Urgency/Delivery/Recipient**: one home now, in notificationDefaults (the lower module). notificationSettings re-exports them.
  - The readonly arrays are honest: the defaults are `Object.freeze`d, and the normalizer builds new arrays.
- **proposePick**: `Remedy` / `Remedies` come from mismatch.types. The dropped `PickRemedy` / `PickRemedies` had no other importer.
- **PageEditor → NotebookEditorHandle**: the real handle provides the two new members.
  - beeEditorHandle.ts:90/92 exposes `highlightSuggestions` / `suggestionAtPoint` from useEditorAnchors.ts:66/71, and their signatures match.
  - The local `EditorApi` (a second home) is gone.
- **FlowStep `tool?: string`**: optional, read under `step.type === 'integration_action' && step.tool`. It is the same kind of declaration as `kind?` and `label?`.
- **StepRow `id? / name? / title?`**: these match AudienceEntity (VisibilityCapsule.types.ts:19), which reads `name || title` (VisibilityCapsule.tsx:144). All are optional and nothing requires them.
- **LoopOverPicker / loopLists `Group[]`**: the only producer is computeUpstreamGroups (groups.ts:47, returns `Group[]`), so the required members are true.
- **`PaletteLayer[]` / `PaletteCatalog | null` in fitsAfter, useRibbonData and useBuildTabModel**: tsc-proven at every caller.
- **OrgGroup readonly, PillTone, jsComponents re-exports**: tsc-proven.
- **Aliases `const X = XJs` and `export const X = XJs`**: fine. Removing them would change identifiers, and the JS must stay identical. The same ruling as LC-fix-b2.
- **SolutionsOverviewParts `FilterPills<string>`**: an instantiation expression, not a cast. esbuild strips it, and the JS is identical.

## Group B: 0 errors surfaced, confirmed
- Typecheck is clean, and every removed shim became a bare alias: no shim was swapped for another cast.
- In the added lines, `grep ' as '` finds only:
  - a comment;
  - sampleFields.forEachCode.test.ts:18, which kept its existing test cast and only renamed the type (`UpstreamGroup` → `Group`).
- jsDeps.ts and blog/jsComponents.ts comments were already updated by the drafter.

## Kept shims: verdicts
- **EditorNodeWrapper.tsx:63 nodeLogicSummary: kept, correct.** Without the cast, the only error is :86 `Type 'undefined' cannot be used as an index type` (`automationTitles[id]`, with `id: string | undefined` from `TitleFor`).
  - There is no types-only honest form: `id as string` is a hidden `!`, and `` `${id}` `` or `id ?? ''` change the JS.
  - Runtime fix, already justified in LC-fix-b2: `(id) => (id === undefined ? null : automationTitles[id] || null)` is unreachable-difference only (automation ids are UUIDs). It goes in a separate commit with a test.
- **FormEditorModal.tsx Renderer + EndingView: kept, correct.** The reason is broader than the drafter's; see fix 6.
  - The honest fix is guards in `buildPreviewConfig`: an `isPlainObject(theme)`, string-typed `name`/`type`, and a numeric `maxSizeMb`.
  - That is a runtime change for formPreview.ts, with formPreview.test.ts already in place. Put it on the follow-up list.

## Follow-ups (pre-existing, not this change's)
- Two homes for an upstream group:
  - deepFields `UpstreamGroup` (all optional, 11 users) and upstream.types `Group` (required).
  - Fold `UpstreamGroup` into `Group` or make it `Partial<Group>`.
- notificationDefaults' local `NotificationEvent` interface duplicates `EventSettings` (minus `talkRoom`). One could be derived from the other.
- OverviewToolbar `PillOption` could be `FilterPillOption<string>`.
- sampleFields.forEachCode.test.ts:18/19 casts the now-TS `computeUpstreamGroups` / `collectArrayPaths`. It is a test, and the cast is not `as unknown as`.

## Verification (scratch worktree at aee23dc4 + fixes, removed afterwards)
- agent-hub `npm run typecheck` (via heavy.sh): clean.
- `npx eslint` on the 77 changed files (branch plus fixes): 0 errors, 75 warnings. Within budget: `lint:budget` passes in check:fast.
- `npx vitest related --run --maxWorkers=4`: 380 files, 4609 tests, all passed.
- Root `npm run check:fast`: 39 passed, 0 failed.
- duplication-ratchet: production 15162 ≤ 15290, test 26188 ≤ 26228.
- file-budget agent-hub: no file is past its ceiling.
- `lint:dead` (knip): clean.
