# Opus review L-C round 2 (p4, p5, p6, p7): CHANGES REQUIRED. p4/p5/p6 need small fixes (placement, plus countries back to JS). p7 sends 5 of its 7 conversions back to JS because no honest typing exists. Fixes verified on a scratch merge.
Gate base 7233b5dc. Branches: lc/p4 (ec524172 types, 14b1080e recipe), lc/p5 (fe3d9b32, c9cff9db), lc/p6 (6653f579, 2905a817), lc/p7 (85e3246b). Merge base for the integration test: 77793e85.

## Gate (per commit, against 7233b5dc)
| Commit | Result | Notes |
|---|---|---|
| ec524172 | 4/0 | |
| 14b1080e | 4/2 | CoworkPage: 3× `err.message`→`errorMessage(err)` plus a 3-line→1-line import collapse (formatting only, no runtime change). VegaLiteRenderer: 1× `e.message`→`errorMessage(e)`. |
| fe3d9b32 | 1/0 | |
| c9cff9db | 1/1 | ExternalShareSection: 4× `setError(e.message)`→`setError(errorMessage(e))` |
| 6653f579 | 13/0 | |
| 2905a817 | 14/3 | RuntimeRow is identical (types only, as stated). localRuntimeApi: `errorMessage`, 2× `messageOf(e,'<same literal>')`. RerankerConfig: `errorMessage`. LocalModelsCard: `messageOf(e,'')` |
| 85e3246b | 7/0 | |

Every "different" line is a recipe token substitution, or the added helper import.
- **D/A pairs:** with `-M40%`, every deletion pairs with its rename. The only additions are runtimeTypes.ts, learning.types.ts and usage.types.ts. pair-check on the low-similarity pairs (RerankerConfig, ConsumerBetaFeaturesSection, AiStepModelSection, ConsumerUsageSection) shows them IDENTICAL.
- **Kept JS:** every remaining .js/.jsx is byte-identical to 7233b5dc, except i18nGuard.test.js (a path-only edit).
- **node_modules:** none in any commit.

## Fixes
1. **p4: type placed between a JSDoc block and its function.** components/cowork/CoworkDetail.tsx:87-103: `DetailHeaderProps` sits under the `/** The header: who this is… */` block.
   - **Fix:** move the interface, unchanged, above the `/**` block, so the JSDoc sits directly over `function DetailHeader`.
2. **p6: the same placement problem with line comments.** In components/admin/org/orgInfo/OrgAuthSection.tsx, two interfaces sit between a comment and the code it describes:
   - :8-18 `AuthMethodGroupProps` sits under the `// The method cards are one radio group…` comment.
   - :91-100 `OrgAuthSectionProps` sits under `// ── Sign-in Method section — extracted verbatim… ──`.
   - **Fix:** move each interface above its comment, so the comment sits on the component again.
3. **p6: countries back to JS (duplicate shape).** Converting the web file turned it into a 105-line jscpd clone of mobile/src/features/org/model/countries.ts. S3 kept the file JS for exactly this reason (S3-report: "mirror candidate", the two are not identical). The conversion only added two parameter types.
   - **Fix:** restore agent-hub/src/components/admin/subscriptions/access/countries.js byte-identical to 7233b5dc (`git rm …/countries.ts && git checkout 7233b5dc -- …/countries.js`), and restore mobile countries.lockstep.test.ts:14 and countries.ts:3 (path back to `.js`).
   - Keep the OrgAuthSection path edits in mobile profile.ts and OrgSignInScreen.tsx.
   - Duplication goes from 15289 to 15184 against a budget of 15290. It was only 1 line from the gate.
4. **p7 bits.tsx: StepMixLine `mix` is required, but the body reads `mix?.[k] > 0`.** No honest typing compiles. With `mix?: Record<string, number> | null`, `mix?.[k] > 0` gives TS2532 and `mix[k]` gives TS18049 (tested). StepMixLine has no caller anywhere, so no producer proves the field is always there.
   - **Fix:** revert bits.tsx → bits.jsx byte-identical.
   - **Knock-on:** OverviewView.tsx and ReviewView.tsx do not compile against the JS-inferred bits props (14 errors: `style`, `radius`, `fontSize` and `icon` are inferred as required). Revert both to JS byte-identical too.
   - LearningRail.tsx stays TS (it does not import bits).
   - In learning.types.ts, delete `ContinueTarget`, `StartLessonFn` and the `LessonDoc` import. They become unused.
   - The only honest way to keep these three files TS is to delete the dead StepMixLine, which is a runtime change (out of scope). Note it under "Follow-up: needs runtime rewrite".
