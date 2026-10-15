# S1 report: Automation Builder + Agents

- Branch: `ccr-c9112ca0-yggf5c`
- BASE: `81d6bedfc` (= `origin/ccr-28820270-xkvwp8` a3afd896 + `--no-ff` merge of `origin/ts-local/prep2`)
- Final commit: (updated on every push)

## Status
| Step | Package | Status |
|---|---|---|
| 1 | Shared Builder modules (7 files) | drafted on `ts-s1/shared` 5ee68f5b: 2/7 converted; review pending (with batch 22) |
| 2 | Batch 22 + Builder sweep (batches 21-26) | b22 drafted (edba6ad2, 20 converted), Opus review running; sweep A (b23+b26 leftovers) drafting |
| 3 | Batches 19, 20 | drafted (b19 26+5, b20 19+2); merge break found in scratch merge; Opus review running |
| 4 | Long functions LF-A4, LF-A5, agents | characterisation tests merged (8e399b69, 99 tests) |

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
