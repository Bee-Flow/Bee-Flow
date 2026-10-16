# Opus review LA-r2-B (la-r2-panels1 0ce90b42, la-r2-panels2 d2f1fa87, la-r2-editor b8b6730e + 43b2264e; base 0ae29a17, merge-tested on la-int fdb5ec64 + la-r2-jsdoc + la-r2-forms): CHANGES REQUIRED (5 fixes, all types/comments only, gate-identical; nothing in them blocks the merge order)

## Gate
- 0ce90b42 (panels1, on 76c19641): `14 identical, 0 different of 14 converted files`. D/A pairs: none (14 × R083–R091). One A: NodePanelProps.types.ts (see Fix 1).
- d2f1fa87 (panels2, on 76c19641): `14 identical, 0 different of 14 converted files`. D/A pairs: none (14 × R078–R093).
- b8b6730e (editor types, on fd9f2a8a): `4 identical, 0 different of 4 converted files`. D/A pairs: none (BuildBanner R075, NavGroupsDialog R092, SaveStatusPill R087, logicRows R086; A logicRows.types.ts). The 6 M files (useBuildCue, BuildCueContext, EditorHeader, HeaderControls, useEditorSave, mobile lockstep) are type-only.
- 43b2264e (catch recipe): `0 identical, 1 different` = PublishModal.tsx. Every DIFFERENT hunk is a table substitution:
  - `err?.message || t(...)` → `messageOf(err, t(...))` ×3 (doCheck, Nextcloud menu, publish). `t()` is a pure lookup, so the eager fallback is fine.
  - `err?.status === 422` → `errorStatus(err) === 422`.
  - `err?.body?.errors` / `.warnings` → `errorBodyRecord(err)?.errors` / `.warnings`. Both go into `asIssueList(value: unknown)`, which narrows with `Array.isArray`, so no narrowing is missing. A string body gave `undefined` before and gives `undefined` now.
  - plus the helper import. No `// behaviour:` notes claimed, none needed. PublishModal R091, A PublishModal.types.ts.
- Scratch merge (fdb5ec64 + jsdoc + forms octopus, then panels1, panels2, editor): no text conflicts. Gate 0ae29a17..merge: `55 identical, 5 different of 60` = the 4 round-1 recipe files (index.tsx, useExpressionEditing.ts, studioAppsApi.ts, PasteImportPanel.tsx) + PublishModal.tsx.
- Forbidden constructs in the added lines of all four commits: none (no any / as any / as unknown as / ts-ignore / expect-error / `!` / new eslint-disable / .d.ts / two statements on one line).
  - useEditorSave.ts:36 edits the result type of the EXISTING `useAppAutosaveJs as unknown as` shim (BASE). `error: string | null` is true: every `setSafe('error', …)` in useAppAutosave.js:126-151 passes a literal or a `… || 'fallback string'`, and the default is null.
- Kept JS, byte-identical to 0ae29a17 (`git diff` empty): Canvas.jsx, ComponentRibbon.jsx, EditorViews.jsx, LogicaTab.jsx, ScreenTabs.jsx, collision.js, resize.js, InputHtmlInspector.jsx, PivotInspector.jsx, SpecPanel.jsx, inputPanels.jsx. BindingField.jsx differs only by r2-jsdoc's 2c807f86, which is under the parallel review.

## Fixes (file:line on the branch tips; all checked together, see the end)
1. **panels1: a third home for the panel props (one home).** BASE already has two:
   - `PanelProps<P>` in inspector/appDefinition.ts:210, used by every earlier panel and by all of panels2;
   - `InspectorPanelProps` in registry.ts:26.

   0ce90b42 adds a third, `NodePanelProps<P>` in panels/NodePanelProps.types.ts. Its `AppNode<P>` form also forces every P to `extends CommonNodeProps`, which is why the drafter had to type `title` as `string` while the panel writes null into it (Fix 2). Use PanelProps, as panels2 does:
   - `git rm agent-hub/src/components/admin/Studio/AppStudio/inspector/panels/NodePanelProps.types.ts`
   - In each of the 14 panels1 files, replace the two import lines (AiChat:7-8, Button:6-7, Callout:6-7, Card:4-5, Chart:14-15, Container:4-5, DataGrid:14-15, FilterBar:7-8, Form:7-8, Heading:6-7, Image:6-7, InputDatetime:7-8, InputFile:5-6, InputMultiselect:7-8) with
     `import type { PanelProps } from '../appDefinition';`
   - Drop ` extends CommonNodeProps` from each `interface <Name>InspectorProps` (AiChat:20, Button:14, Callout:11, Card:10, Chart:77, Container:18, DataGrid:96, FilterBar:41, Form:11, Heading:16, Image:10, InputDatetime:12, InputFile:10, InputMultiselect:18).
   - `NodePanelProps<` → `PanelProps<` in each signature.
   - PanelProps intersects `AppNode & { props?: P }`, so the CommonNodeProps members stay readable.
   - registerInspector still checks each P against CommonNodeProps: InspectorPanelProps must be assignable to PanelProps<P>, so a P member that contradicts CommonNodeProps fails to compile. Verified.
   - Follow-up (BASE debt, not this gate): registry.ts `InspectorPanelProps` could become `export type InspectorPanelProps = PanelProps;`.