5. **p7: `source` and `model` are required but read defensively.**
   - The fields are required in usage.types.ts: `UsageSourceRow.source: string` and `UsageModelRow.model: string`. Both are nullable `TEXT` columns of ai_usage_log (server/stores/usage/schema.js).
   - The code reads them defensively: ConsumerUsageSection `key={row.source || i}`, `key={row.model || i}` and `sourceFor(k) … k || 'Other'`; widgets `getSourceDetails(source: string) … source || 'Other'`. The JS callers (UsageSection, OverviewTab, ActivityPage) pass that nullable value.
   - The honest `source?: string | null` cannot index `SOURCE_MAP[source]` (TS2538), so no types-only fix exists.
   - **Fix:** revert ConsumerUsageSection.tsx and usage/widgets.tsx to JS byte-identical, and delete usage.types.ts (its only importer was ConsumerUsageSection).

Verified diff, made on the merge (12 files, +57/−336). Split it per branch as listed under "Merge order": /tmp/claude-1000/-home-tom-Projects-Bee-Flow/3a03602b-b5e8-4e1c-a88e-1ef6b1aafe5e/scratchpad/reviews/LC-round2-fixes.diff

## Checked, OK
- **Recipe deviations:**
  - **LocalModelsCard `messageOf(e, '')` (2905a817):** this matches the recipe's "use messageOf only if the target must be a string" clause, and the commit carries the `// behaviour:` note.
    - The target `ProviderMessage.text: string` is in an already-TS file, so widening it is not allowed.
    - `messageOf` is `errorMessage(e) || fallback`. The only difference is undefined vs '' when there is no message.
    - ai-config/index.jsx:158 renders `{message.text}`: both draw nothing in the same red box. Accepted.
  - **CoworkPage import collapse:** formatting only. Accepted, but it would have been cleaner in the types commit.
- **Casts:**
  - ExternalShareSection.tsx:343 `s.url as string` in the click closure. `s` is the `.map` parameter over a state snapshot that is only replaced (`setShares(...)`) and never mutated, and nothing in the file writes `.url`. The value cannot change between the `s.url &&` render guard and the click, which is the STATE exception. Accepted. `url?` is honestly optional (`readOnly && !s.url` branch).
  - OrgAuthSection.tsx:126/142 `as OrgFormData` in the `setOrgData` updaters. The state starts null and is set once to `toFormData(...)` (useOrgInfoForm.ts:241). It is never reset to null, and OrgAuthSection renders only with a non-null `orgData`, so the updater's `p` is never null. This is the same pattern already reviewed at useOrgInfoForm.ts:179/195 and UsageSharingToggle.tsx:35. Accepted.
  - VegaLiteRenderer.tsx:243 `as Record<string, unknown>`: guarded at the site (`&& typeof === 'object' && !Array.isArray`). Accepted.
  - No `any`, `as any`, `as unknown as`, `@ts-*`, `!`, new eslint-disable or .d.ts.
- **useGoogleWorkspacePicker.ts:** `user` was typed `string | null`, which was wrong.
  - Server googleDrive.js:96 and gmail.js:110 send `req.session.user` (the user row), and GoogleWorkspacePickerModal reads `status.user.email || status.user.displayName`. So `{ email?; displayName? } | null` is honest.
  - `authWindowName?` is passed by GmailPicker and GoogleDrivePicker through the modal into the hook options. Typed and documented as unread.
- **Required-field checks:**
  - **CapstoneInfo.course** is honest: the only producer (LearningCenterSection.jsx:333) builds `capstoneCourse ? { course: capstoneCourse, … } : null`. `capstone?.course` is a redundant guard on `capstone`. Making `course` optional breaks the closure at LearningRail.tsx:186, which would need a runtime change.
  - **BetaFeature.id** is honest: the server constant is BETA_FEATURES.
  - **ProbeData** (`ok: true` ⇒ `models` required) is honest: localRuntimes.js:140 always sends `models`, and ProbeResult reads `result.models.length` unguarded at :31. `ProbeModel.cat` is set by describeLocalModel. The `CAT_COLORS[m.cat] ||` fallback covers an unknown key, not a missing `cat`.
  - **deleteBlock DeleteBlockBody:** every field is optional and nullable, and the callers are JS.
  - **shieldFilters isCapped:** its only caller is TS (shieldStream.ts:190).
