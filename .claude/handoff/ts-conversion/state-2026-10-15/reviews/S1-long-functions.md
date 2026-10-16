# Opus review S1 long functions (LF-A4, LF-A5, agents) — CHANGES REQUIRED

Paths are relative to `agent-hub/src/components/` unless they say otherwise. "lfint" means the merge at 44616ad7, base cbfa56f1. The required fixes are type-only or follow the catch recipe. None of them changes behaviour. Apply them as one fix-up commit per branch, or as one integration commit on lfint.

## Verified (no action)
- **Gate.** `node scripts/ts-equivalence.mjs cbfa56f1 HEAD --diff` prints "0 identical, 0 different of 0 converted files". That proves nothing: the script only checks renames, and these commits rename nothing. So I ran the script's own `compile()` over every pre-existing TS file the branches modify:
  - Files: `useAgentBootstrapData.ts`, `useAgentSchedules.ts`, `AgentEditorBootstrapContext.tsx`, `agentEditor.types.ts`, `pickers/FilesUploadModal.tsx`, `pickers/SkillPicker.tsx`, `flow/useRibbonFlight.ts`.
  - Result: all **IDENTICAL**. The "id filter" in `useAgentBootstrapData.ts` is really gone, and that file differs from cbfa56f1 by types only.
  - The type widenings are honest. `AutomationRow.id?` and `SkillPicker automations[].id?` are now optional, as the rules require for a field read defensively. `Schedule.id` is required, and every consumer reads `.id` without a guard (ScheduleDeleteModal:27, SchedulePickers:102/209).
- **Repo hygiene.** No test file changed and no budget or ratchet JSON changed. Every JS target is still `.jsx`. New files are at most 301 lines (ValueBuilderViews.tsx). No `any`, `as any`, `as unknown as`, `ts-ignore`, non-null `!`, new `eslint-disable` or `Loose` in new files. No Dutch in new files; the moved Dutch comments were translated.
- **BuilderSplit (2a6e5cdf, security-relevant).**
  - Hook order, all hooks flattened: mounted, skill-picker mousedown, schedules, bootstrap, chat-scroll, tier-sync, the 3 stateRef syncs, focus, agentIdRef, useAgentSave, patchConfig, useBehaviorToggles, useKnowledgeBases, reportedDocCount, onDocCountChange, useCanUseTab, useAgentTests, useUsage, useAgentConceptFacts, the initialRefinement ref/effectEvent/effect, useChatPanelResize.
  - The only move is that chat-scroll now runs after the bootstrap effects instead of before them. Bootstrap effects only start fetches and set state; the scroll effect reads only `chatScrollRef`'s DOM. Unobservable.
  - Tier-sync, snapshot, focus and agentIdRef were already after bootstrap, and they still run before useAgentSave's effects. That is the order that matters for the save snapshot.
  - Deleted state: base references starterPrompts, threadsEnabled, workspaceEnabled, enableGuardrails, llamaGuardEnabled, webSearchGuardEnabled and their setters exactly once each (the declaration). The starterPrompts initializer is pure, and `handleDone` is referenced once. All unobservable.
  - `handleTestAgent` was a new closure every render before, and it still is.
  - `useAgentSave` gets an identical argument object. Publish, embed, conflict, schedule-save and onRename are wired identically. The ScheduleModal `onSaved` await order is unchanged.
  - The modals keep their DOM order. The `enabledIntegrations` and `baseVersion` initializers are equivalent for every input.
- **AgentStudio (ca80af25).**
  - `api/agentStudio.ts`:
    - Same URLs: `/agents/system` or `/agents/all?usage=1` with `signal`, and `DELETE /agents/:id[?confirm=1]`.
    - Same 409 / `!ok` / `res.text()` handling in `useAgentDelete`.
    - "Delete anyway" is still an arrow, `onConfirm(!!deleteBlocked)`, and the Cmd/Ctrl+Enter accelerator still goes through `useEffectEvent`.
    - `onDeleted` closes over the same render's `selectedAgent` as before.
    - `isAbortError` and `messageOf(e, 'Failed to load')` follow the recipe exactly.
  - Unsaved-changes Escape: the listener used to be a no-op while closed. It now mounts with the modal. Its child Modal's effects still run before it, as they did before the move, and both paths only clear `pendingLeave`. Unobservable.
