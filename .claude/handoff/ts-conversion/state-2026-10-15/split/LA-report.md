Status: rounds 1+2 merged and pushed; round 3 (JSDoc on 8 blocking JS components → InspectorPanel, PivotInspector, EditorViews) under Opus review LA-r3
Done: 58/153 files converted on this branch (59 converted, AppInputMultiselect returned to JS by review), 2 packages merged (round 1, round 2)
Next: integrate round 3 after review + full checks, push (ETA ~1.5 h); then a final retry pass over every remaining App Studio JS file on the final base (ETA ~2 h)

# L-A report: App Studio sweep (agent-hub/src/components/admin/Studio/AppStudio/**)

Branch `ts-laptop/sweep-a`. BASE `0ae29a17` (origin/ccr-28820270-xkvwp8 at session start); origin/ccr-28820270-xkvwp8 merged in before each push.
Final commit: see `git log -1` of the branch (this file is updated with every push).

Scope (user decision, mid-session): only types-only and caught-error-recipe conversions. No new runtime-equivalent rewrites; a file that needs one stays JS byte-identical and is listed under "Follow-up: needs runtime rewrite". A drafted `MAP[k]` rewrite package was stopped before it committed anything.

Method: packages by dependency layer. Where a JS module must stay JS (react-hooks disable, runtime blocker) but blocks its TS callers through inferred `= null` prop types, it gets JSDoc only (comments, plus a sibling `*.types.ts` where .file-budget.json leaves no room), reviewed against body and callers (checkJs is off, so tsc does not verify JSDoc).

## Status per package
| Package | Converted | Status | Gate | Review |
|---|---|---|---|---|
| r1-core (api, state, variables, chat) | 7/12: AppEditorContext, variableUsage, appToolCallDisplay, composerImages, AppBuilderActivity (types); studioAppsApi, index (catch recipe) | merged 8b6dfa68 | 5 identical, 0 different (+2 recipe) | reviews/LA-r1-A.md (CHANGES REQUIRED → fixed 6e4e81e6, 0cb9cf72) |
| r1-insp (inspector logic, shared panels, bi hooks) | 5/14: useAppTables, useConnectors, useDatasets, AutomationTile (types); useExpressionEditing (recipe) | merged | 4 identical, 0 different (+1 recipe) | LA-r1-A |
| r1-tables (tables, rbac) | 2/9: TableDesigner (types); PasteImportPanel (recipe) | merged | 1 identical, 0 different (+1 recipe) | LA-r1-A |
| r1-rt (runtime core, shell) | 4/16: shell/Brand, MobileNav, NavMega, NavTabs | merged | 4 identical, 0 different | reviews/LA-r1-B.md (CHANGES REQUIRED → fixed fdb5ec64) |
| r1-comp2 (runtime components) | 3/21: AppModal, AppPageHeader, AppRepeater | merged | 3 identical, 0 different | LA-r1-B |
| r1-comp1 (runtime components) | 0/21 (form-context typing + MAP lookups) | re-queued (r2-forms) | — | — |
| formContext.jsx JSDoc d4aab1c0 | comments only, stays JS | merged | n/a | LA-r1-B (fix 3 applied) |
| r2-jsdoc | JSDoc on BindingField, ExpressionInput, ConditionField, FormulaField, dataErrors, gridColumnFilters, cellValue (stay JS; comments + BindingField.types.ts, cellValue.types.ts) + dataBatchClient.ts | merged 1e68b067 | 1 identical, 0 different | reviews/LA-r2-A.md (CHANGES REQUIRED → fixed 4e679e35) |
| r2-forms | 4/16: AppButton, AppForm, AppInputCheckbox, useInputChange (AppInputMultiselect returned to JS by review: toValueList returns any[]) | merged | 5 identical, 0 different (before the revert) | LA-r2-A |
| r2-editor | 5/12: BuildBanner, SaveStatusPill, logicRows, NavGroupsDialog (types); PublishModal (recipe) | merged | 4 identical, 0 different (+1 recipe) | reviews/LA-r2-B.md (CHANGES REQUIRED → fixed bab46934) |
| r2-panels1 / r2-panels2 | 28/30 inspector panels | merged | 14 + 14 identical, 0 different | LA-r2-B |
| r2-flowbi, r2-insprest | 0/10, 0/5 | all need runtime rewrites (below) | — | — |

