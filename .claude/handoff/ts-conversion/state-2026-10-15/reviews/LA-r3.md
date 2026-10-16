# Opus review LA-r3 (ts-laptop/la-r3-jsdoc: 2fb98760 JSDoc, 19ed84d8 types; drafted on 1b4566f1, base 0ae29a17, merge-tested on ts-laptop/sweep-a 1e68b067): CHANGES REQUIRED (6 fixes: 5 types/comments only and gate-identical, 1 commit split)

The brief names fd9f2a8a for checks 5 and 7. That hash is the round-1 scratch merge and is stale here. Every check below ran on the probe merge **ebef96e4** (sweep-a 1e68b067 + la-r3-jsdoc, `merge --no-ff`, no conflicts) in /home/tom/Projects/bee-flow-la-wt/review-r3.

## Gate
- 1b4566f1..2fb98760: `3 identical, 0 different of 3 converted files`. These "3 converted" files are the problem in Fix 1: the commit has three 100% renames (EditorViews, InspectorPanel, PivotInspector `.jsx → .tsx`, content unchanged), although its message says "Comments only".
- 2fb98760..19ed84d8: `0 identical, 0 different of 0` (only content edits to files that were already .tsx).
- 1b4566f1..19ed84d8: `3 identical, 0 different of 3`.
- 1e68b067..ebef96e4 (the merge): `3 identical, 0 different of 3`.
- 0ae29a17..ebef96e4: `57 identical, 5 different of 62`. The 5 DIFFERENT files are the known round-1/2 recipe files (index.tsx, useExpressionEditing.ts, studioAppsApi.ts, PasteImportPanel.tsx, PublishModal.tsx). Nothing new comes from r3.
- No catch-recipe commit in this round.
- `git diff --name-status -M40% 1b4566f1 19ed84d8`: 3 × R (R089 EditorViews, R094 InspectorPanel, R089 PivotInspector), 6 × A (.types.ts), 9 × M. No D/A pairs.
- **Forbidden constructs** in the added lines of both commits: none. That covers any, as any, as unknown as, ts-ignore/expect-error, `!`, new eslint-disable, .d.ts and two statements on one line. The commit adds no `as` at all.
- **Kept JS, byte-identical to 0ae29a17** (`git diff` empty): Canvas.jsx and flow/useStepReferences.js.
- **The 8 JSDoc files** differ from 0ae29a17 only in comments. transpileModule with removeComments gives IDENTICAL for all 8: ThemePanel, StyleSection, ActionsSection, QueryBuilder, AppRenderer, RolesManager, RowRuleEditor and VariablesManager.

## Fixes (file:line on 19ed84d8; the same lines on ebef96e4)
1. **Split the commits cleanly. 2fb98760 is not "comments only" and does not typecheck on its own.**
   - It renames EditorViews.jsx, InspectorPanel.jsx and PivotInspector.jsx to .tsx with unchanged JS content. At 2fb98760 those are untyped TSX files, so `function InspectorHeader({ node, tab, … })` (InspectorPanel.tsx:49) and the other destructured parameters fail noImplicitAny (TS7031). That breaks bisect and contradicts the commit message.
   - Move the three renames into 19ed84d8. In the r3-jsdoc worktree:
     ```
     git reset --soft 1b4566f1 && git restore --staged .
     git add agent-hub/src/components/admin/Studio/AppStudio/{inspector/ThemePanel,inspector/StyleSection,inspector/ActionsSection,bi/QueryBuilder,runtime/AppRenderer,rbac/RolesManager,rbac/RowRuleEditor,variables/VariablesManager}.jsx \
             agent-hub/src/components/admin/Studio/AppStudio/{inspector/ThemePanel,inspector/ActionsSection,bi/QueryBuilder,runtime/AppRenderer,rbac/RolesManager,variables/VariablesManager}.types.ts
     git commit -C 2fb98760
     git add -A agent-hub && git commit -C 19ed84d8
     ```
     Apply Fixes 2-6 before the second commit, or as amends to the matching commit. Fixes 3 (VariablesManager.types), 4, 5 and 6 belong to the JSDoc commit. Fixes 2 and 3 (the .tsx chain) belong to the types commit.
   - Afterwards, rerun the gate per commit: A should report `0 converted`, B `3 identical, 0 different`.

