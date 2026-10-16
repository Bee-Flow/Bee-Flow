# Opus review: s2/batch-15 (base s2/batch-16 = f627c205; 973aabc3 types, 9cabd43c catch)

**Verdict: CHANGES REQUIRED (small).** There are three required fixes:
- the i18n guard test breaks, because it reads `analytics/filters.js` by path;
- two unguarded `pivot(...) as PivotRow[]` assertions;
- the JSDoc-separation rule is broken in 10 places.

The rest is recommended or a nit. The org access, ceiling and role code has no logic change and no fail-open. The compiled program equals the base except the recipe tokens. The catch commit is approved as is.

## 1. Gates

**Equivalence gate**

| Range | Result |
|---|---|
| `s2/batch-16..973aabc3` | `22 identical, 0 different of 22 converted files` |
| `973aabc3..9cabd43c` | `2 identical, 8 different of 10`. The 2 identical are AccessPermissionsPanel and CeilingSection, which convert with their callees. |

**Catch diffs.** Every differing line is a recipe token or the `caughtError` import:

| File | Change | Right? |
|---|---|---|
| GroupAccessMatrix (3 sites), OrgAccessEditor (2), CeilingReadOnly (1) | `e.message \|\| t(...)` → `messageOf(e, t(...))` | Yes. The targets are `AccessMessage.text: string` and `useState<string \| null>`. `t` is cheap and has no side effect. |
| OrgAiContextEditor, OrgIntegrationCacheEditor | `setLoadError(errorMessage(err))` | Yes. The state is `string \| null \| undefined`, the recipe default. |
| OrgAiContextEditor, OrgIntegrationCacheEditor | `toast.error(messageOf(err, t(...)))` | Yes, recipe row. |
| RolePermissionEditor | `setError(errorMessage(e))` | Yes. The state is `useState<string \| undefined>('')`. |
| ReleaseNotesPanel ×2 | `messageOf(e, '<literal>')` | Yes, recipe row. |
| OverviewSection | `error: errorMessage(e)` | Yes. `OverviewState.error` is `string \| null \| undefined`. |

No `// behaviour:` note is needed, and none is claimed. The two security editors still do `setServer(null)` after a failed load, so Save stays disabled: no fail-open.

