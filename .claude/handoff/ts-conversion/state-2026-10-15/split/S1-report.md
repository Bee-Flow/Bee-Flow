# S1 report: Automation Builder + Agents

- Branch: `ccr-c9112ca0-yggf5c`
- BASE: `81d6bedfc` (= `origin/ccr-28820270-xkvwp8` a3afd896 + `--no-ff` merge of `origin/ts-local/prep2`)
- Final commit: (updated on every push)

## Status
| Step | Package | Status |
|---|---|---|
| 1 | Shared Builder modules (7 files) | drafted on `ts-s1/shared` 5ee68f5b: 2/7 converted; review pending (with batch 22) |
| 2 | Batch 22 + Builder sweep (batches 21-26) | batch 22 drafting on `ts-s1/batch-22` (on top of `ts-s1/shared`) |
| 3 | Batches 19, 20 | drafting |
| 4 | Long functions LF-A4, LF-A5, agents | pending |

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