2. **Honesty: `title` is cleared to null, but it is typed `string`.**
   - The null writes: Callout:34, Card:35, Chart:119 and Modal:27 `patch({ title: v || null })`; Form:43 `patch({ name: v || null })`. No panel in this set writes null into `label`.
   - appDefinition.ts:30 `    title?: string;` →
     ```
         /** Callout, Card, Chart and Modal clear it to null. */
         title?: string | null;
     ```
     This has zero fallout: the full typecheck stays at 0 errors.
   - Callout:12, Card:11, Chart:80 (0ce90b42) and Modal:10 (d2f1fa87): `title?: string;` → `title?: string | null;`
   - Form:14: `name?: string;` → `name?: string | null;`
   - Do NOT widen CommonNodeProps.name. Measured: that breaks the 6 input panels (InputDatetime, InputFile, InputMultiselect, InputPerson, InputRelation, InputRichtext) and AppForm.tsx:163/165 RuleProps. Only the FORM node's name is ever cleared; an input's name is always a string. Form's P records the null; through the intersection it still reads as `string`, which is a known limit of PanelProps and harmless here (the value goes to TextField, which takes null).
3. **panels1: the type blocks sit between a function's doc comment and the function.** The same contract rule was REQUIRED in S2-compliance 5, S2-org-website and S2-product-website. Move each type block, with its trailing blank line, above the comment, so the comment is again directly followed by `export default function`:
   - Chart:54-94 above :53 (`/** Content panel for chart… */`)
   - DataGrid:77-107 above :76
   - InputMultiselect:11-24 above :10
   - InputDatetime:11-19 above :10
   - InputFile:9-17 above :8
   - Container:18-22 above :8 (the `// Mirror…` lines plus the `/** Content panel for container …*/` block)
   - Button:14-20 above :10 (`// Mirror of the button variant enum…`, 4 lines)
   - Card:10-15 above :8 (2 lines)

   Comments and types only, so the gate stays identical (checked). panels2 placed every block correctly.
4. **editor: `AutomationLike` duplicates `AutomationRow` (one home).**
   - editor/automationTitles.ts:5 already exports `AutomationRow`, "One automation, as the list endpoint returns it". useAutomationRows returns it, and LogicaTab.jsx:131 passes exactly those rows into derivedAutomationRows. inspector/AutomationTile.tsx:40 already extends it (`AutomationTileRow`).
   - automationTitles.ts:5-9 →
     ```
     export interface AutomationRow {
         id?: string;
         title?: string;
         projectId?: string | null;
         triggerType?: string;
         definition?: {
             trigger?: { kind?: string; filter?: { tableId?: string } };
             steps?: unknown;
         } | null;
         [key: string]: unknown;
     }
     ```
     `| null` is required: AutomationTileRow narrows `definition` to `{ steps?: unknown } | null`, and it must stay assignable.
   - logicRows.types.ts: delete :55-64 (the AutomationLike doc + interface).
     - Add `import type { AutomationRow } from './automationTitles';` above :1.
     - Add `export type { AutomationRow } from './automationTitles';` under :6.
     - :92 → `automationRows?: Record<string, AutomationRow> | null;`
   - logicRows.ts: `AutomationLike` → `AutomationRow` at :1 (same single import line, so the file stays at 590), :391, :404 and :417.
5. **editor: `BuildPhaseInfo` duplicates the transcript's `PhaseInfo` (one home).**
   - The new export BuildCueContext.ts:15-19 is member-for-member chat/BuilderTranscript.tsx:50-54 `interface PhaseInfo`. BuilderChatPane.tsx:160 spells the same shape a third time, inline in its cast, and that is the very value useBuildCue receives.
   - BuilderTranscript.tsx: delete :50-54 (and the blank line after it).
     - :61 → `currentPhase: BuildPhaseInfo | null;`
     - Add `import type { BuildPhaseInfo } from '../editor/BuildCueContext';` after :17.
   - BuilderChatPane.tsx:160: `as { index?: number; total?: number | null; label?: string | null }` → `as BuildPhaseInfo`.
     - Add `import type { BuildPhaseInfo } from '../editor/BuildCueContext';` above :16 (import order).
     - The cast is BASE's (on `phases`); only its target changes.
   - Type-only imports, so no new scc edge.