**Leftover JS.** 29 paths in batches/15.txt and 16.txt are still JS: 16 from b15 and 13 from b16. All are byte-identical to s2/batch-16, including OrgAuthSection, OrgInfoSection, CloudCeilingEditor, monitoring/*, model.js, heatmap/model.js and AnalyticsPanel.jsx (analytics/).

**D/A pairs.** The only A file with no JS counterpart is `access/accessTypes.ts`. There are no D/A pairs.

**Existing TS files, transpiled parent vs new** (`ts.transpileModule`, comments stripped): all 9 are IDENTICAL. The files are GroupModal, OrganizationModal, OrganizationsSection, ui.types.ts, analyticsApi.ts, cmsPanelTypes.ts, primitives.tsx, primitives.types.ts and SiteVersionMenu. Each change is types-only, and none loosens anything:
- **`isFullAdmin: boolean | undefined`** is honest. UserManagement.tsx:36 computes it as `currentUser?.permissions?.includes('all') || currentUser?.isAdmin`. The key is still required.
- **Generic `SegmentedControl<V extends string | number = string>`.** The default keeps every existing caller's type.
- **`onDuplicateVersion: () => Promise<unknown> | void`** is honest and a tightening. The old `(id, name?) => void` was wrong: the only producer, `useCmsSiteOps.handleDuplicateSite`, takes no arguments (useCmsSiteOps.ts:252), and VersionSwitcher calls `await onDuplicate()`.
- **`CmsBlock.type` now required** is honest against the server. `stores/cms/pages.js:92-94` (`normalizeBlockRecord`) drops any block whose `type` is not a non-empty string, so no stored block lacks it. No TS reader reads `block.type` defensively, and BlockList.tsx:63 indexes `BLOCK_CATALOGUE[block.type]` directly. Typecheck is 0 on the merged tree, so no TS producer builds a block without it.
- **`AnalyticsSite`** matches cmsAnalytics.js:629-634 (`id, name, live, tracked, websiteId|null, recording`). It is optional where the server always sends a field, which is harmless.
- **`url?: string`** matches `/settings` (cmsAnalytics.js:442).

## 2. Findings

### Required

1. **i18n guard broken by the rename.**
   - The test fails on s2/batch-15 alone and on the merged tree.
   - `agent-hub/src/i18n/i18nGuard.test.js:496` still registers `components/admin/product-website/analytics/filters.js`.
   - Two tests fail: "CLEAN NOW — drop the pending … filters.js" and "GONE — remove … filters.js from TEXT_HELPERS".
   - Fix: change that line to `{ rel: 'components/admin/product-website/analytics/filters.ts', pending: 'CMS — analytics filter names' },`. I verified it: with that edit, i18nGuard.test.js passes 16/16. This test is outside the reviewed folders, so the drafter's targeted vitest missed it.

2. **Unguarded downcasts of `pivot()`:**
   - `analytics/sections/PagesSection.tsx:47` and `:183`: `pivot(...) as PageRow[]`
   - `SourcesSection.tsx:51`: `as PivotRow<'referrer'>[]`

   Why this is an unguarded assertion:
   - `model.js` is JS. The type TS infers for `pivot()` is `{ views; visitors; visits; bounces; totaltime }[]`, which I measured with the checker.
   - The cast adds `bounceRate`, `avgTime` and `path: string | null`. TS checks none of them.
   - The field value comes from `readField(row, f) ?? null` (model.js:17-24, 34-36), which returns Umami's raw value unvalidated, so `string | null` is a claim.
   - If pivotRow changes, nothing fails to compile. That breaks "never assert a value to a type it does not have" and "casts need a guard at the site".

   Fix (preferred): revert both sections to JS, byte-identical to s2/batch-16:
   - `git mv` them back, then `git checkout s2/batch-16 -- agent-hub/src/components/admin/product-website/analytics/sections/{PagesSection,SourcesSection}.jsx`.
   - Delete `PivotMetrics`/`PivotRow` from `analytics/ui.types.ts:21-33`, which then has no consumer.
   - Convert both again in the same commit that types model.js, as `export function pivot<F extends string>(rows: unknown, fields: readonly F[]): PivotRow<F>[]`. Then neither cast is needed.
   - ts-ratchet stays well under budget (2094 against 2230).
   - An acceptable alternative, if the integrator wants to keep them: a comment above each cast, `// pivotRow (model.js:26-41) always sets bounceRate, avgTime and every requested field; drop this cast when model.js is typed.` I do not recommend it, because the guarantee lives in an untyped file.

3. **Contract rule: no types between a doc comment and its function.** This is the same rule as S2-product-website finding 3. In each file below, the new type block (file:lines) now sits between the component's doc comment and the function:
   - org/FreeEmailDomainsPanel.tsx:15-18
   - org/RolePermissionEditor.tsx:25-31
   - org/access/CeilingSection.tsx:17-23
   - org/people/PeopleDirectory.tsx:28-38
   - product-website/SiteSwitcher.tsx:22-31
   - product-website/VersionSwitcher.tsx:20-27
   - product-website/analytics/heatmap/HeatCanvas.tsx:66-72 (the `@param` doc)
   - product-website/analytics/sections/OverviewSection.tsx:173-179. Here the `Composition` doc is now followed directly by the `/** One composition bar … */ interface CompositionStrip`.
   - Same rule for `//` doc blocks: org/GroupAccessMatrix.tsx:41-48 (under the `hideHeading` comment) and product-website/BlockStyleEditor.tsx:210-214 (under the "v2 knobs" comment).

   Fix: move each type block, plus a blank line, above the comment that opens the function's doc. The comment's last line must again be directly followed by the function. This is comments and types only, so the gate stays identical.

