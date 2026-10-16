# S3 report: subscriptions/security (batch 18) + structural (LF-S7, pages, editor)

Branch `claude/batch-18-lf-s7-server-me5ppc`. BASE `b36ec171` (= a3afd896 + `--no-ff` merge of ts-local/prep2).
At the integrator's request, `origin/ccr-28820270-xkvwp8` was merged in twice before the first push: @95b13ce7 (wave1 + serverClosure fix) as 699753be, and @e738f454 (lowered budgets, node_modules symlink ignore, batches 07-12, b2) as eaa8f751. No node_modules symlink is in any S3 commit (checked with `git log -p <BASE>..HEAD --name-only`).
Final commit: see `git log -1` of the branch (this file is updated with every push).

## Status per package
| Package | Status | Gate | Review |
|---|---|---|---|
| LF-S7 auth: `auth/connectorJwt.js` `connectorJwtMiddleware` | merged | long-function server −1 | reviews/S3-connectorJwt.md (Opus, CHANGES REQUIRED minor → fixed e71035f6) |
| LF-S7 server: transcriptions upload `POST /`, reprocess `POST /:id/reprocess`, `createFormQueue`, `GET /catalog` | merged | long-function server −4 | reviews/S3-lf-s7-server.md (Opus, CHANGES REQUIRED → fixed db73bf27) |
| Batch 18 (admin/subscriptions, admin/security, admin/shared) | merged | 39 identical (commit 1) + 7 catch-recipe files (commit 2) | reviews/S3-batch-18.md (Opus security, CHANGES REQUIRED: orgShieldClamps listOf → fixed, types only) |
| LF-A1 LoginPage | in progress | | |
| LF-A2 TemplatesPage, AdvancedSettings, EmbedChat | in progress | | |
| LF-A6 PageRenderer, BeeEditor | in progress | | |
| LF-A9 useAppBuilderStream, useVoiceSession | in progress | | |

## LF-S7 details
- connectorJwt (717 → 403 lines) + `auth/connectorJwtPhases.js` (outcome helpers reject/fail/ok, gates, establishConnectorSession) + `auth/connectorJwtProvision.js`. Phases never touch res/next; one caller inside the original try answers reject/error and calls `next()` only for `kind === 'ok' && req.session?.isAuthenticated === true`; anything else throws → 401 (fail closed). 59 characterisation tests (`connectorJwt.characterise.test.js`) pass on b36ec171 and after the split; mutation-checked by the reviewer.
- upload.js 585 → 193 lines (+ uploadIntake.js, uploadPipeline.js, speakerNaming.js — the speaker-naming step was identical in upload and reprocess and is now shared); reprocess.js (+ reprocessPipeline.js; the sealed `encryptRow` UPDATE and the `reprocessed: true` emit stay in reprocess.js because source-reading tests pin them there); formQueue.js 507 → 251 (+ formQueueWork/Leases/Recovery/Shared.js, key set pinned); catalog.js 499 → ~240 (+ catalogApps.js, catalogPickers.js).
- Measured: `long-function server` 109 → 104 (budget 109 untouched, no `--update`).

## Integrator: watch at merge
- Lowered budgets (e738f454): the LF-S7 characterisation tests pushed test duplication to 26240 (> 26228) and server module-mock to 812 (> 810); fixed in 6c4e7012 by switching catalog.sections.test.js and transcriptions/reprocess.test.js to `testUtils/stubRequire.js` `preloadStubs` (no assertion lost). Both now sit exactly AT budget (no slack).
- Duplication: BASE (prep2 alone) measured 15423 > 15419 (resolveBinding.ts ↔ mobile runtime ports); fixed upstream in 95b13ce7, merged here.
- Ratchet budgets NOT lowered here (rule): server long-function 109 → measured 104; `.file-budget.json` ceilings for auth/connectorJwt.js (717 → 403 lines), automation/formQueue.js (507), routes/automation/catalog.js (499), routes/transcriptions/upload.js (585) can come down in §5.
- Comments outside S3 scope name the old writer: mobile/src/features/notifications/model/routeOrg.ts:69, route.test.ts:33, agent-hub/src/authedApp/appRoutes.test.js:194 say `auth/connectorJwt.js` (pending-user notification now lives in auth/connectorJwtProvision.js). Cosmetic.
- Source-reading tests repointed by S3: server/auth/suppressSessionPersistence.test.js, sessionShapes.contract test (→ connectorJwtPhases.js / all three files), server/routes/transcriptions.mount.test.js (NOT_ROUTERS), server/automation/validate.knowledgeWrite.test.js (KNOWLEDGE_WRITE_STRATEGIES from catalogPickers.js), mobile/src/core/api/serverContract.test.ts (app/action keys from catalogApps.js `buildApps`).

