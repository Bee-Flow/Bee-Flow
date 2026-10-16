s3/sb2 APPROVED · s3/sb3 APPROVED · s3/sb4 APPROVED (no blocking findings; optional nits in 9–10)

# Opus review SWEEP-B sb2/sb3/sb4 (Studio), base 15277b17

## Gate results
| | sb2 3c6e4802 | sb3 5eaf8734 | sb4 92a53064 + 477097e7 | merge 593cfcd4+sb2+sb3+sb4 |
|---|---|---|---|---|
| ts-equivalence | 2/2 identical | 9/9 identical | types 4/4 identical; catch commit 3 different (all recipe tokens, see 3) | n/a |
| D/A pairs (-M40%) | none (all R) | none | none | clean merges, no conflicts |
| already-TS edits (transpileModule before/after) | mobile accessView.ts identical (comment) | useRemote, SolutionCardParts, SolutionInstallsTab, skillModel.types identical | n/a | |
| typecheck (full agent-hub) | 0 errors | 0 | 0 | 0 |
| eslint changed files | 0 err / 3 warn (pre-existing complexity) | 0 / 10 | 0 / 6 | |
| vitest (importers + touched tests) | 2 files, 13 pass | 9 files, 138 pass | 12 files, 241 pass | Studio excl. AppStudio: 165 files, 2390 pass |
| mobile jest | access.lockstep 6 pass | releases.lockstep 11 pass | sources + describeIt lockstep 24 pass | playbooks/projects/skills/studio/knowledge/forms: 101 suites, 831 pass |
| server test | – | add-nl-solution-overview-translations 4 pass | – | |
| check:fast | 39/39 | 39/39 | 39/39 | 39/39 |
| duplication prod / test | 15113 / 26228 | 15126 / 26228 | 15113 / 26228 | 15152/15290 / 26228/26228 (at budget, not over) |
| ts-ratchet agent-hub | 1953 | 1946 | 1948 | 1937 (budget 1955) |
| file-budget | none past ceiling | none | none | |

Forbidden constructs in added lines (any, as any, as unknown as, @ts-*, `!`, eslint-disable, `as Error`, .d.ts): none.