### Recommended

4. **`MinuteBucket.overlay: number` (charts/MinuteBars.tsx:18): accept, with a comment.**
   - MinuteBars reads it three ways: non-defensively at :38 (`b.overlay > peak`, which TS would reject on `number | undefined`), by truthiness at :56, and defensively at :60 (`!= null`).
   - The only producer, `toMinuteStrip` (RealtimeSection.tsx:64), always writes a number.
   - So the required field matches every input that exists today and cannot hide a crash. Making it optional would need a code change at :38, which would mean keeping the file JS.
   - Fix: extend the doc on line 14 with `Required: toMinuteStrip always fills it; the \`!= null\` at the tooltip predates the type.` If the integrator reads the STATE rule strictly, the alternative is to revert MinuteBars to JS and move `MinuteBucket` into RealtimeSection.tsx.

5. **`SessionRecord.events?: number` (ReplaysSection.tsx:47) claims more than the code trusts.**
   - The only read is `Number(s.events) || 0` (:100), and the server proxies Umami's `/sessions` unnormalised (cmsAnalytics.js:214). Umami counts can arrive as strings.
   - Fix: `events?: unknown;` (or `number | string | null`). The doc comment stays.

6. **Implicit `any` maps.**
   - `ReplaysSection.tsx:89` `const bySession = new Map();` is `Map<any, any>`, so `replay` is `any`. Fix: `new Map<string, ReplayRecord & { _span: number }>()`. This is a type argument only, so the gate stays identical.
   - `SourcesSection.tsx:50` has the same leak. It goes away with the revert in finding 2.

7. **One home per shape.**
   - `AccessPermissionsPanel.tsx:29` declares `user?: { isAdmin?; role?; permissions? } | null` inline. That is a subset of `AdminCurrentUser` (userManagement/types.ts:87), which UserManagement.tsx already uses for the same `user` prop. Fix: `import type { AdminCurrentUser } from './userManagement/types';` and `user?: AdminCurrentUser | null;`.
   - `SourcesSection.tsx:157` `UtmRow` repeats `XYRow`'s `x`/`y`. Fix: `interface UtmRow extends XYRow { count?: number; name?: string | null; value?: string | null }`. This is moot if finding 2 reverts the file.
   - `accessTypes.ts` is a correct new home. No existing TS type covers the group-access or org-availability payloads. `Studio/SupportStudio/AccessTab.tsx:8` has an unrelated private `AccessGroup` (`{ id; name? }`), so there is no clash.

8. **ReleaseNotesPanel wire type vs `releaseNotesStore.rowToEntry` (stores/releaseNotesStore.js:77-93).**
   - `services` is `r.services || null`, so the type should read `services?: string | null;` (line 32).
   - The reader guards elements (`i && i.kind`, :201), so line 35 should read `items?: Array<ReleaseNoteItem | null>;`.
   - The edit at :201 from `i =>` to `(i) =>` is churn with no type added. Revert it to `i =>`.

### Nits

9. **`FreeEmailDomainsPanel.tsx:84`: `raw.split('@').pop() as string`.**
   - It is null-removing, but `split` always returns at least one element, so `pop()` cannot be undefined. Accept.
   - Add `// split() always returns ≥1 element, so pop() is a string.` above the line.

10. **`SiteSwitcher.tsx:27`: `onCreate: (name) => Promise<{ id?: string } | null | undefined | void> | void` is lazy.**
    - The producer `handleCreateSite` returns `Promise<data | null>`.
    - Write `(name: string) => Promise<{ id?: string } | null> | void`. Better still, give `SiteVersionMenu.onCreateSite` (line 16, now `=> void`) the same type so the return is not discarded on the way down.

11. **`PeopleGroupSection.tsx:24-25`: a blank line is missing between `};` (ORG_STATUS_CHIP) and `interface PeopleSectionBase`.** The `OrgSection.status: string` / `kind: 'org'` union is honest: useUserDirectory.js:155-159 always writes `status: org?.status || 'active'`.

