# S3 report: subscriptions/security (batch 18) + structural (LF-S7, pages, editor)

Branch `claude/batch-18-lf-s7-server-me5ppc`. BASE `b36ec171` (= a3afd896 + `--no-ff` merge of ts-local/prep2).
At the integrator's request, `origin/ccr-28820270-xkvwp8` @ 95b13ce7 (wave1 + serverClosure fix) was merged in as 699753be before the first push.
Final commit: see `git log -1` of the branch (this file is updated with every push).

## Status per package
| Package | Status | Gate | Review |
|---|---|---|---|
| LF-S7 auth: `auth/connectorJwt.js` `connectorJwtMiddleware` | merged | long-function server −1 | reviews/S3-connectorJwt.md (Opus, CHANGES REQUIRED minor → fixed e71035f6) |
| LF-S7 server: transcriptions upload `POST /`, reprocess `POST /:id/reprocess`, `createFormQueue`, `GET /catalog` | merged | long-function server −4 | reviews/S3-lf-s7-server.md (Opus, CHANGES REQUIRED → fixed db73bf27) |
| Batch 18 (admin/subscriptions, admin/security, admin/shared) | in progress | | |
| LF-A1 LoginPage | in progress | | |
| LF-A2 TemplatesPage, AdvancedSettings, EmbedChat | in progress | | |
| LF-A6 PageRenderer, BeeEditor | in progress | | |
| LF-A9 useAppBuilderStream, useVoiceSession | in progress | | |

## LF-S7 details
- connectorJwt (717 → 403 lines) + `auth/connectorJwtPhases.js` (outcome helpers reject/fail/ok, gates, establishConnectorSession) + `auth/connectorJwtProvision.js`. Phases never touch res/next; one caller inside the original try answers reject/error and calls `next()` only for `kind === 'ok' && req.session?.isAuthenticated === true`; anything else throws → 401 (fail closed). 59 characterisation tests (`connectorJwt.characterise.test.js`) pass on b36ec171 and after the split; mutation-checked by the reviewer.
- upload.js 585 → 193 lines (+ uploadIntake.js, uploadPipeline.js, speakerNaming.js — the speaker-naming step was identical in upload and reprocess and is now shared); reprocess.js (+ reprocessPipeline.js; the sealed `encryptRow` UPDATE and the `reprocessed: true` emit stay in reprocess.js because source-reading tests pin them there); formQueue.js 507 → 251 (+ formQueueWork/Leases/Recovery/Shared.js, key set pinned); catalog.js 499 → ~240 (+ catalogApps.js, catalogPickers.js).
- Measured: `long-function server` 109 → 104 (budget 109 untouched, no `--update`).

## Integrator: watch at merge
- Duplication: BASE (prep2 alone) measured 15423 > 15419 (resolveBinding.ts ↔ mobile runtime ports); fixed upstream in 95b13ce7, merged here.
- Ratchet budgets NOT lowered here (rule): server long-function 109 → measured 104; `.file-budget.json` ceilings for auth/connectorJwt.js (717 → 403 lines), automation/formQueue.js (507), routes/automation/catalog.js (499), routes/transcriptions/upload.js (585) can come down in §5.
- Comments outside S3 scope name the old writer: mobile/src/features/notifications/model/routeOrg.ts:69, route.test.ts:33, agent-hub/src/authedApp/appRoutes.test.js:194 say `auth/connectorJwt.js` (pending-user notification now lives in auth/connectorJwtProvision.js). Cosmetic.
- Source-reading tests repointed by S3: server/auth/suppressSessionPersistence.test.js, sessionShapes.contract test (→ connectorJwtPhases.js / all three files), server/routes/transcriptions.mount.test.js (NOT_ROUTERS), server/automation/validate.knowledgeWrite.test.js (KNOWLEDGE_WRITE_STRATEGIES from catalogPickers.js), mobile/src/core/api/serverContract.test.ts (app/action keys from catalogApps.js `buildApps`).
