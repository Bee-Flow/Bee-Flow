# Opus review S1 b19/b20 — CHANGES REQUIRED

Paths are relative to `agent-hub/src/components/agents/` unless they say otherwise. "merge" means the scratch merge at 874608af.

## Verified (no action)
- Gate: b19 `81d6bedfc..e79a8d0c` reports 26 identical and 0 different. b20 `81d6bedfc..a598dfe3` reports 19 identical and 0 different. No file kept as JS differs from BASE in either branch (each batch path checked with `git diff --quiet`). The only non-TS edits are `.file-budget.json` (key rename, b19) and `ci.yml` (b20).
- Second commits: every changed token follows catch-recipe.md.
  - b19 01bab256 (5 files):
    - `messageOf` replaces `err.message || '<lit>'` at 3 sites in builderSplitActions.
    - `String(errorMessage(err) || err || …)` at the hand-check site (builderSplitActions:171).
    - `isAbortError` at 2 sites in AgentEditorBootstrapContext.
    - `errorMessage` in refineActions; `ChatMessage.content?` already allows undefined.
    - `messageOf` in useAgentApi and useKnowledgeBases, where `toast.error` takes a string. Both carry a `// behaviour:` note.
  - b20 3d5784b0 (2 files):
    - useAgentAutosave:110 now reads `String(errorMessage(err) || err || 'Saving failed.')`, which is the recipe's hand-check form.
    - FilesUploadModal makes 3× `setError(errorMessage(err))` with the state typed `string | null | undefined`.
    - There is a `// behaviour:` note.
- Security-relevant files: agentSaveApi, ShareLinksMenu, PublishMenu (an R100 re-export), EnableEmbedConfirmModal and deleteBlock are identical under the gate. useAgentAutosave differs only by the one recipe token. Zero logic change.
- Assertions accepted:
  - agentSaveFlows.ts:85 `res.version as number` sits behind `Number.isInteger(res.version)` on the same line. `SaveResult.version: number | undefined` is honest: agentUpdate.js:217 answers `{success:true}` without `rev`.
  - personaFacts.ts `input.mode as string` and `unknown.mode as string` sit behind `.includes()` on a string-only tuple in the same expression.
  - ShareLinksMenu `as Node | null` keeps the null.
  - CategoryField.tsx:60 `(e.target as Element)`: a dispatched mousedown always has a target, the JS dereferences it unguarded too, and `closest?.` covers non-Element targets.
- personaFacts.ts dropped `// eslint-disable-next-line no-control-regex`. Correct: eslint on the .ts reports nothing (the rule is not active for TS), so the directive would be unused. Say so in the commit message.
- API types checked against the server: `SaveResult` conflict and limit (agentUpdate.js:193-221), `AgentListRow` (all optional, defensive), `ToolApp`, `SavedAgent`.
- ci.yml: the refineMerge.js → .ts rename in the `mobile` filter is right and complete. No other reference exists in scripts/.github; the lockstep only imports types beyond that file. In merge: `lint:checks` OK, `lint:workflows` OK (17 workflows), `check:fast` 39/39, duplication 15231 ≤ 15419, mobile `refineMerge.lockstep.test.ts` 12/12.
- Importers: no import or require with a stale extension. The mobile lockstep `require(...refineMerge.ts)` passes under jest.

## Required fixes

