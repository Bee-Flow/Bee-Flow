# Opus review L-C round 3 (p8a, p8b): CHANGES REQUIRED. Three converted files go back to JS. The rest needs type and comment placement fixes only. The fixes are verified in a scratch merge, and round 2 + round 3 merge and typecheck cleanly together.
Base 77793e85. Branches: lc/p8a (a1d55887 types, 5007988a catch recipe), lc/p8b (35367cb9 types).

## Gate per commit (against 77793e85)
| Commit | Identical | Different | Notes |
|---|---|---|---|
| a1d55887 | 3 | 0 | |
| 5007988a | 3 | 1 | AppsHomePage.tsx. The compiled diff is only the `errorMessage` import, `err?.message` → `errorMessage(err)` and the byName `localeCompare(..., void 0, { numeric: true, sensitivity: "base" })` collapsed from 4 lines to 1. The arguments are the same, so this is formatting only, as the commit says. |
| 35367cb9 | 8 | 0 | |

- **D/A pairs:** pair-check reports IDENTICAL for all 11 type stems and DIFFERENT only for AppsHomePage, which is the recipe commit.
- **Kept JS:** besides the renames, the only edits are `.file-budget.json` (key rename), `AppsHomePage.types.ts` (new) and the mobile `documents.test.ts` path. No kept-JS file changed.
- **node_modules:** none.
- **Forbidden constructs:** none (any, as any, as unknown as, ts-ignore/expect-error, `!`, eslint-disable).

## Fixes
Verified diff (made on the scratch merge, round-3 fixes only, 9 files): /tmp/claude-1000/-home-tom-Projects-Bee-Flow/3a03602b-b5e8-4e1c-a88e-1ef6b1aafe5e/scratchpad/reviews/LC-round3-fixes.diff

1. **p8a pages/documents/documentsApi.ts → back to JS, byte-identical.**
   - **Problem:** :87 `listDocumentsPage(filters: Record<string, string | number | undefined | null>)` passes `Object.entries(filters).filter(...) as [string, string][]` to URLSearchParams. The only TS caller, documentQueries.ts:122 (`LibraryFilters.offset/limit: number`), passes numbers, so the assertion claims a type the value does not have.
   - **No honest types-only typing exists.** lib.dom's `URLSearchParams` init is `string[][] | Record<string,string> | string | URLSearchParams`, so numbers can only get through by asserting or by adding `String(v)`, which is a runtime change. A type predicate is not possible either: the callback destructures `([,v])`, and a predicate needs a named parameter, which also changes the emitted code.
   - **Same lie elsewhere:** `listTemplates(filters: QueryFilters = Record<string,string>)` while its JS callers pass `limit: 100/200` (DocumentFillFields.jsx:17, documentFields.jsx:139).
   - **Fix:**
     ```
     git rm agent-hub/src/pages/documents/documentsApi.ts
     git checkout 77793e85 -- agent-hub/src/pages/documents/documentsApi.js mobile/src/features/flow-editor/api/documents.test.ts
     ```
   - **Follow-up list entry:** "pages/documents/documentsApi — numeric filters into URLSearchParams (needs `String(v)`)".
   - **What would have been fine:** `asJson<T>` trusting the server shape has an in-directory precedent (spreadsheet/sheetApi.ts:48 `asJson<T>`). The `DocumentsApiError` annotations on `new Error()` are honest because every extra field is optional.
   - **Verified:** nothing imports `DocumentsApiError` or `DocumentTemplate`, and typecheck is 0 after the revert.