## Push log
| Pushed commit | Verified at | check:fast | server typecheck | duplication (prod / test) | gitleaks | agent-hub tsc | agent-hub vitest | mobile jest | mobile tsc | server npm test |
|---|---|---|---|---|---|---|---|---|---|---|
| this commit (docs-only on top) | 83c6f167 | 39/39 | 0 errors | 15358 ≤ 15383 / 26228 ≤ 26228 | clean | 0 errors | 1836 files, 21619 pass | 762 suites, 13430 pass | 0 errors | 29058 pass, 0 fail, 0 HUNG |
| after batch 18 + c0c47225 (b2) | e9cb7b18 (+ a types-only useApi.ts fix whose emitted JS is byte-identical; typecheck 0, check:fast 39/39 re-run on it) | 39/39 | 0 errors | 15321 ≤ 15383 / 26228 = 26228 | clean | 0 errors (after the fix) | 1848 files, 21690 pass | 762 suites, 13428 pass | 0 errors | 29058 pass, 0 fail, 0 HUNG |

## Batch 18 details
- Converted 46 of 57: 39 types-only (gate: 39 identical, 0 different; no D/A pairs except ui/typedUi.ts deleted — 7 `as unknown as ComponentType` shims whose 4 importers (access/*.tsx) now use the real typed components) and 7 in the caughtError commit (useShieldActivity, AuditView, GrantWizard, OrgsView, PlansView, PromosView, StripeView: 9× messageOf, 1× errorMessage, 1× errorBodyRecord; no // behaviour: notes).
- Kept JS (byte-identical to base): GrantsView (runtime: `copyBlob(g.blob)` in a closure after a guard), OrgEditor / QuickAssignDialog / TrialOffersPanel / PlanCard (runtime: nullable numeric comparison/arithmetic), PromoEditor (runtime: parseInt(number)), FeatureCardGrid (runtime: Map.get(k).push), FeaturesSection (blocked by FeatureCardGrid), OrgShieldEditor (blocked by orgShieldPosture), orgShieldPosture (runtime: nullable egress deref), orgShieldDirty (runtime: unknown payload read as tool policy), shieldFilters / shieldRows (runtime: new Date(unknown)), access/countries (mirror candidate, see below). The reviewer thinks GrantsView, OrgEditor, QuickAssignDialog, TrialOffersPanel are convertible with the catch recipe in a follow-up.
- Entitlement typing checked against the server (Opus): plan limits `number | null` (null = unlimited), allow-lists `string[] | null` (null = unrestricted), UsageBar/StatRow treat `== null` as unlimited: no fail-open. useResource got overloads (data non-null when `initial` given).
- Mirror candidate: web admin/subscriptions/access/countries.js ↔ mobile/src/features/org/model/countries.ts (converting the web file made a 105-line clone; mobile has phone-only types, another countryName signature, no EU_EEA/countryFlag).
- Pre-existing (not fixed here): a LimitField override of '' is coerced by the server to a cap of 0 (fails closed); useResource yields data = null on a 2xx with an unparsable body.
- After b2 (c0c47225): subscriptions hooks/useApi.ts `api`/`apiJson` opts typed `AuthFetchOptions` (was RequestInit).