Round-1 integration gate (0ae29a17..8b6dfa68): `17 identical, 4 different of 21 converted files`; the 4 different are exactly the catch-recipe files (studioAppsApi.ts, index.tsx, useExpressionEditing.ts, PasteImportPanel.tsx), reviewed hunk by hunk in LA-r1-A. No delete+add pairs except the removed shell.types.ts (review fix: one NavigateFn).
Round-2 integration gate (0ae29a17..1e68b067): `54 identical, 5 different of 59 converted files` (the 5 = the 4 round-1 recipe files + PublishModal.tsx, recipe only). Round-2 review fixes 4e679e35, bab46934: types/comments only, emitted JS of every touched TS file identical, JS hunks comment-only.
Review-fix commits: 6e4e81e6 and fdb5ec64 are types/comments only (emitted JS of every touched file compared, identical). 0cb9cf72 drops four `as unknown as` component shims (BuilderComposer, BuilderTranscript, AppEditorShell, TableDetail): emitted JS differs only in that the import is bound under the used name instead of `XJs` + `const X = XJs` (same module binding).

## Kept JS (round 1, byte-identical to BASE)
- core: state/generators.js (makeNode may return null, then `node.children =`), variables/VariablesManager.jsx (variable.default of any type into `<input value>`), chat/PlanCard.jsx (rows string|object read as `t?.fields`), state/useAppAutosave.js (`clearTimeout(ref.current)` with initial null; reviewer: follow-up candidate), AppList.jsx (Date arithmetic).
- insp: inspector/logic/{ConditionField,ExpressionInput,FormulaField} (blocked by automation/Builder/mapping/ConditionBuilder.jsx and VariablePicker.jsx, outside L-A; now JSDoc-typed in r2-jsdoc), inspector/panels/BindingField.jsx (isFormulaVal falsy non-boolean into `checked`), SpecPanel/inputPanels/AiActionEditors (see r2-jsdoc), inspector/testPayload.js (InputMapping.name optional used as key), inspector/AutomationPicker.jsx (MAP[optional]).
- tables: relationOps.js (`rows.get(d).push`; reviewer: follow-up candidate), RelationshipsTab.jsx (applyNodeChanges without `data`), RowCellEditor.jsx (unknown cell into input value; earlier review b06 #3), RowsTab.jsx (`f.relation.table` after `?.` filter), rbac/RolesManager.jsx, RowRuleBuilder.jsx, RowRuleEditor.jsx (nullable state in closures, boolean rule value into select).
- rt: AppRenderer.jsx, AppShell.jsx, NavSidebar.jsx, cellValue.jsx, dataErrors.js (reviewer: no real blocker, follow-up candidate), sseStream.js (`response.body.getReader()`), themeVars.js (`rgb.r` nullable), useAppDataSource.js, gridColumnFilters.js, GridFilterControl.jsx.
- comp2/comp1 (runtime components): AppInputText/Date/Datetime/Number/Html/Select/File/Relation/Person, AppDatasetUpload, AppTabs (unknown form value into input value, see r2-forms), AppInputTextarea, AppInputRichtext (nullable derefs), AppStepper, AppList, AppMessageThread, AppKanban (`runAction(node.onX)` in a callback: an undefined id reads action key "undefined", so widening runAction would lie), AppTable, AppTimeline, AppPivot, AppRecordDetail, AppCalendar, AppDataGrid, AppFileGallery (Date from unknown, `Map.get().push`, null derefs), AppApprovalList (guard does not narrow).
- Stay JS by rule: runtime/uiBits.jsx, runtime/formContext.jsx (react-hooks disable; JSDoc only), state/definitionOps.js (needs a generic redesign first, reviews/b2-B.md).

## Follow-up: needs runtime rewrite (file: construct)
- runtime/components/AppBadgeList, AppBrowserView, AppCard, AppContainer, AppChart, AppFilePreview: constant table indexed with an optional key (`ALIGN_JUSTIFY[node.style?.align]`, `ASPECT[props.aspect]`, `HEIGHT_MAP[heightToken]`) → `k == null ? undefined : MAP[k]` (b2-B pattern)
- runtime/components/AppConnectorStatus: `PROVIDER_LABELS[data.provider]`; AppProgress: `ROLE_COLORS[s.tone]`; AppStat: `STAT_LOOKS[look]`
- inspector/AutomationPicker.jsx: `OWNER_REFUSAL_KEYS[code]`
- runtime/shell/NavSidebar.jsx: `itemRefs.current[flatIndex.get(id)]`
- bi/ConnectorChainEditor.jsx: `step.tool` on `ChainStep | null`; `siblings.find(...)` then `action.name`
- bi/ConnectorPicker.jsx: blocked by shared/AppActionPicker.jsx (no JSDoc, outside L-A); `filter().map(c => c.tool)` gives `(string|undefined)[]` into Map.get
- bi/FilterRowsEditor.jsx: `OPS_BY_TYPE[field?.type]`
- bi/QueryBuilder.jsx: optional `onClose` into Modal's required prop
- flow/ActionFlowEditor.jsx: partial NodeRuntime context value; flow/DocumentFillFields.jsx: `p.fields?.length > 0`; flow/StepSettings.jsx: unknown step values into JSX value/checked; flow/layout.js, flow/stepGraph.js: `Map.get(k).push`, `Map.get(k) + 1`
- inspector/ActionsSection.jsx: `TYPE_EVENT_LISTS[node?.type]`, `actions[node?.[ev]]`; MultiInspector.jsx, StyleSection.jsx: `STYLE_KNOBS[knob].values` on `KnobSpec | undefined`; ThemePanel.jsx: `navStyleLabels(t)[v]` with `v: string | undefined`
- editor/ScreenTabs.jsx: `tabRefs.current[screenId]` nullable key; editor/resize.js: `parseFloat(cs?.paddingLeft)`; editor/LogicaTab.jsx: titleFor indexes by a possibly-undefined id; editor/collision.js: droppable rect cast would lie (wave1 review)
- inspector/panels/InputHtmlInspector.jsx: drafter: `hint=` on `<Toggle>` (ToggleProps has no hint); LA-r2-B found no blocker → retried in the final pass
- runtime/components/AppInputMultiselect.jsx: exported `toValueList` returns any[] carrying unknown form values into keys/labels (LA-r2-A fix 1)
- editor/Canvas.jsx: BrowseEventSink/BeforeServerStep/ScopeDefinition/FetchScope/ToolDraft and useBuildFollow `= null` params need casts or type changes in other files; editor/ComponentRibbon.jsx: RegistryEntry|undefined deref, dnd-kit listeners typed Function; inspector/panels/PivotInspector converted in round 3

## Needs integrator
- Fix the test-only mock path in src/pages/webpages/WebpageIDE.i18n.test.jsx (root cause and one-line fix in split/RESULT.md): it mocks useBfMarks on ./WebpageCodeStrip, but WebpageIDE imports ./useBfMarks, so the real fetch can reject after teardown and fail a loaded full run (round-2 run was green; round-1 run and the staging run were not).
- (history) agent-hub full vitest on 8b6dfa68: 1858 files, 21872 tests pass, but vitest exits 1 on ONE unhandled rejection outside L-A scope: `src/pages/webpages/useBfMarks.ts:57` setState after jsdom teardown ("window is not defined"), attributed to `WebpageIDE.i18n.test.jsx`. This branch does not touch src/pages/webpages (diff empty vs BASE); the file passes 3/3 alone. Load-dependent teardown race (the hook's fetch resolves after the test ends). Pre-existing; fix belongs to whoever owns webpages (await the load or abort on unmount in the test). Not fixed here.

## Merge watch-points
- Duplication: round 2 editor adds +111 production lines (web editor/logicRows.ts ↔ mobile app-studio/core/logicRows port; jscpd pairs them only now that both are .ts). Measured 15172 ≤ 15290 after round 2. Mirror candidate (shared-mirror manifest), integrator step.
- .file-budget.json: key renames only (logicRows, PublishModal, AppForm etc. .jsx→.tsx).
- mobile/src/features/app-studio/core/logicRows.lockstep.test.ts reads editor/logicRows.ts (was .js).
- inspector/appDefinition.ts: `meta?: AppMeta` (completed with description + index signature; replaces useBuilderTurn's DefMeta), `design?: AppDesign`, `repeat?`/`forEach?: BindingInput`.
- runtime/formContext.jsx gains JSDoc typedefs `FormFieldMeta`, `FormContextValue` (TS consumers import them as types).
- tables/tablesManagerModel.ts `ModelField` gained optional fields; recordsApi.ts exports `RowRecord`; spreadsheetPaste.ts exports `ImportTable`.
- Catch-recipe behaviour notes (reviewed in LA-r1-A as equivalent for every input the code can see): studioAppsApi `managedResult` reads `managedRefusalOf(err)`; PasteImportPanel reads `err.retryAfter` through a local `retryAfterOf` guard.
- useActionRunner.appEffects.test.jsx path AppForm.jsx → .tsx comes with round 2.

## Push log
| Pushed commit | Content | check:fast | server typecheck | duplication (prod / test) | gitleaks | agent-hub tsc | vitest | mobile tsc / jest | server test |
|---|---|---|---|---|---|---|---|---|---|
| first push (setup) | BASE + report only | n/a | | | | | | | |
| aeb4803f | round 1 merged (8b6dfa68) | 39/39 | 0 errors (1076 files) | 15088 ≤ 15290 / 26228 = 26228 | clean | 0 errors | 1858 files, 21872 pass; 1 unhandled rejection outside scope (above) | 0 errors / 762 suites, 13428 pass | 2587 files, 0 fail, 0 cancelled |
| this commit | round 2 merged (1e68b067) | 39/39 | 0 errors (1076 files) | 15172 ≤ 15290 / 26228 = 26228 | clean | 0 errors | `npm run test:run -- --maxWorkers=8`: 1858 files, 21872 pass, 0 errors (green) | 0 errors / 762 suites, 13428 pass | 2587 files, 29058 pass, 0 fail |