2. **p8a pages/apps/AppsHomePage.tsx (+ AppsHomePage.types.ts) → back to JS, byte-identical.** This drops commit 5007988a entirely.
   - **Duplicate shape:** `StudioAppRow` duplicates `StudioApp` in components/admin/Studio/AppStudio/list/types.ts. Same endpoints: "GET /mine or GET /accessible".
   - **Lie in the duplicate:** it declares `accentColor?: string`. The server stores and returns `null` (server/appStudio/appPortability.js:181, projects/packaging/capture.js:240, install/parts/apps.js:65), and StudioApp says `string | null`.
   - **The honest fix fails typecheck.** I tried `StudioAppRow extends StudioApp` with `accentTile(accentColor: string | null | undefined)`. It fails at AppsHomePage.tsx:288, because accentTile returns `{ color: accent }` and `accent` does not narrow through the `.test()` ternary, leaving `string | null | undefined` against CSSProperties. Fixing that needs a runtime change.
   - **Fix:**
     ```
     git rm agent-hub/src/pages/apps/AppsHomePage.tsx agent-hub/src/pages/apps/AppsHomePage.types.ts
     git checkout 77793e85 -- agent-hub/src/pages/apps/AppsHomePage.jsx agent-hub/.file-budget.json
     ```
   - **Follow-up list entry:** "pages/apps/AppsHomePage — accentTile returns a nullable colour into CSSProperties; reuse StudioApp".
   - **Not blockers (left for the retry):**
     - The recipe substitution itself is correct (`errorMessage(err) || GENERIC_LOAD_ERROR`, state `string | symbol | null`, with the // behaviour note).
     - The `parsed: Record<string, number> | null = JSON.parse(...)` annotation on any: `const parsed: unknown = JSON.parse(...)` typechecks with the existing guards and is the honest form. Use it in the retry.
     - `id: string` required is acceptable: load() only keeps rows with a truthy id.
     - `SectionLabel children: string` is fine: both callers pass `t(...)`.
3. **p8b marketing/sections/Hero.tsx → back to JS, byte-identical.**
   - **Problem:** :136 `badgeAlign as React.CSSProperties['textAlign']` asserts a CMS string (`data.badgeAlign || data.align`, any text) into csstype's closed union, with no guard at the site. Compare textStyle.ts:44, which guards `align === 'left' | 'center' | 'right'` before assigning.
   - **The cast is required:** without it, tsc gives TS2322 at Hero.tsx:136 (verified).
   - **Fix:**
     ```
     git rm agent-hub/src/marketing/sections/Hero.tsx
     git checkout 77793e85 -- agent-hub/src/marketing/sections/Hero.jsx
     ```
   - **Follow-up list entry:** "marketing/sections/Hero — CMS textAlign string into CSSProperties (needs a guard)".
   - **HERO_VARIANTS:** the `(string | undefined)[]` widening would have been fine. It is an honest upcast, and the b12 `ReadonlyArray<string | undefined>` precedent covers it.
4. **p8b Footer.tsx:22: element type required while the code reads it defensively.**
   - **Problem:** `accountability.links?: FooterLink[]`, but the code checks `Array.isArray(acc.links)` and then `.filter(l => l && l.label)`, so it guards both the array and each element.
   - **Change :22 to:**
     ```ts
             links?: unknown;
     ```
   - **Why this works:** `Array.isArray(unknown)` narrows to `any[]`, so the filter and map typecheck unchanged. This matches the round-1 handling of `unknown` fields (statusOf rows).
   - **Verified:** typecheck 0 and the gate stays identical.
5. **Types placed between a doc comment and the code it documents** (round-1 #2 rule).
   - **p8b components/CookieBanner.tsx:24-38:** `CookieStrings`, `CookieBannerProps` and `ConsentChoice` sit under the `// Built-in copy. Caller-supplied ...` comment, which documents `DEFAULT_TEXT`. Move the three declarations, unchanged, to just above that comment (:22).
   - **p8a pages/webpages/BuildBar.tsx:31-39:** `BuildBarProps` sits between the `/** The describe-to-build bar ... Props ... */` block and `export default function BuildBar`. Move it, unchanged, to just above the `/**` block (:10).

## Checked, OK
- **SourcePicker.tsx:** the types sit above the JSDoc.
  - `BuildSource` is exported and reused by BuildBar, with no second home.
  - The `useState<PickerTable[] | null>` values come from `Array.isArray(body?.x) ? body.x : []` (an annotation on any, guarded).
  - `PickerItem.name: string` is honest, because the mapping always yields a string (`x.name || x.key || x.id`).
- **BuildBar.tsx:** `onBuild?` is called after `canBuild` (`!!onBuild && ...`). TS aliased-condition narrowing covers it, so no `!` is needed.
- **TrustBand `(e.target as Element)`:** the same `e.target` assertion pattern round 1 accepted (`as Node`), and the code tests `.closest &&` before calling it. LanguageSwitcher `e.target as Node | null` is accepted the same way.
- **LanguageSwitcher `Locale.code: string`:** read unguarded in `choose(l.code)`, `key`, `===`.
- **CookieBanner:**
  - Consent state `'unset' | ConsentChoice | null`: the setter only receives those values.
  - `DEFAULT_TEXT: Record<string, CookieStrings>`.
  - The `React.CSSProperties` annotations on the style constants are honest.
- **Features, Integrations, NavIcon, TrustBand:** every CMS field is optional, and the data types extend `SectionDataBase` from sectionData.types (one home). `Footer.FooterLink` and `TrustChip` are distinct shapes, not duplicates of `CmsHref`.
- **Paths:** the only functional reference to a renamed file was the mobile documents.test.ts (it reverts with fix 1). Every other mention is in a comment (consent.ts, CardActionWrapper.tsx, PopupModal.tsx, documentQueries.ts:4, sheetApi.ts:2, handoff.js:69, previewContent.js:107, AppRunPage.jsx:288).
- **Kept-JS reasons:** neither commit nor LC-report.md lists them for p8. a1d55887 says "see the follow-up list in the report", but the report was not updated for p8. Add them; the reviewer could not check 46 of 57 files.
  - Spot-checks:
    - useResizableWidth.js: `parseInt(localStorage.getItem(k))` takes `string | null`, a runtime change, so it holds.
    - demo/ComplianceDemo: scratchpad p8b-tsc.txt TS2322 `string | null` → `null | undefined`, so it holds.
  - **Commit titles:** the p8b title names "demo, onboarding player, entry files", but only marketing files are converted. Say so in the title or body.

## Merge test (scratch worktree from 77793e85)
- **Round 3 alone, before fixes:** merged lc/p8a → lc/p8b (--no-ff). No conflicts; agent-hub typecheck 0 errors.
- **Round 3 after fixes 1–5:**
  - Typecheck: agent-hub 0, mobile `tsc --noEmit` 0.
  - Gate 77793e85..fixes: 9 identical / 0 different. The recipe file is gone, and the reverted files are byte-identical to the base (empty `git diff 77793e85` for documentsApi.js, Hero.jsx, AppsHomePage.jsx, .file-budget.json, mobile).
  - Duplication: production 15225 (budget 15290), test 26228 (at budget).
  - check:fast 39/39; eslint on the 9 converted files 0 errors (7 pre-existing size/complexity warnings).
  - vitest `related --run --maxWorkers=4` for the 9 converted files: 156 files / 2162 tests ✅.
  - Plus marketing/, pages/apps, documentsApi.test.js, i18n, chatSignalsHosts and webVitalsReporter: 31 files / 301 tests ✅.
  - mobile jest documents.test.ts: 10/10 ✅.
- **Round 2 + 3** (lc/p4 → p5 → p6 → p7 merged on top, all four based on 60e08bc6):
  - **Conflicts:** none, both on the raw round-3 merge and on the fixed one (only .file-budget.json auto-merges).
  - **Typecheck:** agent-hub 0 errors in both variants; mobile tsc 0.
  - **check:fast:** 39/39.
  - **Duplication:** production 15289 against a budget of 15290, so round 2 + 3 together sit 1 line under. Any added clone at integration turns it red; run `node scripts/duplication-ratchet.mjs` after every merge.
  - **Gate over everything:** 35 identical / 6 different (round-2 recipe files, not reviewed here).
- The scratch worktree is removed. The main clone and all branches are untouched.

## Merge order
1. **p8a:**
   - Revert documentsApi.ts and the mobile path (fix 1) in a1d55887.
   - Drop 5007988a, i.e. AppsHomePage stays JS (fix 2), and restore the .file-budget.json key.
   - Move BuildBarProps (fix 5).
2. **p8b:**
   - Revert Hero.tsx (fix 3).
   - Footer `links?: unknown` (fix 4).
   - CookieBanner type move (fix 5).
3. **Add the follow-up entries** for documentsApi, AppsHomePage and Hero, plus the p8 kept-JS reasons, to LC-report.md.
4. **Merge:** round 2 (lc/p4 → p5 → p6 → p7) after its own review, then lc/p8a → lc/p8b. No dependency between rounds; any order merged clean here.
5. **Afterwards:** agent-hub typecheck, `node scripts/duplication-ratchet.mjs` (1 line of headroom), check:fast, server typecheck, mobile tsc, and the mobile jest flow-editor documents test.