- **AITasksDesigner (6baa4bcc).** The 4 chrome effects, routing and the Cmd+K effect keep their order. `importInputRef` is only used inside the sidebar, which is where it moved. `onPickFromSwitcher({id})` dropping `kind` is unobservable (kind is never read).
- **DiagramPane (87d407a3).**
  - The order of hooks and effects is identical: view, nodeOps/runtime memo, runFocus, layout, live mirror, film (reducedMotion → spotlight → runtimeContextValue), imperative handle, drag wiring, node changes, selection, hotkeys, edge edits, onNodesDelete, ctx menu and its `[definition]` effect, step drop, rendered graph.
  - All deps arrays are byte-identical.
  - `useBuildChoreography` receives exactly the old keys.
  - The ReactFlow flags, handlers and the context menu are identical.
- **StepNodeBase (149f6935).**
  - Same hook order.
  - `executingThis` / `highlighted` / `isPrimaryTrigger` are now `!!`; only truthiness was ever used, and the `as boolean` cast disappeared.
  - Padding `branchHandleCount > 0` is the same as `branchHandles ?` (branchHandles is null when empty).
- **ApprovalFields (77719f49).** `seatSelectValue` / `seatFromSelectValue` / `DirectoryOptions` produce markup and values identical to the inline code they replace, the escalate select included. The section conditions are preserved.
- **RouteFields (e5b82af2).**
  - `useRouteEdits` is a verbatim move.
  - `scoped(condition(i, r))` became `renderCondition`, with the same tree.
  - `itemName` memo moving past `useNoticeFix` is order-irrelevant.
- **BuilderShell (32759710).** The three hooks keep their internal order and deps. `historySlot`'s ExecutionsPanel `() => onOpenEditor()` equals the old `() => setTab('build')`.
- **ValueBuilder (ed0ecb17).** ValueBuilder has no effects, so the moved useState/useRef order is irrelevant. All hooks still run before the early returns.

## Required fixes

1. **Catch recipe violation: `automation/useDesignerShell.ts:129-132`.**
   - The base was `err.message`. The code now reads `err instanceof Error ? err.message : String(err)`, so a non-Error throw now prints the value instead of "undefined". That is a visible change with no `// behaviour:` note, which is item 7 of catch-recipe.md's "Do NOT" list.
   - Replace with:
     ```ts
         } catch (err) {
             console.warn('[AITasksDesigner] template pick failed:', errorMessage(err));
             toast.error(`Could not load template: ${errorMessage(err)}`);
         }
     ```
   - Add `import { errorMessage } from '../../utils/caughtError';`.

2. **Casts from `unknown` without a guard at the site (STATE "Rules that bit us"), all new in these commits.**
   - a. `Builder/mapping/useValuePick.ts:149-150`. Type the source instead of casting. In `Builder/mapping/proposePick.ts` `interface PickRemedies`, above `[key: string]: unknown;`, add:
     ```ts
         /** The picked list's shape (mismatch.js remediesFor); null for a group. */
         shape?: ListShape | null;
         count?: number | null;
     ```
     plus `import type { ListShape } from './listShape';`. Then restore the base line:
     ```ts
             if (chosen.id === 'foreach') setForeachNote({ runs: pick.remedies?.shape?.rows ?? pick.remedies?.count ?? null });
     ```
   - b. `useValuePick.ts:130`, the `apply(...) as {…}` cast. In `Builder/mapping/deepPick.ts` `DeepenHandle`, replace the `apply` line with:
     ```ts
         /** Moves the step to the inner list (integrationActionFields.jsx): `undo` restores it, `orphans` names the fields it could not carry. */
         apply: (plan: DeepenPlan, newItem: Record<string, unknown> | null) => { undo?: (() => void) | null; runs?: number | null; orphans?: string[] } | null | undefined;
     ```
     and write `const res = deepenForEach.apply(deep.plan, deep.newItem);`.
     - deepPick.ts is a mirror source. Run `npm run gen:shared` and commit `mobile/src/features/flow-editor/bindings/mirror/mapping/deepPick.ts`. Then run `npm run lint:shared-mirror` and `cd mobile && npm run typecheck`. No mobile code outside the mirror uses `DeepenHandle`.
   - c. `useValuePick.ts:264`. Type the parameter instead of the call:
     ```ts
     export function useValueParts(value: Parameters<typeof parseValue>[0], onChange: ((binding: unknown) => void) | null | undefined) {
         const parsed = useMemo(() => parseValue(value), [value]);
     ```
     The only caller is ValueBuilder.jsx, which is JS, so the call site is unchanged.
   - d. `Builder/flow/settings/routeAdvanced.tsx:41`. PathField emits a plain string (PathField.jsx:30), so a guard is unobservable:
     ```tsx
                         set={(k: string, v: unknown) => (k === 'arrayRef' ? onChangeSource(typeof v === 'string' ? v : '') : onPatch({ maxItems: v }))}
     ```
   - e. `automation/useDesignerShell.ts:116`. `getTemplate` returns `Promise<unknown>`. Use the same shallow guard as `approvalState.ts isDirectory`:
     ```ts
     function isTemplateReply(r: unknown): r is { template?: TemplateTemplate } {
         return typeof r === 'object' && r !== null;
     }
     ```
     and then:
     ```ts
             const r: unknown = await automationApi.getTemplate(templateId);
             const tmpl = isTemplateReply(r) ? r.template : undefined;
     ```
     A primitive or null reply gives `tmpl` undefined, as `r?.template` did.
   - After the fixes, run in lfint:
     - `heavy.sh npm run typecheck`
     - `npx eslint` on the touched files
     - `heavy.sh npx vitest run src/components/automation/Builder/mapping src/components/automation`
     - `npm run check:fast`

