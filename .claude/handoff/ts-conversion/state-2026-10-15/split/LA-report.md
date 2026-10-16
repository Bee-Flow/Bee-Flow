Status: round 1 drafted and merge-tested locally (not yet on this branch, Opus reviews running); round 2a drafting (JSDoc on shared JS blockers, form inputs, MAP-lookup rewrites, editor)
Done: 0/153 files on this branch (21/153 converted locally, awaiting review), 0 packages merged
Next: integrate round 1 after its two Opus reviews + full checks, push (ETA ~2 h); then round 2a, then 2b (inspector panels, flow, bi, inspector rest)

# L-A report: App Studio sweep (agent-hub/src/components/admin/Studio/AppStudio/**)

Branch `ts-laptop/sweep-a`. BASE `0ae29a17` (origin/ccr-28820270-xkvwp8 at session start).
Final commit: see `git log -1` of the branch (this file is updated with every push).

## Plan
Packages follow the dependency layers, not directories (round-1 yield showed that shared JS modules block their importers):
- Round 1 (leaf/shared layer, 6 packages): core (api, state, variables, chat), inspector logic + shared panels + bi hooks, runtime core + shell, runtime components ×2, tables + rbac.
- Round 2a: JSDoc-only typing of shared modules that must stay JS (formContext.jsx, BindingField, ExpressionInput, ConditionField, FormulaField, dataErrors, gridColumnFilters, cellValue) so their TS callers stop inferring `null` props; form inputs on the typed form context; a runtime-equivalent `MAP[k]` → `k == null ? undefined : MAP[k]` rewrite package (the b2-B pattern, tests before/after, Opus review); editor.
- Round 2b: inspector/panels (30), flow, bi rest, inspector rest. Round 3: sweep of what is still blocked.

## Status per package
| Package | Converted | Status | Gate | Review |
|---|---|---|---|---|
| r1-core | 7/12 (5 types + 2 catch recipe) | merge-tested | 5 identical, 0 different | pending (reviews/LA-r1-A.md) |
| r1-insp | 5/14 (4 + 1 catch recipe) | merge-tested | 4 identical, 0 different | pending (LA-r1-A) |
| r1-tables | 2/9 (1 + 1 catch recipe) | merge-tested | 1 identical, 0 different | pending (LA-r1-A) |
| r1-rt | 4/16 | merge-tested | 4 identical, 0 different | pending (LA-r1-B) |
| r1-comp2 | 3/21 | merge-tested | 3 identical, 0 different | pending (LA-r1-B) |
| r1-comp1 | 0/21 (blocked by formContext.jsx types → JSDoc d4aab1c0; MAP lookups → rewrite package) | re-queued in round 2a | — | — |
| formContext.jsx JSDoc (d4aab1c0) | comments only, stays JS | merge-tested | n/a | pending (LA-r1-B) |

Round-1 merge test (all five + d4aab1c0): one import-line conflict in inspector/appDefinition.ts (both sides kept), agent-hub typecheck 0, gate BASE..merge 17 identical / 4 different (exactly the 4 catch-recipe files), duplication production 15088 ≤ 15290, test 26228 = budget.

## Kept JS (round 1, with reason)
To be filled per package at integration. Recurring reasons: `new Date(unknown)` / Date arithmetic; `Map.get(k).push`; nullable state read in a closure; `runAction(node.onX)` in a callback (an undefined id reads action key "undefined", so widening runAction's type would lie); blocked by automation/Builder/mapping/ConditionBuilder.jsx and VariablePicker.jsx (outside L-A scope: `= null` defaults); unknown form value into `<input value>`.

## Needs integrator
- Nothing yet.

## Merge watch-points
- inspector/appDefinition.ts gains `meta?: AppMeta`, `design?: AppDesign`, `repeat?`/`forEach?: BindingInput` (round 1).

## Push log
| Pushed commit | Content | check:fast | server typecheck | duplication | gitleaks | agent-hub tsc | vitest | mobile jest / tsc | server test |
|---|---|---|---|---|---|---|---|---|---|
| this commit | BASE + this report only (no code) | n/a (docs only) | | | | | | | |
