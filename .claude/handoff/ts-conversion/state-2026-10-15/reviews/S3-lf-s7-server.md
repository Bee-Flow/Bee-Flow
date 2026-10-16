CHANGES REQUIRED: 3 source-reading tests go red. The production code moves are behaviour-identical.
# Opus review S3 LF-S7 server (s3/lfs7 = dad211e5, 413596bf, 1bb2671c, 0c2905ec on b36ec171)

## Blocking: tests that read source by path (STATE.md "Rules that bit us": run the full server and mobile suites after a split)
1. server/routes/transcriptions.mount.test.js:144 `reprocessPipeline.js declares no routes at all`. Every new non-router file in routes/transcriptions/ trips this check.
   Fix: `const NOT_ROUTERS = new Set(['shared.js', 'schemas.js', 'audioUpload.js', 'reprocessPipeline.js', 'speakerNaming.js', 'uploadIntake.js', 'uploadPipeline.js']);` and update the comment at :139 ("The modules in this folder that are NOT sub-routers: … the *Pipeline/*Intake/speakerNaming phase helpers of upload and reprocess").
2. server/automation/validate.knowledgeWrite.test.js:184-186 slices catalog.js from `knowledgeWriteStrategies:`, which is now `KNOWLEDGE_WRITE_STRATEGIES,` (catalog.js:123). The test therefore gets `[]` and fails. It passes on base.
   Fix: drop the source read and use `const fromCatalog = require('../routes/automation/catalogPickers').KNOWLEDGE_WRITE_STRATEGIES.map(s => s.value);`. This also removes one source-text test, so lint:source-text only goes down.
3. mobile/src/core/api/serverContract.test.ts:1097-1107 `routeSlice(catalog, "router.get('/catalog'")` no longer contains the action and app fields, which moved into catalogApps.js (name, description, inputSchema, outputSchema, outputSample, producesList, listField, sideEffect, effect, integrationId, integrationLabel, available, actions).
   Fix: keep the section keys and flags on the route slice, and check the action and app keys against `functionSlice(read('routes/automation/catalogApps.js'), 'buildApps')`. Run it with tools/heavy.sh jest.

## Behaviour (verified line by line against base): no change
4. upload: the provider allow-list, the 403 body {error, code:'provider_not_allowed', allowed}, the temp-file unlink before the 403 and the 503 project_check_unavailable (still thrown before the try) are all unchanged. The local→voxtral/whisperx/azure fallback is unchanged, and transcribed.provider reaches the completion patch and the log as before. The pyannote response is still trimmed to {text, segments} in upload and is the full object in reprocess, as on base. The completion still goes through transcriptionStore.updateTranscription, which seals. The await order (analyse → unlink temp → update → emit) is unchanged.
5. reprocess: 404/403 (owner check) → audio checks 410/503 → claim (409) → 202, in the same order and before any work. encryptRow, both snippets and the 21-parameter claim-guarded UPDATE stay in reprocess.js unchanged. The catch, finally and HttpError handling are unchanged, and no try/catch was added.
6. speakerNaming.js: identifySpeakerNames got the same arguments on both bases (upload roster `[...attendees, ...voiceprintRoster]`; reprocess manual names + attendees + voiceprint roster). The lookupUserName catch → null is the same in both. buildTranscriptOrThrow has the same message. Nothing was lost.
7. formQueue: the factory keys {accept, recoverPending, stop, stopServingPage, _queues, _reset} and the 12 module exports are unchanged and pinned (formQueue.test.js:196-212). The lease, renewal, settleUnfinished, recovery gates and 503 form_busy are copied as they were. `push` is a hoisted declaration, so passing it to createFormRecovery is safe.
8. catalog: the scoping inputs are identical: getIntegrationTools with userId/session/isAdmin/automationStep, resolveAudienceContext, the datatable principal, KB orgIds that are never null, and the agents principal. The await order is unchanged. /catalog/form-pick-sources ≡ base, with one theoretical exception: the `require('integrationTools')` load failure now gives a 500 where it used to give "all unavailable" (catalogApps.js:44 is outside the try). This is non-blocking and only matters if that module fails to load.

## Non-blocking
9. reprocess.test.js:97 stubs encryptRow as the identity, so a move that wrote plaintext would still pass. Tag it (`encryptRow: (id,row)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,'enc:'+v]))`) and assert that params[4..9] start with `enc:`.
10. Not characterised: the azure branch (truncation notice) and whisper_azure (numSpeakers), in both routes.
11. formQueue.js:79-80 and :190-191 have double blank lines.

## Gates (lfs7)
long-function server 105 ✅ · check:fast 39/39 ✅ · server typecheck 0 errors ✅ · duplication production 15398/15419, test 26240/26279 ✅ · scc server 60 (at budget) ✅ · touched and requiring tests green except #1 and #2 · full server suite: 2 files fail (#1, #2) · full mobile jest: serverContract fails (#3); serverClosure (initSchema filter) also fails on base; Markdown.test was a load timeout and is green on a re-run.

## Merge with s3/lfs7-jwt
Clean, no conflicts. Merged tree: typecheck 0 errors, long-function 104 ✅, duplication unchanged ✅, layering.test 5/5, scc 60, connectorJwt* (55+7+1+6+20) and lfs7 tests green, sessionShapes.contract and suppressSessionPersistence green. Scratch tree: rev-lfs7/merged.

## Resolution (integrator S3)
- 1-3 (source-reading tests), 4 (form-pick-sources load failure → all unavailable, as base; pinned by a test), 5 (encryptRow stub tags values, UPDATE params asserted sealed), 6 (azure + whisper_azure characterised, pass on base upload.js), 7 (blank lines): fixed in db73bf27. Item 4 re-read by the integrator against b36ec171 catalog.js:418-440: equivalent (any failure of the tools lookup leaves the empty set).