2. **AppEditorShell: retire the `InspectorPanelJs as unknown as` shim. It now hides the onTestActionResult mismatch the drafter flagged.**
   - The real parameter is `actionId: string | null` (useEventWiring.ts:151, :486). The shell's handler already guards `if (!actionId) return;`, so widening its parameter is honest, and `[actionId]` stays narrowed to `string`.
   - editor/AppEditorShell.tsx:65-68: replace the four-line block with
     ```ts
     // inspector/InspectorPanel.tsx is TypeScript now; the alias keeps the compiled text.
     const InspectorPanel = InspectorPanelJs;
     ```
     Keep the import at :20 and keep `ComponentType` (Canvas and CanvasPlanPanel still use it).
   - editor/AppEditorShell.tsx:186: `useCallback((actionId: string, entry: unknown) => {` → `useCallback((actionId: string | null, entry: unknown) => {`
   - Compiled text is IDENTICAL (transpileModule, removeComments, isolatedModules). This drops one `as unknown as`.

3. **VariablesManager `onCommit` is called without a guard (VariablesManager.jsx:78, 86, 91, 98, 140), but it is typed optional.**
   - The drafter's own note says a manager given no onCommit "can show the variables but not change them". In fact any edit then throws a TypeError. A lying JSDoc is worse than none.
   - Making it required pulls through the optional chain above it. Nothing on that chain reads `onCommit`; each level only passes it on, and AppEditorShell always passes `commitDefinition` (AppEditorShell.tsx:266). So required is the honest type at every level:
     - variables/VariablesManager.types.ts:18: `    onCommit?: ((next: AppDefinition) => void) | null;` → `    onCommit: (next: AppDefinition) => void;`
     - variables/VariablesManager.types.ts:9-15: replace the doc with
       ```
        * Props of VariablesManager (VariablesManager.jsx). Every edit calls
        * `onCommit` without a guard, so it is required. The rest may be left out: the
        * variables are read through `listVariables`, which accepts no definition.
       ```
     - editor/EditorViews.tsx:47 (DataViewProps): `    onCommit?: (definition: AppDefinition) => void;` → `    onCommit: (definition: AppDefinition) => void;`. RolesViewProps:132 stays optional: RolesManager and AccessMatrix guard it.
     - editor/header/HeaderRows.tsx:85: `    onCommit?: (def: AppDefinition) => void;` → `    onCommit: (def: AppDefinition) => void;`
     - editor/EditorHeader.tsx:95: the same edit.
   - Fallout: none. Typecheck stays at 0 errors. EditorHeader.managed.test.tsx renders through its own Record cast and passes onCommit anyway.

4. **QueryBuilder `onClose` is typed optional, but Modal.tsx:275 calls it without a guard on a backdrop click.**
   - Modal's own prop type is `onClose: () => void` (Modal.tsx:35), and QueryBuilder.jsx:296 passes the prop straight through. Both callers (ConfigureDataButton, BindingField.jsx:672) always pass it. There is no TS caller, so no fallout.
   - bi/QueryBuilder.types.ts:11: `    onClose?: (() => void) | null;` → `    onClose: () => void;`
   - bi/QueryBuilder.types.ts:5-7: replace the doc lines with
     ```
      * Props of QueryBuilder (QueryBuilder.jsx). `onClose` is required: the Modal
      * calls it without a guard on a backdrop click. The rest may be left out:
      * `onSave` is called through `?.`, and without an `appId` no tables load.
     ```

5. **Name clash: a second exported `RevealTarget` with a different shape.**
   - editor/header/headerModel.ts:34 already exports `RevealTarget { screenId: string; nodeId: string | null }`, which EditorHeader and HeaderControls import. VariablesManager.types.ts:4 exports `RevealTarget { nodeId: string; screenId?: string }`.
   - The two are not the same shape: a variable usage site may have no screen, and its click requires a node. So keep both, but under different names.
   - VariablesManager.types.ts:4 and :20: `RevealTarget` → `VariableRevealTarget`. Nothing else imports it.