## Per-commit verdict
| Commit | Verdict |
|---|---|
| 77719f49 ApprovalFields | APPROVE |
| e5b82af2 RouteFields | APPROVE after 2d |
| 149f6935 StepNodeBase | APPROVE |
| ed0ecb17 ValueBuilder | APPROVE after 2a–2c |
| 6baa4bcc AITasksDesigner | APPROVE after 1, 2e |
| 32759710 BuilderShell | APPROVE (still >200; see advice) |
| 87d407a3 DiagramPane | APPROVE (still >200; see advice) |
| ca80af25 AgentStudio | APPROVE |
| 2a6e5cdf BuilderSplit | APPROVE |

## Nits (optional, all unobservable today)
1. **`useValuePick.ts`: added guards.** It now has `deep.plan && deepenForEach` and `onRequestForEach?.(…)` (and `pick.shape?.rows` in onListChoice) where the base would have thrown. Both are unreachable: `deepenPick` only returns a plan through the handle, and `canForEach` implies the callback. Separately, `listPick` is dead state: `setListPick` is only ever called with null, in both base and HEAD. That is worth a cleanup ticket, not this PR.
2. **`ValueBuilderViews.tsx`: changed prop defaults.**
   - `MismatchResolver actualKind={… ?? undefined}` would hit the `'list'`/`'text'` defaults where base passed null. It is unreachable: a remedy exists only when `detectMismatch` saw both kinds.
   - The `ListPickChooser` `?? ''` / `?? null` defaults only apply while the chooser is closed.
3. **`routeRuleList.tsx` CaseValueInput, number branch.** `typeof … 'number'|'string' ? value : ''` differs from base for booleans. It is unreachable (the only call site passes `type="unknown"`). For exactness, write `value={value == null || value === '' ? '' : String(value)}`.
4. **`routeRuleList.tsx` RouteValueToCheck.** It passes `label={undefined}` explicitly, which base did not. Drop it, or type PathField's optional `label` at its source later.
5. **`flow/useCanvasNodeChanges.ts:45`.** `changes as NodePositionChange[]` is a downcast. An honest form:
   ```ts
   commitNodePositions(changes.filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position'));
   ```
   It is unobservable because commitNodePositions filters on `type === 'position'` first.
6. **`flow/useBuildFilm.ts:15`.** The `spotlightKeysFor as (…)` function cast is acceptable with its comment. A JSDoc `@param` on ghostDraft.js would remove it later.
7. **`api/agentStudio.ts:8-10`.** The translated docstring dropped half of the Dutch original. Restore it:
   ```
   /agents/system rows carry no usage counts, so the card footer stays silent about them instead of showing a zero. This screen is the one place that shows the answer, so it is the only caller that asks for it.
   ```