- Nit (comment only, optional): logicRows.ts:78 `eventsForType(type: string)` and :99 `eventSlotsOf(node: AppNode)` are narrower than the JS contract.
  - The callers that pass more: logicRows.test.js:203 passes `undefined`, and the mobile lockstep (logicRows.lockstep.test.ts:80-84) passes `undefined` and `'constructor'`. The phone port declares `type: unknown` / `node: AppNode | null | undefined`.
  - Widening the web signature would need `TYPE_EVENT_LISTS[type]` with an undefined index, i.e. a runtime change, so the narrow types are the honest maximum. Every TS caller (emitEventRows) passes a real AppNode.
  - Add above :78: `// JS callers (tests, the mobile lockstep) also pass undefined; no list has that key, so it answers [].`

## Accepted as is
- **The 9 (not 8) `(c as BuildCueValue)` casts in BuildBanner.tsx (:178, 181, 182, 184, 200, 213 ×2, 225 ×2).**
  - Each sits under `live ?` / `live &&` / inside the `{live ? (…)` branch.
  - `live` is `state.kind === 'live'` on the BannerState union, and the live member carries `cue: BuildCueValue`.
  - `c = state.cue`, and `state` and `c` are render-local consts, so nothing changes between the guard and the read.
  - TS cannot narrow `c` through the alias, and removing the cast means reading `state.cue` instead, a code change.
- **Removed blank lines and the re-exports from the `.types.ts` files.**
  - logicRows.ts:5 and PublishModal.tsx:35/:87 each lost a blank line, so the files land exactly on their ceilings (590 / 565, the same as the BASE .js/.jsx). This is compile-identical, the ceiling may only come down, and the contract's own remedy (types to `<Name>.types.ts`) was applied first. What remains is the one import line.
  - The re-exports (TitleFor, TranslateFn/Params, AppAction/AppDefinition/AppNode/AppScreen/CommonNodeProps; PublishModal.types: TranslateFn) re-bind the same symbols. They are not new shapes, so one home holds.
  - No other file imports them (git grep). Keep it that way: these files are not barrels.
- `PublishModalProps.app: HeaderApp` is required although the body reads `app?.`.
  - The one TS caller (EditorHeader.tsx:236) always passes a HeaderApp, and every `app.id` deref sits behind `if (!app?.id …) return`.
  - Making it `app?: HeaderApp | null` was tried. It cascades into AudiencePicker `appId: string` (:417) → useAppRoles, so it is not a types-only fix inside this gate. Leave it.
- `(resolveTarget as ResolveTargetFn)` ×2 in PublishModal: the same pattern dryRunIssues.ts:93 has at BASE. resolveTarget.js is untyped (any-typed parameters), so the cast only gives it the documented signature. The added `screenId/screenName/nodeId` match its header ("→ { kind, screenId, screenName, nodeId, label, labelIsText }").
  - Nit: on the automation walker `screenId` can be null, but both call sites pass `kind: 'app'`.