12. **`RolePermissionEditor.tsx:26` `role: { id: string; color: string }`.** Optionally use `Pick<(typeof ORG_ROLES)[number], 'id' | 'color'>`, the type RolesSection.tsx:8 already derives.

13. **`RolePermissionEditor.test.jsx:25` still imports `'./RolePermissionEditor.jsx'`.** Vite resolves it and the test passes (6/6), but README step 2 asks for extension-free importers. Change it to `'./RolePermissionEditor'`.

14. **Wire shapes match the server, no change needed:**
    - `AccessData`/`AccessCapability`/`AccessGroup` match `buildGroupAccessResponse` / `buildOrgAvailabilityResponse` (featureAccessRoutes.js:476-523, 616-634), including the `/me/group-access` no-org fallback at :575.
    - `AiContextSettings` matches orgAiContext.js:78-90.
    - `IntegrationCacheSettings` matches orgIntegrationCache.js:92-122.
    - `OrgAccessEditor` gets `orgId: string` only behind `orgId ? … : null` (CeilingSection.tsx:37).
    - The PUT bodies are unchanged: `{ granted }` and `{ unrestricted: true } | { available }`.

## 3. Merge test
- `git merge-tree --write-tree ccr-ccac4823-i270ro s2/batch-15` → `f28f7149`, clean. The scratch commit is `91f2ba49`.
- That result merged with `origin/ccr-28820270-xkvwp8` (e738f454) → `8a357285`, clean, no conflicts. The scratch commit is `c18ec039`, in a detached worktree `rev3/b15tri` with node_modules symlinked.

Results on the triple-merge tree:

| Check | Result |
|---|---|
| `heavy.sh npm run typecheck` (agent-hub, full project) | 0 errors, rc=0 |
| eslint on the 42 changed or added TS files | 0 errors, 38 warnings: 25 max-lines-per-function, 9 complexity, 4 max-statements. No new eslint-disable, and no converted file contains one. |
| `duplication-ratchet` | production 15362, under the lowered 15383 ✅. Test: 26228, at budget ➖. |
| `ts-ratchet agent-hub` | 2092, under 2230 ✅ |
| `file-budget agent-hub` | ✅, none past its ceiling (1 can come down) |
| `npm run check:fast` | 39 passed, 0 failed |
| `npm run lint:dead` (knip) | clean |
| vitest `src/components/admin/org`, `src/components/admin/product-website`, `src/components/admin/monitoring`, plus `src/i18n/i18nGuard.test.js` | 43/44 files and 503/505 tests pass. The 2 failures are finding 1 and nothing else. With the one-line fix, i18nGuard passes 16/16. |
| Source readers | No mobile, server or scripts test reads a converted path. Two agent-hub readers do: finding 1 (breaks) and finding 13 (works). |

## Resolution (S2: fix commits 1779dd7a and 709c3aca on s2/batch-15)
Required 1–3 applied (i18nGuard path; PagesSection and SourcesSection reverted to JS byte-identical, PivotMetrics/PivotRow
removed; 10 type blocks moved above their doc comments). Recommended 4–8 and nits 9–11, 13 applied; 12 skipped.
Extra: ReplaysSection reverted to JS too (709c3aca) — the fixer's `{…, replay, t} as { …; replay: null }` asserted a real
record to null; it stays JS until analytics/model.js is typed. ReleaseNotesPanel keeps `.filter(i => i && i.kind) as
ReleaseNoteItem[]` (guard on the same expression, commented).
After the fixes: `ts-equivalence s2/batch-16 HEAD` 21 identical, 8 different of 29 (the 8 catch files); typecheck 0; eslint
0 errors; vitest org/product-website/monitoring/i18nGuard pass. Merge into ccr-ccac4823-i270ro (after e738f454): one
conflict in i18nGuard.test.js (adjacent renames modelMeta.ts / filters.ts, both kept); i18nGuard 16/16.