6. **StyleSection.jsx:56-57: the new JSDoc block sits between `updateSectionStyle`'s doc comment and the function.** That breaks the contract ("never between JSDoc and function"), and it leaves two stacked `/** */` blocks. Merge them:
   ```
   /**
    * Shallow-merge a style patch into a section (structural sharing; same def when a no-op).
    * @param {import('./appDefinition').AppDefinition} def
   ```
   That is: delete :56, and add the description as the first line inside the block that starts at :57. The line count is unchanged.

All 6 fixes were applied together on ebef96e4 (diff: /tmp/claude-1000/-home-tom-Projects-Bee-Flow/ea43414a-061f-49c2-9608-e64f103495c6/scratchpad/LA-r3-fixes.diff, 7 files, +17 −21):
- typecheck: 0 errors
- transpileModule: every changed .ts/.tsx IDENTICAL
- eslint: 0 errors
- the vitest run below was taken with them applied

## Answers to the drafter's questions
- **EditorInspectorPanelProps vs registry.ts InspectorPanelProps: one home?** No merge. These are different shapes:
  - the editor's right-hand panel: `onCommit` plus `onTestActionResult`, with everything else read from context;
  - the props every per-type Content panel receives: node, definition, onCommit, disabled.

  The confusing name is registry's. The LA-r2-B follow-up still stands: `export type InspectorPanelProps = PanelProps;` in registry.ts, and later rename it to `ContentPanelProps`. Keep `EditorInspectorPanelProps` as it is.
- **The AppEditorShell `as unknown as`:** Fix 2.
- **VariablesManager onCommit:** Fix 3.

## Accepted as is
- **ThemePanelProps, StyleSectionProps and ActionsSectionProps:**
  - `onCommit` is required: it is called without a guard on every edit (ThemePanel.jsx:203-233; StyleSection.jsx:276; useEventWiring.ts:266-325).
  - `definition` is optional/nullable: the render path reads it only through `?.`.
  - An edit with a null definition would throw inside definitionOps, but no caller can produce that: InspectorPanel returns early on `!definition` (:148).
- **ActionsSectionProps.onTestActionResult** = `UseEventWiringOptions['onTestActionResult']`: one home, matches the call at useEventWiring.ts:486.
- **AppRendererProps:**
  - Every prop the three JS callers pass (appRuntimeHeadless, AppRunPage, Canvas: 19 distinct names) is declared, and every one is read defensively (`|| {}`, `|| noop`, `instanceof Set`, `typeof setVar === 'function'`).
  - `registerFormValue` reuses `RuntimeValue['registerFormValue']`, which already includes `null`.
  - `NodeWrapperProps.node` is required: `node.id` is read without a guard (AppRenderer.jsx:65).
- **RolesManagerProps and the inline RowRuleEditor JSDoc:** all optional, matching the `= null` defaults and the `onCommit && definition` guard (RolesManager.jsx:231). `onDirtyChange` goes through `dirtyChangeRef.current?.()`.
- **ConfigureDataButtonProps:**
  - `patch` is called through `?.`;
  - `node` and `definition` are declared because PivotInspector passes them and the button ignores them. The comment that explained this moved from the JS into the types file, which is fine at the budget ceiling.
- **QueryBuilderProps.onSave** emits `BuiltView` (BindingField.types.ts), matching QueryBuilder.jsx:285 `{ datasetId, chart }`.
- **PivotInspector:**
  - `PanelProps<PivotProps>` is the one panel-props home (LA-r2-B Fix 1).
  - PivotDim/PivotValue keys are optional, although the server spec (server/appStudio/componentSpecs/analyticsSpecs.js:283) requires `key`. That is right: the editor creates `{ key: '' }` and reads `d.key || ''`.
  - No existing pivot type to reuse.