- `DataGrid :pageSize`, `RecordDetail :columns`, `Spacer :steps`, `Table :rowLimit` `as number`: guarded at the site by `Number.isFinite`/`Number.isInteger` in the same ternary.
- logicRows `(value as TableIdHolder).tableId as string`: guarded by `typeof … === 'string'` at the site. `value as TableIdHolder` asserts an `object` to an all-optional shape.
- `source?: unknown` (KeyValue, Repeater), `value?: unknown` (Stat), `peekSource?: unknown` (List): BindingField.types.ts documents `value?: unknown` on purpose. `source?: FieldKeyFieldProps['source']` where the panel hands it to FieldKeyField.
- HeaderNotice now `extends SaveNotice`, and the `as Array<{ path?: string }>` cast in EditorHeader is gone: toSaveNotices returns SaveNotice[]. An improvement.
- SaveStatusPill `PanelNotice` and the generic `SaveNoticesPanel<N>`: honest (`hint` and `target` are read defensively). The only caller passes HeaderNotice.
- NavGroupsDialog `GroupDraft` (≈ navModel's private RawNavGroup with the fields required) and `definition?: NavDefinition | null`: the existing nav view, which ScreenTabs.jsx satisfies with an AppDefinition. Nit, optional: export RawNavGroup and write `type GroupDraft = Required<RawNavGroup>`.
- BuildBanner `PlanTodo { text?: unknown; done?: unknown }`: planStrip reads its entries defensively, and BuilderTodo[] is assignable. `screen?: { id?: string; name?: string } | null`: a nit, `Pick<AppScreen, 'id' | 'name'>` would name the owner.
- PublishModal.types `IssueTarget` (optional ids + screenName) is resolveTarget's hit, not header's RevealTarget (both required). It is a different shape.
- HeaderApp gains `publishedAt`, `published_at` and `nextcloudMenu`: the row carries them (server routes/studioApps.test.js:82-83, appAudience.js:173 `app.nextcloudMenu`), and the index signature was already there.

## Kept JS: spot-check of the reasons
- resize.js: a real blocker. `parseFloat(cs?.paddingLeft)` with `cs` possibly undefined (string | undefined into parseFloat).
- collision.js: a real blocker. `entry?.rect?.current || entry?.rect` reads a ref and a rect through one variable, so typing it needs a lying cast.
- LogicaTab.jsx: a real blocker. `TitleFor = (automationId: string | undefined) => …` (nodeLogicSummary.ts:7), so `automationRows[id]` indexes with a possibly undefined key.
- **InputHtmlInspector.jsx: no blocker visible. Follow-up candidate.** It is the same shape as InputRichtextInspector, which was converted: TextField / TextAreaField / NumberField / Toggle / PrefillField (JS import) and usePatch. It was in neither split, and neither commit gives a reason. Convert it with `PanelProps<{ name?: string; label?: string; placeholder?: string | null; defaultValue?: string | null; minRows?: number | null; required?: boolean; allowImages?: boolean }>`.

## Duplication (production budget 15290)
- 59bdbc84 (la-int + jsdoc + forms): 15088.
- panels1: 15063 (−25). panels2: 15061 (−2). editor: 15172 (**+111**). With Fixes 1-5: 15172. ✅ but it leaves 118 headroom.
- The +111 is logicRows.ts ↔ the mobile port, now that both are TS: rows.ts (39 + 18 + 11 + 11), automations.ts (21 + 11), and logicRows.types.ts:17 ↔ rows.ts:26 LogicRow (13).
- **Mirror candidate** (an integrator step, not this gate): the phone port is split into core/logic/{rows,automations,events}.ts with phone-only `eventsForType(type: unknown)`. Mirror logicRows.types.ts and logicRows.ts into `mobile/src/features/app-studio/mirror/` the b2-B way (generatedRoots + .jscpd ignore). Keep events.ts's eventsForType/eventSlotsOf phone code. Fold rows.ts/automations.ts onto the mirror.
- Test: 26228, at budget.

## Checks run (probe worktree, scratch merge + Fixes 1-5; diff: /tmp/claude-1000/-home-tom-Projects-Bee-Flow/ea43414a-061f-49c2-9608-e64f103495c6/scratchpad/LA-r2-B-fixes.diff)
- typecheck (agent-hub, `HEAVY_SLOTS=2 heavy.sh npm run typecheck`): **0 errors** on the merge, and **0 errors** with Fixes 1-5. The attempt with CommonNodeProps.name nullable gave 8 errors, hence Fix 2's limit.
- Gate on the fixes: the 21 modified .ts/.tsx transpile byte-identical (transpileModule, comments stripped) before and after the fixes.
- eslint, 46 changed files (merge + fixes): **0 errors**, 21 warnings. On the same files at 59bdbc84: 37 → 21 (−16):
  - 12 × import/order and 3 × react-refresh disappear;
  - the 1 × `react-hooks/set-state-in-effect` (BuildBanner's `useEffect(() => { setState(…) })`) disappears too. That one is the known caveat: react-hooks does not run on .tsx, so the warning is unchecked now rather than fixed. The file has no eslint-disable, so the contract allows it.
- vitest (`--maxWorkers=4`, heavy.sh) on AppStudio/editor, AppStudio/inspector (panels included) and AppStudio/chat, with the fixes: **84 files, 911 tests pass**.
- mobile jest: logicRows.lockstep.test.ts (the only test reading a changed path, `editor/logicRows.ts`), **18/18 pass**. No other loadWeb/readFileSync path points at a changed file.
- `node scripts/duplication-ratchet.mjs`: ✅ production 15172 / 15290, test 26228 = budget.
- `node scripts/file-budget.mjs agent-hub`: ✅ none past its ceiling (logicRows.ts 590/590, PublishModal.tsx 565/565).
- Probe worktree removed.

## Merge order
1. jsdoc and forms (their own review), then panels1 with Fixes 1-3 (amend 0ce90b42), panels2 with Fix 2's Modal line (amend d2f1fa87), editor with Fixes 4-5 (amend b8b6730e) and the nit.
2. Then the full agent-hub typecheck, check:fast, duplication-ratchet, the AppStudio vitest dirs above, and the mobile app-studio jest.
3. Follow-ups: InputHtmlInspector conversion; the logicRows mirror; `InspectorPanelProps = PanelProps`.