1. **MERGE BREAK (10 TS errors, refineActions.ts:215-233): type-only overloads on `mergeRefinedPlan`.**
   - A full text snapshot in gives `string` text fields out. That is honest: each field is `updated.X` (narrowed to a non-empty string) or `current.X`.
   - The caller and its setters stay as they are.
   - Also fix `RefinePlan.model`: wizard.js:315 `normalizePlan` sets `plan.model = … : null`.
   - Verified in scratch (`scratchpad/fixcheck/`): `tsc --strict` is clean on the refineActions shape. A partial snapshot still yields `string | undefined`. Emitted JS is identical apart from the JSDoc, which esbuild drops (`legalComments:'none'`).
   - Apply as an integration commit on top of b19+b20 (it only matters once both are in).

   `state/refineMerge.types.ts`, insert above `/** The live editor state \`buildRefineContext\` reads. */`:
   ```ts
   /** A snapshot with all five text fields present, as the editor's live state has them. */
   export type FullRefineSnapshot = RefineSnapshot & Required<Pick<RefineSnapshot, 'name' | 'description' | 'systemPrompt' | 'avatar' | 'model'>>;

   /** What `mergeRefinedPlan` returns; the text fields are `string` when the snapshot passed in had them all. */
   export interface MergedRefinePlan<Text extends string | undefined = string | undefined> {
       name: Text;
       description: Text;
       systemPrompt: Text;
       avatar: Text;
       model: Text;
       config: RefineConfig & {
           enabledIntegrations: string[];
           attachedSkillIds: string[];
           knowledge_base_ids: string[];
           wizard: { capabilities: string[] };
       };
       persona: PersonaLike | null | undefined;
   }
   ```
   In `RefinePlan`, change `    model?: string;` to:
   ```ts
       /** `null` when the server found no selectable tier (routes/agents/wizard.js normalizePlan). */
       model?: string | null;
   ```
   `state/refineMerge.ts`, the import block:
   ```ts
   import type {
       FullRefineSnapshot, MergedRefinePlan, MergeOpts, PersonaFields, PersonaLike, RefineChange, RefineConfig, RefinePlan,
       RefinePreserved, RefineSnapshot, RefineState,
   } from './refineMerge.types';
   ```
   and replace the signature line `export function mergeRefinedPlan(current: RefineSnapshot = {}, …, opts: MergeOpts = {}) {` with:
   ```ts
   export function mergeRefinedPlan(current: FullRefineSnapshot, updated?: RefinePlan, preserved?: RefinePreserved, opts?: MergeOpts): MergedRefinePlan<string>;
   export function mergeRefinedPlan(current?: RefineSnapshot, updated?: RefinePlan, preserved?: RefinePreserved, opts?: MergeOpts): MergedRefinePlan;
   export function mergeRefinedPlan(current: RefineSnapshot = {}, updated: RefinePlan = {}, preserved: RefinePreserved = {}, opts: MergeOpts = {}): MergedRefinePlan {
   ```

2. **b19 AgentStudio/deleteBlock.ts:39: the generic predicate `isObj<T>(v): v is T` over the untrusted 409 body is an unchecked cast.**
   - `isObj<Record<string, number>>(body.counts)` and `isObj<{ othersConversationCount?: number | null }>(body.chat)` assert number types that the JSON may not have.
   - The `Number.isFinite` guards are real, but they do not narrow `unknown`. An honest type therefore needs `typeof n === 'number'`, which is a runtime change.
   - The `undefined` in `DeleteBlockSummary.othersChats: number | null | undefined` exists only because of that cast.
   - Fix: revert it to JS, byte-identical to BASE:
     ```
     git mv agent-hub/src/components/agents/AgentStudio/deleteBlock.ts agent-hub/src/components/agents/AgentStudio/deleteBlock.js
     git checkout 81d6bedfc -- agent-hub/src/components/agents/AgentStudio/deleteBlock.js
     ```
   - All importers are extensionless; cardFooter.ts reads `USAGE_KINDS` from JS fine.
   - Kept-JS label: `runtime: Number.isFinite does not narrow unknown (counts values, chat.othersConversationCount)`. This is phase 2: add `typeof n === 'number' &&` plus a test.

3. **One home for `RefineChange`.**
   - builderSplit/RefineDoneCard.tsx:6 (b19) re-declares the shape that state/refineMerge.types.ts:74 (b20) owns.
   - The card reads it defensively (`change || {}`), so it takes the Partial.
   - Replace line 6 with:
     ```ts
     import type { RefineChange as MergedRefineChange } from '../state/refineMerge.types';

     /** One field the refine touched, from `state/refineMerge.diffRefinedPlan`; read defensively. */
     export type RefineChange = Partial<MergedRefineChange>;
     ```
     The import goes with the other imports at the top.
   - This is an integration commit; it needs b20.