- **InspectorPanel.tsx:**
  - `InspectorTab` matches the two SegmentedControl values (:112-113).
  - `useState<string | null>` for confirmFor is right.
  - `shell(children: ReactNode)` is right.
- **EditorViews:**
  - `app: HeaderApp` is required although DataView/RolesView read `app?.id`. Making it optional turns `app?.id` into `string | undefined`, which TablesManagerProps.appId (`string`, reviewed in r1) rejects. HeaderViewRowsProps.app is required and always set, so leave it.
  - `dispatch` is required: it is called without a guard in onRevealNode.
- **TablesManagerProps.inline?: boolean, "Not read yet":** honest. The Data view passes it and the manager does not destructure it.
- **NodeWrapperProps (runtime) vs EditorNodeWrapperProps (editor):** not a duplicate. The editor one adds onCommit and narrows `node`.
  - Optional follow-up: `EditorNodeWrapperProps extends NodeWrapperProps` with the narrower `node` override.
- **Six `.types.ts` side files for files at their budget ceiling:** file-budget passes and none is past its ceiling. knip (`--include files`) follows the JSDoc `import()` references: no unused files.

## Kept JS: reasons spot-checked
- **useStepReferences.js** ("needs screenOptions' body changed to accept a screen without an id"): **not a real blocker.** A type predicate is types-only:
  ```ts
  screenOptions(screens: Array<{ id?: string; name?: string }> | null | undefined)
  … .filter((s): s is { id: string; name?: string } => s && typeof s.id === 'string')
  ```
  It compiles under `--strict`. Compiled JS is unchanged, because the predicate is erased. Follow-up candidate.
- **Canvas.jsx** (casts for BrowseEventSink, BeforeServerStep, ScopeDefinition, FetchScope): plausible. Those are narrow TS types in runnerContext.ts:13-14 and AppDataScope.tsx:64/71. Not verified in depth.
- **The 8 JSDoc files:** the commit gives no reason why they stay JS. Spot check:
  - VariablesManager, ThemePanel and StyleSection have no catch, no eslint-disable, and none of the README's runtime constructs. Their only JS imports (definitionOps, themeVars) are already imported by TS files.
  - QueryBuilder, RolesManager and RowRuleEditor have catch blocks the recipe covers. RolesManager has the known message-as-code case at :262.
  - **Follow-up candidates for the next round, not blockers.** With them converted, the .types.ts side files can be folded back.

## API shapes
No new typed API responses in this round. `BuiltView` and `ChartMapping` already existed (r2 BindingField.types.ts); runPreview stays in JS.

## Checks run (probe ebef96e4, with Fixes 2-6 applied where noted)
- **Typecheck** (`HEAVY_SLOTS=2 heavy.sh npm run typecheck`): 0 errors on ebef96e4, and 0 with the fixes.
- **eslint on the 21 changed files:** 0 errors, 60 warnings, against 63 for the same files at 1e68b067: InspectorPanel 5 → 3, EditorViews 1 → 0, the rest unchanged. With the fixes, the 7 touched files: 0 errors.
- **vitest** (`heavy.sh npx vitest run --maxWorkers=4` over AppStudio/{bi,editor,inspector,rbac,runtime,tables,variables} + AppStudio.noPurple + i18nGuard), with the fixes: **208 files, 2592 tests passed**.
- **mobile jest:** no mobile or server test names any changed basename (grep over mobile/src and server for the 15 basenames). Nothing to run.
- **`node scripts/duplication-ratchet.mjs`:** ✅ production 15184 / 15290, test 26228 at budget.
- **`node scripts/file-budget.mjs agent-hub`:** ✅ none past its ceiling (11 ceilings can come down).
- **`npm run check:fast`:** 39 passed, 0 failed. **knip:** clean.

## Merge order
1. Fix 1 (re-split), with Fixes 2-6 folded into the matching commits.
2. Merge la-r3-jsdoc into sweep-a.
3. Rerun the gate per commit, then typecheck and the vitest set above.
