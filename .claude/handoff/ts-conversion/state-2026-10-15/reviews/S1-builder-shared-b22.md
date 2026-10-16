# Opus review S1 Builder shared + b22 — CHANGES REQUIRED

All three fixes are small and types-only. The gate stays at 0 different.

## What I checked
- **Gate.** `node scripts/ts-equivalence.mjs 81d6bedfc edba6ad2 --diff` from b22 gives `22 identical, 0 different of 22 converted files`. That covers both commits (2 shared + 20 batch files). PresenterContext.ts and engineLine.ts are 100% renames.
- **Kept-JS files.** No `.js`/`.jsx` file from batches/22.txt differs from BASE, nodeDefs.js and displayHelpers.js included. The diff holds only renames, AddStepMenu.types.ts, types.ts, `.file-budget.json`, three mobile lockstep path or regex edits and one mobile comment (FieldRow.tsx).
- **Forbidden constructs.** None: no `any`, `as unknown as`, `@ts-*`, `!` or new `eslint-disable`. The only assertions are `e.target as Node` (ArrangeMenu.tsx:14, NodeContextMenu.tsx:40), `STATUS_COLORS as Record<string, string>` (edgeColors.ts:22) and the NODE_DEFS upcast (formDensity.ts:77).
- **NODE_DEFS upcast is honest.** I probed it with tsc. Every NODE_DEFS entry has `simpleSections: string[]` or none at all. A plain annotation fails only on weak-type detection (`parallel` shares no property with `{simpleSections?}`), and `as` skips that check. `| undefined` correctly models a missing key.
  - The only caller of `hiddenInSimple` is AccordionSection, and every AccordionSection caller passes a literal or template string `stepType` (CallContractFields, flowletCallFields `call_layer|call_block|layer_output`, InspectorPanel `appstudio.*`).
  - `stepType: string` is the widest type that compiles without a code change: a null index is TS2538, the same reason nodeDefs stays JS.
- **Other types reviewed and found sound.**
  - formPrimitives: `label?: string | null` is right, because FieldHint `title` is `string | null` and every caller passes a string.
  - RibbonFlightLayer: FlightRf is honest. `ReactFlowInstance` is assignable to it, and the code feature-checks every method.
  - NodeRuntimeContext: `NodeRuntime` is the all-optional mapping of RuntimeContext.
  - NodeContextMenu: `onDuplicate`, `onDelete` and `onClose` are required because they are called without a guard.
  - edgeColors: `autoCaseColor(caseIndex: number)` is the widest type that compiles, since `Number.isInteger` does not narrow.
  - EdgeCrossingContext: PathSegment is inferred as `number` fields (probed), not `any`.
- **Merge.** In the scratch merge (874608af) none of the other S1 branches touch these files. I did not re-run a typecheck of b22 on its own.

## Required fixes
1. **One home for the density/mode shapes.** formDensity.ts:46-55 adds a second `FormDensityValue` and a third `FormMode`. The others already exist: useHiddenSections.ts:4-15 has `FormDensity`, `FormMode` (with null) and a stricter `FormDensityValue`, and FormModeToggle.tsx:6 has `FormMode`.
   - In formDensity.ts, after `FORM_MODES`, add:
     `/** How BIG the drawer is. */` / `export type FormDensity = 'quick' | 'full';`
     Keep `FormMode` and `FormDensityValue` as they are (they are the permissive context shape). At :93, `densityForOpen(...)` returns `FormDensity`.
   - In useHiddenSections.ts, delete :4-15 and add `import type { FormDensity, FormDensityValue, FormMode } from './flow/settings/formDensity';`. At :25, write `mode: FormMode | null;`. The returned object is assignable to `FormDensityValue`, and NodeDetailView is the only importer (JS).
   - In FormModeToggle.tsx, replace :6 with `import type { FormMode } from './formDensity';`. Nobody imports `FormMode` from FormModeToggle.
2. **JsonTree must accept a null `onCopyPath`.** The code calls `onCopyPath?.(path)`, and OutputView.tsx:81 defaults `onCopyPath = null` and passes it through (:141). That null is why ScalarValue still needs its cast.
   - JsonTree.tsx:45 and :203: `onCopyPath?: ((path: string) => void) | null;`
3. **`piiLineColors` can be null.** flow/types.ts:51 should read `piiLineColors?: Record<string, string> | null;`.
   - The server stores any value and only warns: server/automation/validate/graphEdges.js:120-126 emits `piiLineColors.shape` and saves anyway.
   - The code is defensive about it: `definition?.piiLineColors || {}` and `overrides && typeof overrides === 'object'`.
   - In the same file, the new comments at :32 and :50 name `flow/edgeColors.js` and `flow/edgeColorOps.js`. Change both to `.ts`.