4. **One home for `KnowledgeBaseRow`.**
   - pickers/FilesUploadModal.tsx:10-16 (b20) is a verbatim copy of the exported `KnowledgeBaseRow` in builderSplit/useKnowledgeBases.ts:8 (b19).
   - Delete the local interface and its doc line, and add `import type { KnowledgeBaseRow } from '../builderSplit/useKnowledgeBases';`.
   - This is an integration commit; it needs b19.

5. **One home for org groups (b19).**
   - agentEditor.types.ts:34 `OrgGroupRow` is identical to `OrgGroup` in AgentDesigner/PublishMenu.tsx:7. AgentCard and AgentOverview in this same batch already use that one.
   - agentEditor.types.ts: delete lines 33-34, add `import type { OrgGroup } from '../AgentDesigner/PublishMenu';`, and change `orgGroups: OrgGroupRow[];` to `orgGroups: OrgGroup[];`.
   - AgentEditorBootstrapContext.tsx:16: drop `OrgGroupRow` from the import and add `import type { OrgGroup } from '../AgentDesigner/PublishMenu';`. Line 52 becomes `useState<OrgGroup[]>([])`.

6. **One home for `ReadState`.**
   - agentEditor.types.ts:9 owns it.
   - b19 builderSplit/useAgentConceptFacts.ts:8: delete `type ReadState = (typeof READ)[keyof typeof READ];` and add `import type { ReadState } from '../agentEditor.types';`.
   - b19 builderSplit/useKnowledgeBases.ts:43: use `useState<ReadState>(READ.LOADING)` with the same import.
   - b20 canUse/useCanUseSources.ts:39,41 and canUse/useToolCatalog.ts:65,67: change `useState<string>(READ.LOADING)` to `useState<ReadState>(READ.LOADING)` with `import type { ReadState } from '../agentEditor.types';`. This part is an integration commit.
   - Optional in the same pass: builderSplit/useAgentBootstrapData.ts:18 (a pre-existing copy).

7. **b20 a598dfe3: the commit message lists no kept-JS files.**
   - 17 batch-20 paths stayed JS with no reason given. The drafter brief requires the label `blocker <file>`, `runtime: <construct>` or `react-hooks disable`. None has a react-hooks disable.
   - Amend the message with the list. See the retry list for the ones that look convertible.

## Optional nits
- CategoryField.tsx:61 `contains(e.target as Node)` → `contains(e.target as Node | null)`. `contains` accepts null, which matches ShareLinksMenu.
- Near-duplicate shapes to fold later:
  - AgentDesigner/hooks/useAgentState.ts:16 `AgentCategory` vs agentEditor.types `CategoryRow`.
  - AgentDesigner/integrationAvailability.ts:13 `IntegrationAvailabilityStatus` vs `IntegrationStatus` in DesignerPanels.tsx:21. One should extend the other.
  - builderSplit/useAgentConceptFacts.ts:6 `ConceptPersona` vs refineMerge.types `PersonaLike`.
- useAgentApi.ts: two blank lines in the destructuring block were deleted (diff lines 53 and 61). This is whitespace noise; restore them.
- refineActions.ts:126 `const { plan: updated, preserved } = await res.json();` is implicit any. Phase 2: give `RefinePlan` `skills?` and `schedule?` (wizard.js:323-360) and type this read.
- Stale `.js`/`.jsx` names in comments:
  - mobile/src/features/agents/model/refineMerge.ts:3 and refineMerge.lockstep.test.ts:2 (`refineMerge.js`).
  - AgentStudio/agentCardFacts.ts:277 (`./cardFooter.js`).
  - role/RoleCard.tsx:58 (`AgentOverview.jsx`).
  - onboarding/tourAnchors.ts:31 (`ToolsSection.jsx`).
  - AgentWizard/BuilderSplit.jsx:302/311/322 (`builderSplitActions.js`).
  - Leave the server ones (crud.validation.test.js:384, crudSchemas.js:65, published.js:59) for a server pass.