8. **`AgentStudio/useAgentDelete.ts:76`.** The recipe form is `setDeleteError(errorMessage(err))`, with the state typed `string | null | undefined`. The `?? null` is harmless.
9. **`useDesignerShell.ts` onPickFromSwitcher.** `item.id ?? null`: base passed `undefined`, which would have set `automationEditing` true. Every switcher item carries an id, so this is unreachable.
10. **`approvalState.ts isDirectory`** only checks "is an object". Base stored any truthy reply as is; the new code maps a truthy non-object to EMPTY. This is unreachable with the real API. Call it `isObjectReply`, or note in a comment that the check is shallow.
11. **`useBuilderState.ts jsonListOf`** returns `any[]` / `JSON.parse` output as `string[]`. That is the same trust the JS had, but it is an implicit any. It is fine for now.
12. **`BuilderShell.jsx`.** The `RunsTab` import moved below `useNdvState`. Import order has no side effect here, but it is a needless diff line.

## Advice: what remains over 200
- **BuilderShell (body ~422).** What is left is real orchestration, but three safe cuts would bring it under 200:
  - (a) Move `onSend`, the auto-send effectEvent/effect and the turn-end effectEvent/effect (≈ lines 205-283) into `useBuilderSend`. Call it at exactly that position, after `useFlowletScope` and before `useBuilderRuns`, so the order of effects stays the same.
  - (b) Turn `headerProps` (381-403) into a pure `buildHeaderProps({...})` in `builderHeaderState.ts`. No hooks, so there is no ordering risk.
  - (c) Move the `<BuilderShellLayout …>` element (405-502) into a `BuilderShellView.tsx` that takes bundles, the way BuilderSplit's `BuilderView` does. BuilderShellLayout is already TSX, so `ComponentProps` types it.
  - (b) and (c) together remove about 120 lines with no change in hook order.
- **DiagramPane (DiagramPaneInner body ≈ 200).** The safe next cut is the wrapper subtree, from `<PresenterContext.Provider>` to the end, as `flow/DiagramCanvasFrame.tsx`. It would receive `view`, `film`, `edit` and the overlay bundle, all hook-free. DiagramOverlays, RibbonFlightLayer and DiagramEmptyState are TSX, so the props can be typed from `ComponentProps`. That leaves about 110 lines. Optionally also fold `onAddAfterForLayout`, the `buildLayout` memo and `useLiveNodeMirror` into `useCanvasLayout`, called at the same position.

## Re-review 9591e4aa + 14456c8d — CHANGES REQUIRED

One required fix, a single line in a new file. Everything else is verified. Once it lands, both commits are APPROVE with no further review round.

### 9591e4aa (review fixes): APPROVE
- **Fix 1.** `useDesignerShell.ts` now matches the required text exactly: `errorMessage(err)` in both the warn and the toast, and the import was added.
- **Fix 2a.** `PickRemedies` gained `shape?: ListShape | null` and `count?: number | null`, with their JSDoc, above the index signature, plus `import type { ListShape }`. `ListShape.rows` is `number | null` (listShape.ts:46). The base line `pick.remedies?.shape?.rows ?? pick.remedies?.count ?? null` is restored. Its two-line brace layout is cosmetic.
- **Fix 2b.** The `DeepenHandle.apply` return type is exactly the required text, and `useValuePick` has no cast. The mobile mirror `mobile/src/features/flow-editor/bindings/mirror/mapping/deepPick.ts` was regenerated with the identical hunk. `npm run lint:shared-mirror` exits 0, every entry matches. No mobile code outside `mirror/` uses `DeepenHandle`.
- **Fix 2c.** `useValueParts(value: Parameters<typeof parseValue>[0], ...)` is as specified, with no cast at the call.
- **Fix 2d.** The `routeAdvanced.tsx` guard `typeof v === 'string' ? v : ''` is as specified.
- **Fix 2e.** `isTemplateReply` and `const r: unknown` / `isTemplateReply(r) ? r.template : undefined` are as specified.
- **Nit 7.** The agentStudio docstring was restored. It is a comment only.
- **No other change.** The commit touches no other runtime code, no test, budget or ratchet JSON, and no JS file.

### 14456c8d (BuilderShell / DiagramPane split): APPROVE after fix 1 below

**DiagramPane**
- `DiagramCanvasFrame.tsx` is hook-free.
- The DOM structure is identical: PresenterContext, then NodeRuntimeContext, then the wrapper div, with the same ref, className, drop handlers, `data-building` and `data-presenter`.
- `DiagramReactFlow` has identical props. `nodeTypes` and `edgeTypes` still get the same module constants, and `onNodeClick` and `handlers` are still `edit`.
- Next come Background, DiagramOverlays, RibbonFlightLayer (same ghosts, rf and nodes) and the ctxMenu/DropHint children, in the same order.
- The `overlays` object has all 39 old DiagramOverlays props with the same values.
- The hooks in DiagramPaneInner are untouched. Only the destructure lost `onDragOver`, `onDragLeave` and `onDrop`, which now arrive through `edit`.
- The added component layer has a stable type, so nothing remounts.

