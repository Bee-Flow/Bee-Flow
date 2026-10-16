# S1 report: Automation Builder + Agents

- Branch: `ccr-c9112ca0-yggf5c`
- BASE: `81d6bedfc` (= `origin/ccr-28820270-xkvwp8` a3afd896 + `--no-ff` merge of `origin/ts-local/prep2`)
- Final commit: (updated on every push)

## Status (final, 2026-10-16)
| Step | Package | Status |
|---|---|---|
| 1 | Shared Builder modules (7 files) | done: 2/7 TS (formDensity, formPrimitives); 5 kept JS (labels below) |
| 2 | Batch 22 + Builder sweep (batches 21-26) | done: b22 20 + retries 2, sweeps A+B 12 (+HttpAuthPicker); rest kept JS (labels below) |
| 3 | Batches 19, 20 | done: 51 + retries 4 (+ AgentConfigHub from batch 18, agreed with the integrator) |
| 4 | Long functions LF-A4, LF-A5, agents | done: 8/9 targets under 200 lines; BuilderShell left at ~285 by review decision |
| - | SWEEP-C | not started (moved to a laptop session by the user) |

Final commit: see the last push of `ccr-c9112ca0-yggf5c` (this report is in it). Contains the convert branch up to `0ae29a17`.

## Scope notes
- `agents/AgentWizard/builderSplit/useKnowledgeBases.js` is 80 lines and has no function over 200 lines; the
  long-function entry is `hooks/useKnowledgeBases.ts` (LF-A9), outside S1's scope. Nothing to do there.
- `components/apps/appCatalog.jsx` (batch 21) is outside S1's scope (not under automation/).