4. **appsRibbonLayout.ts:25-29 `CategoryGroup` duplicates `AppCategory`** (ribbon/ribbonCategories.ts:43, the type `orderedAppCategories` returns), and with a lazier `apps: object[]`.
   - Delete the interface and its comment, and add `import type { AppCategory } from './ribbon/ribbonCategories';`.
   - At :31: `export function isSuite(group?: Partial<AppCategory> | null): boolean {`.
   - The import is type-only, so it is erased for the palette.lockstep `require`.

## Casts that are now redundant
Apply these at merge. They do not change behaviour and are outside the gate, as with the b07 casts. Run a typecheck afterwards.
- a. **output/ScalarValue.tsx** (after fix 2; answers question 6):
  - :1 → `import { useState, type ReactNode } from 'react';`
  - :3 → `import JsonTree from '../debug/JsonTree';`
  - Delete :8-14 and add `export { JsonTree };`. OutputView.tsx:8 imports it by name.
- b. **output/RecordTable.paths.test.tsx:** delete :1 and :16; :7 → `import JsonTree from '../debug/JsonTree';`
- c. **useNdvState.ts:** :3 → `import { densityForOpen } from './flow/settings/formDensity';`. Delete :6-7, whose comment is now false.
- d. **settings/actionEditors/codeFields.tsx:**
  - :17 → `import AccordionSection from '../../AccordionSection';`
  - Delete :31-32.
  - :15: drop `type ComponentType` if nothing else uses it.
- e. **settings/actionEditors/httpQuerySection.tsx:** :8 → `import AccordionSection from '../../AccordionSection';`. Delete :17, and keep `AnyProps` for TemplateField.
- f. **settings/FlattenFields.tsx:** :19 → `import { FormRow, inputClass } from './formPrimitives';`. Delete :41-42.
- g. **flow/ribbon/jsComponents.ts:** delete :6 and replace :62 with `export { AppGlyph } from '../appGlyphs';`.
- h. **automation/modalOverlays.test.tsx:** delete :18-23 (the comment and the `Picker` cast) and render `<TriggerProviderPicker …/>` directly.
- i. **Follow-up, not at merge: build/jsComponents.ts:15,86-92 (AddStepMenu).** It needs CanvasOverlays.tsx:86 `scope: AddStepMenuProps['scope']` and useBuildTabModel.ts:116 `smart: { frequentItems: SearchCandidate[]; suggestedItems: SearchCandidate[] }` first.

## Nits
1. ArrangeMenu.tsx:14 and NodeContextMenu.tsx:40: `e.target as Node | null`. `contains()` takes null, so the assertion does not need to drop it.
2. formDensity.ts:77: `Record<string, { simpleSections?: string[]; [key: string]: unknown } | undefined>`. With the index signature the target is no longer a weak type, so the `as` becomes a checked widening (tsc-probed: assignable). The mobile regex `[^)]*` still matches.
3. edgeColors.ts:22: `Record<string, string | undefined>` (probed assignable), so `?? null` is typed truthfully.
   - Behaviour note, not for this commit: `resolveEdgeColor('toString')` returns `Object.prototype.toString`. The phone port uses `hasOwnProperty`.
4. formPrimitives.tsx:39-46 ValidationLineRecord: derive it from nodes/nodeProps.ts `StepIssue`, which is the record matchValidationToStep produces: `type ValidationLineRecord = Partial<StepIssue> & { severity?: string; hint?: string | null };`.
5. RibbonFlightLayer.tsx:24: `type FlightRf = Partial<Pick<Rf, 'getNode' | 'flowToScreenPosition' | 'getZoom'>>` with `Rf` from diagramPaneTypes.ts:59. Optional; the local shape is honest.
6. AddStepMenu.tsx:318 `RibbonApp & { connected?: boolean }`: add `connected?: boolean` to RibbonApp (ribbonCategories.ts:35). groupAppsByCategory always sets it (AppEntry).
7. Stale comment: mobile nodeEditor/density.ts:3 still says `formDensity.js`. The other old-extension mentions are comments only and harmless.
8. NodeRuntimeContext is now typed. Test files still cast `as never` (AiStepNode.test.tsx:23, HttpRequestNode.test.tsx:16, routeNodes.subtitle.test.tsx:29); they would need typed `Set<string>` fixtures to drop it. Not required.

## Retry list (kept JS)
- **LineColorPanel.jsx: typeable now.** Its blockers were edgeColorOps and edgeColors, both TS since this batch.
  - Props: `{ mode?: string; onModeChange: (mode: string) => void; definition?: FlowDefinition | null; editable?: boolean; onDefinitionChange?: ((next: FlowDefinition | null | undefined) => void) | null; hasPiiData?: boolean }`.
  - Rows: `const rows: { stepId: string; stepLabel: string; caseName: string; autoHex: string; pinned: string | null }[] = []`.
  - SwatchRow: `{ label: string; sublabel?: string | null; currentKey?: string | null; autoHex?: string; canEdit: boolean; onPick: (key: string | null) => void }`.
  - The `canEdit` alias narrows `onDefinitionChange`, since the parameter is never reassigned.