## Findings and rulings
1. sb2 compliance.types.ts:44 `ResolvePlan` with required what/calls/unresolved/note/modelFailed/empty, while FindingRow.tsx reads `(plan.what || [])`, `(plan.unresolved || [])`: ACCEPT. `planResolve` always builds every field (server/playbooks/resolvePlan.js:555-566: `what: (built.what||[]).map`, `unresolved: built.unresolved || []`, `note: asked.note || null`, `modelFailed` null|string, `empty: !calls.length`), and the route sends `{ plan: out.plan }` unchanged (server/routes/playbooks/complianceRoutes.js:190). Making `unresolved` optional would break `plan.unresolved.map` at FindingRow.tsx:~158 (TS does not narrow through `(x || []).length`), so the only alternative would be a runtime change. The doc comment already cites the server. Same ruling as S3-batch-18 #2.
2. sb3 releaseModel.ts:43 `RawRelease.version: number` "only so > 0 compiles": ACCEPT, but the comment gives the wrong reason. The column is `version INTEGER NOT NULL` (server/stores/blueprint/schema.js:105), so the type is honest. Optional comment fix: "`version` is INTEGER NOT NULL in project_releases; versionOrNull still checks it." `versionOrNull(value: number)` has no other callers.
3. sb3 releaseModel.ts:128 `.filter(Boolean) as ReleaseRow[]` and :177 `as NoteRow[]`: ACCEPT. The filter on the same line is the runtime guard that removes null. The element shapes match (releaseRow infers `notes: object | null`, and ReleaseNotes is all-optional `unknown`; noteRow is annotated `NoteRow | null`).
4. sb3 OutputFieldsCard.tsx:74 `schemaToFields(...) as OutputFieldRow[]`: ACCEPT. `schemaToFields` returns `FormRecord[]` = `Record<string, any>[]` (formState/outputSchema.ts:29), and every element it pushes has `key: string`, `type: string`, `description: string`, and `columns` as `{key,type}[]`. The value has that type.
5. sb3 skillModel.types.ts `Skill.outputSchema: unknown → OutputSchema | null`: ACCEPT. The server returns `_jsonObjectOrNull(r.output_schema)` (server/stores/skill/rows.js:68), so the value is always an object or null.
6. sb3 solutionCounts.ts:71 CountedSection overloads: ACCEPT. All 9 `COUNTED_SECTIONS` have a `COUNT_PHRASE` entry. SolutionCardParts.tsx:111 drops the shim cast; checked with the checker: `chipsOf` (JS) now infers literal section/kind unions, `count: number`, and `phrase: string`. This tightens the types, it does not loosen them.
7. sb3 useRemote.ts `useRemote<T>` / `readJson<T>`: ACCEPT. This is the usual wire-body typing (`res.json()` any → T). The default is `unknown`, so JS callers are unchanged, and every T used (`{blueprints?: SavedBlueprint[]}`, `ReleasesBody`, `InstallsBody`) has optional fields that are read defensively. `/package/blueprints` returns `{ blueprints }` from `mapRow` (id, name, version): server/routes/projects/packaging.js:678.
8. sb4 studioMap.ts:497 `edgeGeometries(): {…; geometry: EdgeGeometry | null}[]`: ACCEPT. The type is honest but wider than the runtime value. A non-null element type would need a cast or a `!!` predicate (a runtime change). Consumers are JS.
9. Line joins: whitespace only, one statement each, and they emit identical JS. Each file sat exactly at its ceiling at the base: AddSourcePanel 714/714 (keysOf l.259, toggleColumn l.289), studioMap 572/572 (l.492), and SkillStepEditor 419/419 (dropped a blank line after the imports). This is the only types-only way to fit; ACCEPT. Nit: the 477097e7 message says "nothing else" and does not mention the two joins.
10. Catch commit 477097e7: every difference is one recipe token. NewFormDialog: `err?.message`×3 → `errorMessage(err)`, and the 'no id' compare is kept (recipe item 4). AddSourcePanel: `|| null` → `errorMessage`, 'failed' and `t()` → `messageOf`, `e?.code` → `errorCode` (the case labels are strings, so this is equivalent), `e?.body?.limit` → `errorBodyRecord(e)?.limit`. `messageFor(t, e: unknown)` follows recipe rule 15c; its callers (KnowledgeDetail.jsx:130) are JS. routeApi: `isAbortError`, which is `readProp(e,'name') === 'AbortError'`. No user-visible change.
11. Path edits are correct and minimal: ci.yml solutionCounts.ts, the server migration test, i18nGuard (SkillStepEditor/SkillsOverview .tsx), the .file-budget keys, StudioRail.test import, studioNav.test, studioRegistry.boundary, and the mobile access/releases/sources/describeIt lockstep tests. The lockstep tests still run real comparisons; describeIfWeb is active and the counts above are non-skipped. Optional nits (comments only): automation/index.jsx:526 "StudioRail.jsx", StudioStart.jsx:160 "map/studioMap.js", describeIt.lockstep.test.ts:84 describe title "routeApi.js", mobile RecentRow.tsx:20 / describeIt.ts:36,40 ".js", e2e/context/app-map.md:149. Pre-existing and not from this batch: ci.yml `Solutions/{SolutionCard,SolutionsOverview}.jsx` names files that are already .tsx.
12. Mirror candidates (do not hand-copy): after the merge, jscpd pairs web `Playbooks/stages/accessView.ts:175` with mobile `playbooks/model/accessView.ts:126` (13 lines), and `map/studioMap.ts:375` with mobile `shared/markdown/renderers/mermaid/edgePath.ts:40` (13 lines). These two account for most of the +39 production lines in the merge; production is still under budget.
13. Kept-JS files: no JS file in the scope changed except the touched tests. Spot checks:
    - ComplianceStage.jsx assigns `e.status`/`e.body` on a `new Error` (l.22-24): the runtime reason is real.
    - FormsStudio.jsx reads `err?.unreadable` (recipe "do not rewrite" item 2): real.
    - DescribeItPanel.jsx: a mobile lockstep test regexes its source (`ERROR_TEXT` block) and it has a nullable `abortRef`: plausible.
    - SkillDetail.jsx: `new Date()` state plus 3 catches: plausible.
    - complianceView.js: I found no blocker. `(facts && facts.table) || {}` can be typed by annotating the declaration, and the mobile lockstep loads it by path. I assume it was held back as a mirror candidate (there is a mobile port); please confirm the drafter's reason.
    - solutionOverviewModel.js, InstallBlueprintModal.jsx, SourcesTab.jsx: no catch-only blocker seen. Their reasons are not verifiable without the drafter reports.
    - None of the files I checked was kept JS for a catch read that the recipe covers alone.

## Resolution (integrator S3)
- All three APPROVED; merged as is. Optional nits (commit-message wording on 477097e7, stale .js/.jsx names in comments, RawRelease.version comment reason) and the two mirror candidates (web Playbooks/stages/accessView.ts:175 ↔ mobile accessView.ts:126; Studio map/studioMap.ts:375 ↔ mobile edgePath.ts:40, 13 lines each) are listed in split/S3-report.md. The four kept-JS files without a found reason (complianceView.js, solutionOverviewModel.js, InstallBlueprintModal.jsx, SourcesTab.jsx) are listed there as follow-up candidates.