## BASE
`81d6bedfc` was red on two inherited checks (duplication 15423 > 15419 from prep2's resolveBinding.ts vs its
mobile port; mobile serverClosure.test.ts via a template-literal path in serverContract.test.ts). Both were fixed
on the convert branch at `95b13ce7`, merged into S1 as `9e926eb6` (no files in S1's scope changed). Drafting
worktrees stay on `81d6bedfc` (the gate base); integration is on top of `9e926eb6`. Pushes are gated on the
normal all-green rule.

## Step 1: shared Builder modules (draft 5ee68f5b, gate `2 identical, 0 different`)
Converted: `flow/settings/formDensity.ts`, `flow/settings/formPrimitives.tsx`.
Kept JS:
- `flow/displayHelpers.js`: runtime: `tokens?.length > 1` (readsAsRecords, TS18048 on a nullable token list) and
  `FILE_TYPE_EN.get(raw)` (ruleValue). The blockers-2C draft did not typecheck on BASE. TS importers keep working on
  the inferred/JSDoc types, so it does not block batch 22.
- `flow/nodeDefs.js`: runtime: `NODE_DEFS[type]` with `type: string | null | undefined` (read(), stepFamily(); TS2538).
  Needs `NODE_DEFS[type ?? '']`-style change → phase 2 (runtime case with a test).
- `flow/AccordionSection.jsx`: blocked by `flow/CollapsibleSection.jsx` (batch 22; `= null` defaults infer null-only props) → retried in batch 22.
- `flow/settings/collectionEditors.jsx`: blocked by `mapping/PathField.jsx`, `mapping/ToolInputForm.jsx`, `mapping/FieldKeyCombobox.jsx` (batch 26) → sweep.
- `mapping/TemplateField.jsx`: react-hooks disable (`set-state-in-effect`).
Mobile: `density.lockstep.test.ts` path + regex tolerates the `(NODE_DEFS as …)` upcast; `FieldRow.tsx` comment path.

## Characterisation tests (8e399b69, merged 05090737)
99 tests in 5 files, each passed 3× in a row: AgentStudio (26), AITasksDesigner (12 + 21 panes), ApprovalFields (22),
BuilderSplit panels (18); helpers `test/automationDesignerHarness.tsx`, `test/automationDesignerStubs.tsx`.
Ratchets: fire-event 4230 (unchanged, userEvent only), module-mock 0 (unchanged; that metric counts require.cache tricks,
not vi.mock), 12 new `vi.mock` calls (authFetch in helpers; BuilderShell/AutomationsLauncher stubs in the designer tests).
Note: the designer fetches the Steps list twice at mount (mount effect + builder-closed effect); the test asserts ≥ 1.

## Scratch merge (874608af: integration + b22 + b19 + b20 + tests)
No textual conflicts (.file-budget.json and ci.yml auto-merged). check:fast 39/39; duplication 15231 (-144 vs 15375);
vitest components/{agents,automation,appearance} 528 files / 5910 pass; agent-hub typecheck: 10 errors, all
`builderSplit/refineActions.ts:215-233` (b19 typed against JS refineMerge; b20's refineMerge.ts returns optional fields) → fixed at integration.

## Integration (push of 23f88adf)
- `0343f810` merge of ts-s1/builder-int: b22 + shared, review fixes (e029ad2e: one home for FormDensity/FormMode, JsonTree
  `onCopyPath` nullable, `piiLineColors` nullable, `AppCategory` reuse), redundant casts dropped (445a09ee: ScalarValue,
  RecordTable.paths.test, useNdvState, codeFields, httpQuerySection, FlattenFields, ribbon/jsComponents, modalOverlays.test),
  retries edgeColoring.ts + ScheduleBuilder.tsx (+ messageOf). Kept JS: LineColorPanel.jsx, CanvasSouthBar.jsx
  (runtime: `string | null` from resolveEdgeColor/statusVar into `style.background`, TS2322).
- `058f7881` merge of ts-s1/agents-int: b19 + b20 with review fixes (cdc5d5b4, 4a02f877: mergeRefinedPlan overloads,
  RefineChange/KnowledgeBaseRow/OrgGroup/ReadState one home; deleteBlock back to JS), retries KnowledgeCard, SkillsCard,
  ToolsCard (+ ToolsCard.types.ts), BuilderConfigPanel (messageOf; behaviour: fallback toast instead of an empty one).
- `23f88adf` merge break convert-branch b10 × S1 b20: `AutomationSummary extends CallableAutomation` (types only).
- `71aac662` test duplication: the two AITasksDesigner characterisation files merged into one (budget lowered to 26228 by the integrator).
- Gate `node scripts/ts-equivalence.mjs 81d6bedfc HEAD`: `277 identical, 9 different of 286 converted files`; the 9 are exactly
  the caughtError files (useAgentApi, AgentEditorBootstrapContext, BuilderConfigPanel, builderSplitActions, refineActions,
  useKnowledgeBases, FilesUploadModal, useAgentAutosave, ScheduleBuilder).

## Kept JS in S1's scope (labels)
Agents (batches 19/20):
- runtime: useAgentChat (`res.body.getReader()` nullable body), IdentitySection (`ev.target.result`), AgentMarketplace:220
  (Date − Date), PlanCard:27 (`capabilities?.length > 0`), DeleteBlockedNotice:68 (nullable `> 0`), deleteBlock.js
  (`Number.isFinite` does not narrow unknown), toolGrants (`Map.get(k).push`), AvatarPicker (`ev.target.result`),
  BehaviorPicker (optional callbacks called unguarded), SchedulePickers (Date arithmetic), testSetFacts (`Math.min` of
  nullable numbers), TestSetCard (nullable `> 0`), VersionHistory (`prompt.length` after a separate guard),
  ExternalShareSection (`s.url` narrowing lost in the onClick closure), BuilderSplit:139 (`Number.isInteger(initialAgent?.rev)`).
- blocked by: AgentStudio/index, AgentWizard/index → BuilderSplit.jsx; ToolChooser → shared/AppActionPicker.jsx;
  toolChooserModel → toolGrants.js; AdvancedDrawer → BehaviorPicker; useAgentTests → testSetFacts.js; AgentSkillsTab →
  api/queries/skills.ts `Skill.name` optional (server column NOT NULL; tightening that shared type unblocks it);
  AgentEditorUI → AgentSkillsTab; AgentDesignerPanel → AgentEditorUI; BuilderChatPanel → PlanCard.jsx.
- blocked by b2: AgentEditorHeader (StudioSectionHeader), canUseFacts.js (owned elsewhere).
Builder (shared + b22 + retries):
- runtime: displayHelpers (`tokens?.length > 1`), nodeDefs (`NODE_DEFS[type]`, nullable type, TS2538), aiToolNodes
  (`definition.steps.slice()` optional steps), appLabels (`BASE_APP_LABEL[integrationId]`, `= null`), arrange
  (`Map.get().push`), branchEdges (`want.label.slice(5)`, nullable), buildChoreography (`now - lastMoveAt`, null),
  dagreLayout (`s.position.x` after a non-predicate guard), dataSummary (`value.total` unknown), edgeHops
  (`.filter(Boolean)`), flowOrder / flowletScope / inlineFlowlets (`Map.get().push/add`), ghostDraft (string index into
  JS INTEGRATION_META), CanvasZoomStack (`onClick={x}` with `= null`), LineColorPanel / CanvasSouthBar (nullable style value).
- blocked by: CallContractFields → mapping/ValueBuilder.jsx; ToolPicker → shared/AppActionPicker.jsx; SettingsForm → settings
  editors; collectionEditors → PathField/ToolInputForm/FieldKeyCombobox; appRefLabel → b2 (utils/helpers.js, admin/Studio/studioRoutes).
- react-hooks disable: edges.jsx, mapping/TemplateField.jsx.

## Watch at merge (integrator)
- `.github/workflows/ci.yml`: b20 renamed the mobile filter path `refineMerge.js` → `.ts` (lint:checks / lint:workflows OK).
- `.file-budget.json` key renames: AddStepMenu, ToolsCard, triggerEditors, triggerFilters (sweep B), renamed files of b19.
- Mirror candidate: `flow/datetimeTarget.ts` → mobile `bindings/flowDeps/datetimeTarget.ts` (manifest entry in reviews/S1-builder-shared-b22.md).
- Unrelated flake seen under load: `pages/webpages/WebpageIDE.i18n.test.jsx` → 3 unhandled rejections from
  `useBfMarks.ts:57` (setState after jsdom teardown); vitest exits 1 although all tests pass; passes 3/3 alone.

## Builder sweeps A + B (merged cbfa56f1, review reviews/S1-builder-sweeps.md)
Converted: presenterMode.ts, nodes/{Guard,Loop,Tokenize,Trigger,Untokenize}Node.tsx, mapping/fieldChrome.tsx,
mapping/FieldKeyCombobox.tsx (+ focusField.types.ts), stepIcons.tsx, settings/{SetOperationsEditor,triggerEditors,
triggerFilters}.tsx (+ .types.ts), HttpAuthPicker.tsx (caughtError, + hooks/useAutomationApi.types.ts).
Review decision: `(humanizeExpression as HumanizeExpression)(…)` is an accepted honest widening (JS default `= null`
infers a null-only parameter; the body handles a Map); the TriggerNode hidden `any` was removed. Follow-up for the
integrator: a JSDoc `@param {Map<string, string>|null} [stepLabelById]` on displayHelpers.js:73 (comment-only) removes
all five casts.
Kept JS (sweeps): ribbonOrigin, nodeSummaries, DatatableNode, KnowledgeWriteNode, NoteNode, LoopBodyEditor
(runtime: `MAP[optionalKey]`, TS2538), layout.js + dagreLayout (`s.position.x` after a non-predicate guard),
CallFlowletNode (nullable callback called unguarded), FieldPicker (`Map.get().push`), ToolInputForm
(`includes(string | null)`), ValueBuilder (`= null` callbacks called unguarded), RefTokenInput (`placeholder` on a
contenteditable div), ConditionBuilder (TS ConditionRow vs RuleRow, would loosen an existing TS file), AiStepNode
(blocked by aiToolNodes.js), routeModel (blocked by branchEdges.js), DryRunPanel (`layers[step.layerKey]`), RouteAssist
(runtime guards only); react-hooks disable: BindingField, PathField, VariablePicker, TemplateField, useFormModePreference,
FormRunOverlay. Settings editors blocked by those mapping fields: FormBuilderFields, approvalEditors, returnToAppEditor,
knowledgeWriteEditors, actionEditors/{document,httpRequest,notification,presentation,slide,stopError,dataExtraction,
integrationAction,loop,flowletCall}Fields, ParseJsonFields, setEditors, collectionEditors, privacyEditors, routeEditors,
TablesRowValuesEditor, datatableEditors, approvalStages, aiStepEditors; then SettingsForm → SettingsHost → NodeDetailView,
DiagramPane → RunExecutionView, FloatingValidationPill (shared/FindingRow.jsx), ApprovalActionBar
(Studio/Approvals/ApprovalDecisionControls.jsx), BuilderShell (Studio ExecutionsPanel.jsx).
The b2 retry round (after helpers.ts/useConfirm/canUseFacts.ts) unblocked nothing more in S1 scope.

## Long functions (merged d4763739; reviews/S1-long-functions.md incl. re-review)
File lines before → after (base cbfa56f1); 58 new .ts/.tsx files, JS targets stayed JS:
| Target | Lines | >200 list |
|---|---|---|
| flow/settings/approvalEditors.jsx `ApprovalFields` | 708 → 108 | off |
| flow/settings/routeEditors.jsx `RouteFields` | 725 → 238 | off |
| flow/nodes/StepNodeBase.tsx | 728 → 316 | off |
| mapping/ValueBuilder.jsx | 861 → 281 | off |
| automation/index.jsx `AITasksDesigner` | 640 → 321 | off |
| Builder/DiagramPane.jsx | 812 → 306 | off |
| Builder/BuilderShell.jsx | 566 → 423 | still on (~285-line function) |
| agents/AgentWizard/BuilderSplit.jsx | 753 → 208 | off |
| agents/AgentStudio/index.jsx | 494 → 224 | off |
agent-hub long-function count: 269 at BASE → 249 at the final head (includes other sessions' work; S1's share is 8).
Behaviour differences (Opus-verified as unobservable): BuilderSplit drops six never-read useStates and the unused
handleDone; its chat-scroll effect now runs after the bootstrap effects (bootstrap only starts fetches); AgentStudio's
unsaved-changes Escape listener mounts with the modal (it was a no-op while closed). Save/autosave/publish/embed/delete
paths unchanged. New `src/api/agentStudio.ts` (list + DELETE moved verbatim; keeps the authFetch ratchets).
BuilderShell stays above 200 by review decision: a useBuilderSend hook would need values from useAutomationPersistence
and would move the auto-send/turn-end effects behind the persistence effects (order-dependent).
Mirror: `deepPick.ts` source changed (DeepenHandle.apply return type), mobile copy regenerated via gen:shared.

## Gate at the final head
`node scripts/ts-equivalence.mjs 81d6bedfc HEAD` covers every session's conversions since BASE; S1's own DIFFERENT files
are exactly the 10 caughtError files (useAgentApi, AgentEditorBootstrapContext, BuilderConfigPanel, builderSplitActions,
refineActions, useKnowledgeBases, FilesUploadModal, useAgentAutosave, ScheduleBuilder, HttpAuthPicker).

## Ratchets measured at the final head (no --update run)
long-function agent-hub 249 (budget 257), ts-ratchet 1942 .js/.jsx (budget 1955), duplication production 15070
(budget 15290) / test 26228 (at budget), check:fast 39/39.

## Reviews
reviews/S1-agents-b19-b20.md, S1-builder-shared-b22.md, S1-builder-sweeps.md, S1-long-functions.md (+ re-review section).