- **edgeColoring.js: typeable now** (edgeColors is TS).
  - `identityColorForEdge(data?: { defColor?: unknown; caseIndex?: number | null } | null, mode?: string, sourceRunStep?: { piiSummary?: { groups?: Record<string, unknown> | null } | null } | null, piiGroupColors: Record<string, string> | null = null)`.
  - `decorateRunEdges` takes the rendered-edge type useRenderedGraph.ts already declares, plus `{ runByStep?: Map<string, { status?: string }> | null; runInFlight?: boolean }`.
  - Also change mobile canvas.lockstep.test.ts:37 to `edgeColoring.ts`.
- **ScheduleBuilder.jsx: its blocker is the caught error** at :84 `e.message || 'Preview failed'`.
  - Commit 1 (types): `useState<{ valid: boolean; error: string | null; next: string[] }>`; Props `{ cron?: string | null; tz?: string | null; onChange?: ((v: { cron: string; tz: string }) => void) | null }`; TimePicker and Field props.
  - Commit 2 (catch recipe): `messageOf(e, 'Preview failed')`.
  - `useEffectEvent` is typed (@types/react 19.3).
- **CanvasSouthBar.jsx: no blocker found** in this spot check.
  - Checked: `runFocus.*` is read inside `if (runFocus)`, every `onClick={on…}` is guarded by `on… &&`, and engineLine is TS.
  - Retry with `useState<…>` generics for `ending` and `refusal`, or the drafter names the line that blocks it.
- **Confirmed runtime blockers** (claims hold):

  | File | Construct |
  |---|---|
  | aiToolNodes | `definition.steps.slice()` on optional `steps` in `replaceStep` |
  | appLabels | `BASE_APP_LABEL[integrationId]` with `= null` |
  | branchEdges | `want.label.slice(5)`, where `label` may be null |
  | buildChoreography | `now - lastMoveAt` with `lastMoveAt = null` (`Number.isFinite` does not narrow) |
  | dagreLayout | `s.position.x` after `isFinitePos`, which cannot be a type predicate (`p && …` does not return a boolean) |
  | dataSummary | `withTotal(…, value.total)` and `total <= summary.count` behind `Number.isInteger` |
  | CanvasZoomStack | `onClick={onWrapToFit}` / `onTogglePresenter` with `= null` (null is not allowed for `onClick`) |
  | displayHelpers | `tokens?.length > 1` |
  | nodeDefs | `NODE_DEFS[type]` with `type: string \| null \| undefined` (TS2538; typing the record does not help) |

## Mirror advice (integrator step)
- **flow/datetimeTarget.ts → mobile bindings/flowDeps/datetimeTarget.ts: feasible.** The web module has no imports and is a superset of the port: same bodies, plus `impliedListMode`.
  - Prep (types only, web): `DateTimeStep.op?: unknown`. The code only uses `===`, and this lets mobile `Partial<FlowNode>` (index signature `unknown`) be passed in.
  - Manifest entry: `{ "source": "agent-hub/src/components/automation/Builder/flow/datetimeTarget.ts", "target": "mobile/src/features/flow-editor/bindings/mirror/flow/datetimeTarget.ts", "transform": "none", "why": "Date & time list-mode column and input patch; flowDeps/datetimeTarget.ts re-exports it." }`. The target is under `generatedRoots`.
  - The port becomes `export { dateInputPatch, datetimeTargetColumn, isDateTimeListMode, splitWildcardPath } from '../mirror/flow/datetimeTarget';`.
  - Check mobile specs/datetime.ts:69 against the web return type `{ input: unknown; arrayRef?: string }` (the port returns a union). The datetime block in flowDeps.lockstep can then go.
- **edgeColorOps.ts: no phone port exists**, so there is nothing to mirror.
- **edgeColors.ts: not a mirror candidate.** The phone's edgeColors.ts is a different module: hard-coded hex, keys typed as `EdgeColorKey`, it absorbs edgeColoring's branches mode, and it uses a `hasOwnProperty` guard. The web version imports constants/palette. Keep the lockstep.
- **formDensity.ts: not mirrorable as is** (it holds a React context). A later refactor (not types-only) could move the pure rules (`ADVANCED_SECTION_KEYS`, `isAdvancedSection`, `hiddenInSimple`, `resolveMode`, `densityForOpen`) into `formDensityRules.ts`, with an importRewrite `../nodeDefs` → `@/features/flow-editor/model`, and then mirror that onto mobile nodeEditor/density.ts.

## Merge order
1. b22 with fixes 1-4 in one commit: `fix(ts): S1 builder shared + b22 review`.
2. Casts a-h.
3. Checks: agent-hub typecheck, the gate (expect the cast files reported as different, by design), eslint on the touched files, `cd mobile && ./node_modules/.bin/jest density.lockstep canvas.lockstep palette.lockstep flowDeps.lockstep`, and vitest on `debug/JsonTree`, `output/RecordTable.paths`, `flow/AccordionSection`, `flow/edgeColorOps`, `automation/modalOverlays` and `settings/FlattenFields`-related tests.