**BuilderShell: hooks, header and view**
- **Hook order and deps are unchanged.** `onSend` was a plain arrow, rebuilt on every render and not a useCallback. It is now `makeBuilderSend({...})`, called once per render.
- **No stale-closure risk.** Every captured name is a per-render `const` declared before line 253: state, serverAutomation, effectiveDef, workMode, alwaysPlanLarge, tierForSend, assistantContext, ndvStepId, scopeKey, send, forceSaveNow, ensureAutomationCreated and setError. The two refs (`readOnlyRef.current`, `turnBaseRef.current`) are still read and written at call time. So capturing the values at factory time equals the old closure.
- **No temporal-dead-zone risk.** `fireAutoSend` (useEffectEvent) references `onSend` declared later in the same render, and it only runs from the mount effect. The old arrow already closed over `forceSaveNow` and `ensureAutomationCreated`, which are declared later, so the timing is unchanged.
- **`buildHeaderProps`** returns the same 45 keys with the same expressions: title, triggerKind, status, canActivate, onAssistant, assistantOpen, primaryTriggerLabel, step, automation/managed, the undo/redo tab jump and breadcrumbSlot. It is pure.
- **BuildTab gets the same props.** I compared the prop-name set mechanically: the 66 base props equal `build` plus the 9 derived ones. Each renamed mapping has the same value (closeFormTest, openFormOverlay, serverAutomation, effectiveDef, tierForSend, setTierForPicker, applyProposal, stopBuild, setNdvMode, handleExecuteStep, retryFromStep, stopRun, handleDismissFatal, layerAgent.state).
- **The derived props are the same expressions:** noop, the `assistantOpen && !readOnly` checks, the `clearReview` arrows, the onApprovePlan text with the same i18n key and default, and `fatalError={error || state.error}`.
- **The rest of the view is unchanged.** VersionsTab and the history slot, the `layout` keys and the `tab ===` gates all match the base.
- **Type widening.** The `buildTabTypes.ts` onSend widening (`approvedPlanId`, `pauseAfterStep`) is honest: onApprovePlan passes exactly those.

**Repo hygiene**
- No `any`, cast, `!`, `eslint-disable` or `ts-ignore` on added lines.
- The JS files stayed `.jsx`. No test, budget or ratchet JSON changed.

**BuilderShell at about 285 lines: accepted.** A `useBuilderSend` that holds the auto-send and turn-end effects would need `draftHistory` and `forceSaveNow` from `useAutomationPersistence`. So it could only be called after that hook. That would move both effects behind the persistence effects, and the turn-end checkpoint and the `state.running` edge are order-sensitive. That reordering is not worth 40 lines. Leave the shell on the long-function list; the ratchet only has to not grow.

### Required fixes
1. **`agent-hub/src/components/automation/Builder/builderSend.ts`, the catch block (catch recipe, the same class as the earlier fix 1).**
   - The block hand-rolls the helper. Base was `setError(error.message || String(error))`, and the recipe token for `V.message || V` is `errorMessage(V) || String(V)`. This is behaviour-identical to the current guard.
   - Replace the whole catch body (the comment, `const message = ...` and `c.setError(...)`) with:
     ```ts
             } catch (error) {
                 c.setError(errorMessage(error) || String(error));
             }
     ```
   - Add `import { errorMessage } from '../../../utils/caughtError';`.
   - Then run, in lfint:
     - `npx eslint src/components/automation/Builder/builderSend.ts`
     - `heavy.sh npm run typecheck`
     - `npx vitest related --run src/components/automation/Builder/builderSend.ts`

### Nits (optional)
1. **`flow/DiagramCanvasFrame.tsx:6`.** `type ReactFlowHandlers = ...` sits between import lines. Move it below the last import.
2. **Needless diff lines.** The `useTranslation` import moved in `DiagramPane.jsx`, and the `RunsTab` import moved again in `BuilderShell.jsx`.
3. **`BuilderShell.jsx`.** The hosting-hooks comment moved from inside the parameter list to above the function. That is fine, but it is now separated from the parameters it documents. Consider a JSDoc `@param` list later.