- **Security-relevant files:**
  - SecurityHub, shieldFilters, OrgAuthSection, AzureCard, RerankerConfig and localRuntimeApi are types-only or recipe-only. The gate is identical, and no auth, gating, secret or outbound-payload logic changed.
  - SecretInput, the masked placeholders and the `requireAdmin` routes are untouched.
- **Outside-package TS edits** are type-only and honest:
  - useProviderConfig (`azureModels`, `azureRerankerModel` optional, documented from instanceConfig.js).
  - tierTypes (`budgetTokens?`, `verbosity?`).
  - AddRuntimeForm: its three local interfaces moved to runtimeTypes.ts. RuntimeInfo is unchanged plus `canPull?`. ProbeData is tightened to a union that the server proves. One home per shape.
  - cowork.types (`CoworkPageProps`).
- **Placement:** every other new type sits above its comment or carries its own doc. The bits.tsx violations (8) disappear with fix 4. The widgets/ConsumerUsageSection `//` placements disappear with fix 5.
- **Kept-JS spot checks:**
  - coworkFormat.js holds: `b - a` on Dates needs a runtime rewrite.
  - DeleteBlockedNotice.jsx looks convertible now that deleteBlock.ts exists (a sweep candidate).

## Follow-ups (not blockers)
- **Kept-JS reasons are missing again:** neither the commits nor split/LC-report.md list them for round 2 (same finding as round 1). Add them to LC-report: p4 kept 34/40, p5 25/27, p6 37/54, and p7 35/37 after fixes 4 and 5.
- **Add to "Follow-up: needs runtime rewrite":**
  - learning/bits.jsx: dead StepMixLine (`mix?.[k] > 0`).
  - usage/widgets.jsx and ConsumerUsageSection.jsx: nullable `source` used as an index; needs `source ?? ''` or similar.
- **Nits:**
  - CoworkDetail.tsx:39-40 has two `import type` lines from './cowork.types'.
  - RuntimeRow.tsx:35 and ExternalShareSection.tsx:85 keep a `// { … }` shape comment next to the now-typed state.
  - VegaLiteRenderer's `let parsedSpec` is an evolving implicit any (pre-existing pattern).
- **Pre-existing, not touched here:** useBfMarks.ts:57 `(e as Error | null)?.message`, a forbidden cast for the next catch-recipe pass. Its async setState also throws "window is not defined" after teardown in WebpageIDE.i18n.test under load; the file passes alone (2/2).
- **Commit hygiene:** the p5/p7 types commits have no body, and the p6 title lists areas it did not convert. Same trailer note as round 1.

## Merge test
Scratch worktree from 77793e85; merged lc/p4 → lc/p5 → lc/p6 → lc/p7 with `--no-ff`; no conflicts.

**Before fixes:**
- agent-hub typecheck: 0 errors.
- Duplication: production 15289 / 15290 ✅ (1 line of slack); test 26228, at budget.
- Gate 77793e85..merge: 26 identical / 6 different, exactly the 6 recipe files.

**After fixes:**
- agent-hub typecheck: 0.
- mobile `tsc --noEmit`: 0.
- server typecheck: 0 (1076 files).
- Duplication: production 15184 ✅; test 26228 ➖.
- check:fast: 39/39.
- ts-ratchet: 1886 < 1955.
- gitleaks: no leaks.
- knip (lint:dead): clean.
- eslint on 36 changed files: 0 errors (31 warnings, complexity etc.).
- Gate 77793e85..fixes: 20 identical / 6 different (the same recipe files). The reverted files are byte-identical to 7233b5dc.

**Tests:**
- vitest related (45 files + i18nGuard): 330 files / 4747 tests ✅. The 1 unhandled rejection comes from the untouched useBfMarks under load (see Follow-ups).
- mobile jest related (org): 53 suites / 398 ✅. Lockstep and source-reading suites (i18nGuard, route, sections, links): 4 / 4019 ✅.
- server `node --test`: appPaths 5/0, bfElements.drift 15/0, learnMediaPack 2/0, publicBridgeScript 23/0.

The scratch worktree is removed.

## Merge order
Apply the fixes per branch:
- **p4:** fix 1.
- **p6:** fixes 2 and 3.
- **p7:** fixes 4 and 5 (revert bits/OverviewView/ReviewView/widgets/ConsumerUsageSection, delete usage.types.ts, trim learning.types.ts).

p5 has no fixes. Then merge lc/p4 → lc/p5 → lc/p6 → lc/p7 onto 77793e85 (independent; this order is clean). Afterwards run:
- agent-hub typecheck
- `node scripts/duplication-ratchet.mjs`
- check:fast
- server typecheck
- mobile jest for countries.lockstep and the i18nGuard suite