- Widening that is acceptable but worth a comment at the site: personaFacts.ts `PERSONA_MODES`/`UNKNOWN_MODES: readonly unknown[]` (no importers), and useAgentState.ts `VALID_DESIGNER_SECTIONS: (string | null)[]`. Both exist only to let `.includes(x)` typecheck.

## Merge notes
- b22 + b19 + b20 + characterisation merge cleanly (874608af). The only merged-tree errors are the 10 in fix 1.
- Order:
  1. Merge b19 with fixes 2, 5 and 6 (b19 part).
  2. Merge b20 with fix 7.
  3. Add one `fix(ts): unify b19/b20 shapes` commit with fixes 1, 3, 4 and 6 (b20 part). It is types-only: `ts-equivalence <merge> HEAD --diff` must report 0 different.
- After the fixes, in the merged tree:
  - `cd agent-hub && heavy.sh npm run typecheck` → 0.
  - `heavy.sh npx vitest run` on:
    - `src/components/agents/AgentWizard/state/refineMerge.test.js`
    - `src/components/agents/AgentWizard/builderSplit/refineActions.test.js`
    - `src/components/agents/AgentWizard/BuilderSplit.test.jsx`
    - `src/components/agents/AgentStudio/` (deleteBlock and cardFooter)
    - the FilesUploadModal and RefineDoneCard tests
  - Mobile lockstep (12/12 now).
  - `check:fast`.
  - `node scripts/duplication-ratchet.mjs`.
  - `npm run lint:budget`: the .tsx files now report complexity and max-lines warnings, for example CategoryField and personaFacts. check:fast does not cover this.
  - Then `node scripts/ts-ratchet.mjs agent-hub --update`.

## Retry list (convertible now that b19 and b20 are both in)
- **Catch recipe only:**
  - AgentStudio/index.jsx: `isAbortError`, `messageOf(e, 'Failed to load')` and `errorMessage(err)` for `setDeleteError`. Its stated blocker is BuilderSplit's, not its own.
  - VersionHistory.jsx.
  - AgentWizard/index.jsx (a draft exists at `scratchpad/b20c2/index.tsx`).
  - builderSplit/BuilderConfigPanel.jsx: SkillPicker is TS now. `toast.error(err.message)` → `messageOf` with a behaviour note. Check SchedulesPicker's JS defaults for `never[]`.
- **CanUseCard is now TS:** canUse/KnowledgeCard.jsx, canUse/SkillsCard.jsx, canUse/ToolsCard.jsx.
- **No reason stated; try them:** canUse/{canUseFacts,toolGrants,toolChooserModel}.js, canUse/ToolChooser.jsx, pickers/{AdvancedDrawer,AvatarPicker,BehaviorPicker,ExternalShareSection,SchedulePickers}.jsx, tests/{TestSetCard.jsx,testSetFacts.js,useAgentTests.js}. ExternalShareSection only does `getTime()` minus a number, which is typeable.
- **AgentSkillsTab.jsx:** a local row type with `name: string` is honest if `skills.name` is NOT NULL on the server. The code reads `description?.` defensively but `name` directly. Then retry AgentEditorUI.jsx and AgentDesignerPanel.jsx.
- **Verified true, stay JS:**
  - useAgentChat.js (`res.body.getReader()`).
  - IdentitySection.jsx (`ev.target.result`).
  - AgentMarketplace.jsx:220 (Date − Date).
  - PlanCard.jsx:27.
  - DeleteBlockedNotice.jsx:68.
  - BuilderSplit.jsx:139 (`Number.isInteger(initialAgent?.rev) ? initialAgent.rev`).
  - AgentEditorHeader.jsx and BuilderChatPanel.jsx (blocked by the above).
  - deleteBlock.js after fix 2.
