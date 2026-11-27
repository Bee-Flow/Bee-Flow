# Dress rehearsal: all module server files moved (plan step 0.9)

Tool commit `8e4ef2ba` (scripts/module-move.mjs) on top of `018bd1a1`. Nothing from the rehearsal is
committed. The worktree was reset afterwards.

## What was run

1. `node scripts/module-move.mjs --all --rehearse --report rehearse-report.json` covered 23 modules in the
   server package and took 23.5 s. Its output is in `rehearse-stdout.txt` and the full report in
   `rehearse-report.json`.
2. `cd server && npm run typecheck` wrote `typecheck.log`.
3. `npm run check:fast` wrote `checkfast.log`.
4. The full server suite ran once in FULL mode, with an fs tracer preloaded, and took 912 s.
   `run-traced.sh` sets `NODE_OPTIONS=--require fsTracer.cjs` and starts
   `node scripts/run-tests.mjs`, which adds the resolver after the tracer. The log is `suite-full.log`. It
   was parsed into `failures.json`. `classify.mjs` then grouped the failures into
   `failures-classified.json`; I read each log to decide the cause.
5. The fs tracer (`fsTracer.cjs`):
   - It wraps readFileSync, readdirSync, existsSync, statSync, lstatSync, accessSync, opendirSync,
     createReadStream, readFile, readdir and stat, and the fs.promises forms readFile, readdir, stat, lstat,
     access and opendir.
   - It ignores calls from the CJS loader, from the resolver itself and from tooling that already sees
     every root (scripts/lib/roots.mjs, module-map, testScope, run-tests).
   - It records four kinds of call:
     - `misrouted`: the path does not exist at its root, but its tree path exists in another root.
     - `splitDir`: a readdir of a tree directory that exists in more than one root.
     - `repoPath`: a path below modules/<id>/, outside its roots, that exists beside server/.
     - `crossOwner`: a hand-computed read of a file that another owner holds.
   - Raw lines are in `trace-full/*.jsonl` and the per-caller summary in `trace-summary.json`.
6. Two static scans:
   - `staticPaths.mjs` wrote `static.json`. It finds every `path.join/resolve(__dirname | import.meta.dirname | <const
     from __dirname>, '<literal>'...)` in every root and evaluates it at the file's old and new place. An
     entry is listed when the old target existed in HEAD (with or without extension) and the new one is
     missing or lands on a split directory.
   - `escapes.mjs` wrote `escapes.json`: relative require/import specifiers in module roots that leave the
     tree.
7. `buildConversions.mjs` merges step 6 and the trace into `conversions.json`. `pilots.mjs` writes
   `pilots.json`.

## a. The move tool's gates

| module | files | eslint suppression entries moved |
|---|---:|---:|
| datatables | 292 | 70 |
| automation | 1675 | 334 |
| cowork | 386 | 5 |
| apps | 1508 | 210 |
| playbooks | 63 | 17 |
| compliance | 419 | 107 |
| sanctions | 31 | 0 |
| cms | 259 | 50 |
| webpages | 187 | 54 |
| notebooks | 52 | 13 |
| templates | 18 | 3 |
| meetingNotes | 253 | 40 |
| support | 87 | 24 |
| learning | 46 | 7 |
| int_nextcloud | 123 | 23 |
| int_google | 43 | 14 |
| int_microsoft | 26 | 7 |
| int_erp_nl | 63 | 6 |
| int_saas | 42 | 14 |
| custom_integrations | 39 | 9 |
| mcp_server | 15 | 3 |
| projects | 288 | 80 |
| billing_stripe | 53 | 12 |
| **total** | **5968** | **1102** |

| gate | result |
|---|---|
| sha256 per file against HEAD | ok: 5968/5968 byte-identical |
| duplicateTreePaths() | ok: 0 clashes |
| module-map --check | ok |
| module-boundary (rule 4 now applies to all 23) | ok |
| lint:i18n-gen | ok, no drift |
| lint:scripts-index | ok, no drift |
| lint:shared-mirror | **FAIL**: `scripts/gen-step-kinds.mjs` imports `server/appStudio/stepKindsGen.mts` by a hand-built path, and the file is now in modules/apps (inventory: pending, generators) |
| manifest splits | **FAIL**: `scripts/shared-mirror.manifest.json:53` names `server/shared/appDefinition`, which is now split over apps and core. A real move of `apps` would stop at preflight here. |

The tool also did the following:
- It rewrote 1087 mentions in 661 text files. Most are in agent-hub/src (about 450 comments and tests),
  mobile/src (134), docs (52), .github (5: dependabot.yml, security/audit-baseline.json,
  a11y-conformance.yml, build-push-ghcr.yml, and ci.yml in three non-brace step lines), .gitleaks.toml,
  desktop (3), nextcloud-connector tests (3), scripts/roots-inventory.json and
  scripts/shared-mirror.manifest.json. The full list with every rewrite is under `edits` in
  `rehearse-report.json`.
- It found 388 mentions of split directories. Only 1 is a manifest value of its own (above). The rest are
  prose: about 360 `GENERATED from server/i18n/defaults/en/` headers in
  `agent-hub/src/i18n/en/*.generated.mjs`, and comments or reasons in ci.yml, .file-budget.json and
  roots-inventory.json.
- It left 19 files in scripts/ with mentions it does not rewrite (fixtures, the generated README table). It
  reports them as "check by hand". Some are real breakages, not comments:
  `scripts/learn-media-fetch.mjs:28` (`require('../server/learning/learnMediaInstall.js')`),
  `scripts/check-legal-catalogue.mjs:91`, `scripts/gen-app-catalog.mjs`, `scripts/gen-step-kinds.mjs`,
  `scripts/stage-server-context.sh:14,20,71`, `scripts/generate-sbom.sh:127`,
  `scripts/release-notes/draft.js:13,19` and `scripts/app-compat-pixels.mjs`.
- It linked node_modules for all 23 roots.

## b. `cd server && npm run typecheck`

813 errors in 182 files. Every one is in a core file. Module files are not checked at all, because the
script only walks `server/`.

- 793 are TS2307 "Cannot find module '../x'": a core file requires a file that moved. For tsc the
  roots are not one tree.
- 20 are TS7006 "implicitly has an 'any' type": callbacks whose types came from those modules. They
  follow from the TS2307 errors.

What typecheck needs:
1. `server/scripts/typecheck.mjs` must collect the marked files from every root through
   `scripts/lib/roots.mjs`, and put the module files in the generated tsconfig's `files`. Today it uses
   `readdirSync(SERVER_DIR)`.
2. The generated `.typecheck.*.tsconfig.json` (or `server/jsconfig.json`) needs
   `compilerOptions.rootDirs: ["./", "../modules/<id>/server", ...]`, one entry per root.
   rootDirs makes tsc resolve a relative import across directories that form one virtual tree, which
   is exactly the resolver's rule. It takes no globs, so typecheck.mjs must write the list. `paths`
   (googleapis and ical shims) stays relative to server/.
3. The diagnostics filter keys on paths relative to server/. Module files must be reported as
   `modules/<id>/server/<tp>` (or by tree path).
4. `scripts/checkjs-ratchet.mjs` counts markers in server/ only (see c). It must count over every root,
   or the next typecheck run would also look like it dropped 2778 marked files.

## c. `npm run check:fast`

69 passed, 7 failed, 1 skipped (gitleaks not installed).

| check | why | inventory entry |
|---|---|---|
| lint:shared-mirror | gen-step-kinds imports `server/appStudio/stepKindsGen.mts` by path | `scripts/gen-step-kinds.mjs` pending/generators (also gen-app-catalog.mjs, gen-shared-mirror.mjs, shared-mirror.manifest.json, all pending/generators) |
| lint:file-budget | 8 data entries in server/.file-budget.json "match no file" (appStudio/templates/**, learning/catalog.generated.js, automation/builderPrompt.js, ...): it walks server/ only, and the keys are tree paths | `scripts/file-budget.mjs` pending/ratchets |
| lint:checkjs-ratchet | 2218 marked files against a floor of 4996 (noImplicitAny 1595/3402, strict 1581/3374) | `scripts/checkjs-ratchet.mjs` pending/ratchets |
| lint:row-types | server/types/rows.d.ts stale: CREATE TABLE in module stores is not seen | `scripts/gen-row-types.mjs` pending/generators |
| lint:scripts-types | `scripts/learn-media-fetch.mjs(28)` cannot find `../server/learning/learnMediaInstall.js` | `scripts/learn-media-fetch.mjs` pending/ops-scripts (and `scripts/tsconfig.json` is not in the inventory) |
| lint:legal-catalogue | requires `server/compliance/frameworks.js` by path: MODULE_NOT_FOUND | `scripts/check-legal-catalogue.mjs` pending/checks |
| lint:compat-corpus | 166 corpus files "deleted" (git diff on server/appStudio/compat/{corpus,frozen}) | `scripts/check-compat-corpus.mjs` pending/checks |

**Passes that are blind.** Every count ratchet over `server` (`count-ratchet.mjs`), plus
`scc-ratchet`, `source-text-tests`, `env-inventory`, `lint:layering-ratchet` and
`lint:module-mock-ratchet`, stayed green only because the files they count have left server/. Their
measurements fell, so "may only go down" holds. These are inventory entries that are pending and
green. They are more dangerous than the red ones, and need converting before the first real move. The
trace shows `server/layering.test.js:129/144` statting 358 vanished files and passing anyway.

## d. Full server suite after the move

The summary line is `4008 files: 42128 tests, 41765 pass, 298 fail, 19 cancelled`. **76 failing test files**
(75 FAIL, 1 HUNG) out of 4008. By cause:

| cause | files |
|---|---:|
| 1 hand-computed path (__dirname / import.meta) into another root | 26 |
| 2 readdirSync over a directory now split across roots | 2 |
| 3 test reads the source text of a moved file | 22 |
| 4 child process or worker started without the resolver | 2 |
| 5 tool or test kit that walks server/ only | 21 |
| 6 other | 3 |

Notes on the causes:
- Cause 5 includes 13 App Studio tests that all fail on one line, `server/testUtils/studioRunTables.js:27`.
- Several cause-1 failures come from **production** code with a module-level asset read, not from tests:
  - `modules/webpages/server/routes/publicViewer.js:427-428` (assets/brand/bee-icon.svg) breaks the
    route walk, and with it `routes.contract.test.js` and `auth/accessRegistry.drift.test.js`.
  - `modules/cms/server/core/seo/ogText.js:27/39` (assets/fonts).
  - `modules/automation/server/automation/triggerSources/index.js:99` (mcpServers) makes
    `tuya.*` trigger sources vanish.
  - The compliance checks `checks/iso27001/a5-15-access-control.js:19-20`, `a8-24-cryptography.js:23/25`
    and `a8-5-secure-auth.js` read core auth files and config/orgRoles.json.
- Cause 4 is one line: `modules/automation/server/automation/codeSandboxProcess.js:85` forks the sandbox
  with `childEnv()` (line 48). `childEnv()` keeps only KEPT_ENV, so NODE_OPTIONS and the resolver are lost.
- Cause 6 is two resolver gaps and one guard that is meant to fail. The resolver gap: a relative request
  that leaves a module root (`../../nextcloud-connector/...`, `../../../agent-hub/...`) is not mapped
  back beside server/.

The full table, with the first error line and the reason for each file, follows. The same data is in
`failures-classified.json`.

### Cause 1: hand-computed path (__dirname / import.meta) into another root (file access) (26)

| test file | first error | why |
|---|---|---|
| `auth/accessRegistry.drift.test.js` | test did not finish before its parent and was cancelled | the route-walk child loads routes/publicViewer.js, whose module-level read of assets/brand/bee-icon.svg (publicViewer.js:428, __dirname) throws; the child itself has the resolver |
| `routes/cmsSitesAdmin.test.js` | these mocks stand in for a spelling nothing requires. Either the module moved and the real spelling is now unmocked (the expensive case — the mock qui | the resolve-stub keys are absolute paths computed from __dirname in modules/cms/server; the module now requires the core file at its real path, the stubs match nothing (stubRequire guard) |
| `services/publicBridgeScript.test.js` | de client-helft van de tweeling staat niet (meer) op modules/webpages/agent-hub/src/shared/webpage/previewBridges.mjs. Is hij verhuisd, zet het nieuwe | repo path agent-hub/src/shared/webpage/previewBridges computed from __dirname of a moved test (repoPath) |
| `routes/publicViewer.slug.test.js` | "ENOENT: no such file or directory, open 'modules/webpages/server/assets/brand/bee-icon.svg'" | publicViewer.js:428 assets/brand/bee-icon.svg |
| `core/webpages/bfElements.drift.test.js` | "ENOENT: no such file or directory, open 'modules/webpages/agent-hub/src/utils/bfElements.ts'" | repoPath: agent-hub/src/utils/bfElements.ts from a moved test |
| `core/seo/ogCard.test.js` | "ENOENT: no such file or directory, open 'modules/cms/server/assets/fonts/Fraunces-Variable.woff2'" | core/seo/ogText.js:39 reads assets/fonts/Fraunces-Variable.woff2 by __dirname (production code in cms) |
| `automation/tableTemplates.test.js` | customer-satisfaction.csv exists | repoPath: agent-hub/public/automation-samples from a moved test |
| `routes/cmsOgImage.test.js` | Expected values to be strictly equal: + actual - expected | same: ogText.js:39 font asset by __dirname |
| `compliance/__tests__/smoke.test.js` | real registry: expected status "pass", got "fail" (details: The role definitions (config/orgRoles.json) could not be loaded — permission grants have n | compliance checks compute config/orgRoles.json and other core files by __dirname (checks/iso27001/*.js), then fall through to the real DB |
| `automation/triggerSources/autoDerive.test.js` | Expected values to be strictly deep-equal: + actual - expected | triggerSources/index.js:99 readdir of mcpServers by __dirname (production code): declared trigger sources vanish |
| `automation/builderTools/triggerAdvice.test.js` | "ENOENT: no such file or directory, open 'modules/automation/agent-hub/src/components/automation/Builder/flow/settings/triggerFilters.tsx'" | repoPath: agent-hub/src/components/automation/Builder/flow/... from a moved test |
| `appStudio/appFontRoles.test.js` | "ENOENT: no such file or directory, scandir 'modules/apps/agent-hub/public/fonts/inter'" | repoPath: agent-hub/public/fonts/inter scandir from a moved test |
| `appStudio/builderTools/toolNames.mirror.test.js` | "ENOENT: no such file or directory, open 'modules/apps/agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json'" | repoPath: agent-hub/.../appToolNames.generated.json from a moved test |
| `appStudio/builderTools/toolRegistry.contract.test.js` | Cannot find module 'modules/apps/agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json' Require stack: | require(path.join(__dirname, ..., "agent-hub", ...)) of a repo file from a moved test |
| `routes.contract.test.js` | the route walk failed (exit 3): [StorageStore] RustFS not configured — using local-disk fallback at server/data/storage | same root cause as accessRegistry.drift: publicViewer.js:428 reads assets/brand/bee-icon.svg by __dirname during the route walk |
| `routes/publicViewer.sandbox.test.js` | "ENOENT: no such file or directory, open 'modules/webpages/server/assets/brand/bee-icon.svg'" | publicViewer.js:428 assets/brand/bee-icon.svg |
| `core/seo/seo.test.js` | "ENOENT: no such file or directory, open 'modules/cms/agent-hub/src/utils/cmsPublicRouting.ts'" | repoPath: agent-hub/src/utils/cmsPublicRouting.ts from a moved test |
| `core/automationModel/notificationDefaults.test.js` | "Cannot find module 'modules/automation/agent-hub/src/components/automation/Builder/notificationDefaults.ts' imported from modules/automation/server/c | import of agent-hub/... by a path computed from the moved test (repoPath) |
| `automation/builderTools/triggerRegistry.golden.test.js` | tuya.device.status.changed disappeared — saved automations bind against it | triggerSources/index.js:99 mcpServers by __dirname: tuya.* sources gone (production code) |
| `automation/builderPrompt/triggerBlock.test.js` | tuya.device.status.changed is in the sidecar but not declared | triggerSources/index.js:99 mcpServers by __dirname (production code) |
| `learning/learnMediaPack.test.js` | no videoId found in the lesson files: did their location or shape change? | repoPath: agent-hub/src/components/onboarding/lessons.ts from the moved test (learnMediaPack.test.js:21) |
| `learning/visibility.test.js` | true == false | stub keys path.resolve(__dirname, "..", "stores", ...) point into modules/learning/server: the stubs miss, the real store connects to Postgres |
| `core/dataEngine/dataModel/vocabulary.lockstep.test.js` | "ENOENT: no such file or directory, open 'modules/datatables/agent-hub/src/components/admin/Studio/AppStudio/tables/tablesManagerModel.ts'" | repoPath: agent-hub/src/components/admin/Studio/AppStudio/table... from a moved test |
| `automation/builderPrompt/rankApps.test.js` | Expected values to be strictly equal: + actual - expected | path.join(__dirname, "..", "..", "core", "rerank", "llamaCppRerank.js") (rankApps.test.js:25) used as a stub key: core file, computed from the moved test |
| `learning/certificates.test.js` | connect ECONNREFUSED 127.0.0.1:5432 | stub keys path.resolve(__dirname, "..", "stores", "configStore") (certificates.test.js:24-25) point into modules/learning/server: real configStore connects to 127.0.0.1:5432 |
| `automation/builderTools/deriveTitle.test.js` | "ENOENT: no such file or directory, scandir 'modules/automation/server/scripts/builder-briefs'" | scandir scripts/builder-briefs (core, server/scripts) by __dirname from the moved test |

### Cause 2: readdirSync over a directory now split across roots (2)

| test file | first error | why |
|---|---|---|
| `jobs/lib/advisoryLockKeys.test.js` | expected at least 10 exported locks, found 8 | readdirSync(server/jobs): jobs/ is split over 9 roots |
| `i18n/defaults/nl/index.test.js` | Expected values to be strictly deep-equal: + actual - expected | nl/index.test.js:93 compares listFiles() (all roots) with listFiles(NL_DIR = __dirname, core root only): i18n/defaults/nl is split over 10 roots |

### Cause 3: test reads the source text of a moved file (22)

| test file | first error | why |
|---|---|---|
| `compliance/dataPortability/exportRegistry.test.js` | "ENOENT: no such file or directory, open 'modules/compliance/server/index.js'" | reads index.js text via path.join(__dirname, ...) from modules/compliance/server |
| `migrations/datatable-schema-rename-2026-09.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `migrations/automation-form-audience-2026-09.integration.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `automation/usageSync.savePaths.test.js` | "ENOENT: no such file or directory, open 'modules/automation/server/stores/datatableStore.js'" | reads stores/datatableStore.js text by a path relative to the moved test |
| `appStudio/automationUsage.savePaths.test.js` | "ENOENT: no such file or directory, stat 'modules/apps/server/projects/packaging/install/parts/apps.js'" | stats/reads projects/packaging/install/parts/apps.js (another module) by a path relative to the moved test |
| `core/agentRuntime/testAs.wiring.test.js` | "ENOENT: no such file or directory, open 'server/core/tools/datatableTools.js'" | core test reads core/tools/datatableTools.js text (now in modules/datatables) |
| `core/automationRunner/egressCoverage.test.js` | "ENOENT: no such file or directory, open 'modules/automation/server/routes/webpagesPreview.js'" | reads routes/webpagesPreview.js (webpages) text relative to the moved test |
| `stores/datatableStore.test.js` | "ENOENT: no such file or directory, open 'modules/datatables/server/storeModules.js'" | reads storeModules.js (core) text relative to the moved test |
| `modules/moduleGatedTick.test.js` | "ENOENT: no such file or directory, open 'server/core/automationRunner/scheduler/ticks.js'" | core test reads core/automationRunner/scheduler/ticks.js and jobs/learningNudge.js text |
| HUNG `stores/usageStore.studioAppRuns.test.js` |  | HUNG: reads routes/studioAppsRun.js and usecases/studioAppsRunUsage.js (apps) text at load (usageStore.studioAppRuns.test.js:32,35); the ENOENT at load leaves a handle open |
| `auth/microsoftScopes.test.js` | "ENOENT: no such file or directory, open 'server/integrations/msGraphClient.js'" | core test reads integrations/msGraphClient.js text (int_microsoft) |
| `migrations/datatable-field-ids-2026-09.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `migrations/automation-org-backfill-2026-09.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `migrations/constraintOscillation.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `routes/datatables.test.js` | "ENOENT: no such file or directory, open 'modules/datatables/server/index.js'" | reads index.js (core) text relative to the moved test |
| `core/aiTaskRunner.autoSend.test.js` | "ENOENT: no such file or directory, open 'modules/cowork/server/integrations/toolFamilies.js'" | reads integrations/toolFamilies.js (core) text relative to the moved test |
| `migrations/approvals-deliveries-2026-08.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `migrations/automation-run-root-2026-08.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |
| `routes/ai/config/integrations.tls.test.js` | "ENOENT: no such file or directory, open 'server/integrations/n8nTools.js'" | core test reads integrations/n8nTools.js text (int_saas) |
| `license/featureMap.notes.test.js` | "ENOENT: no such file or directory, open 'server/routes/studioAppDatasets.js'" | core test reads routes/studioAppDatasets.js text (apps) |
| `migrations/learning-routine-ids-2026-10.test.js` | "ENOENT: no such file or directory, open 'server/learning/catalog.generated.js'" | core migration test reads the source text of a moved store/catalogue |
| `migrations/automation-run-token-vault-2026-08.test.js` | "ENOENT: no such file or directory, open 'server/stores/automationStore/core.js'" | core migration test reads the source text of a moved store/catalogue |

### Cause 4: child process or worker started without the resolver (2)

| test file | first error | why |
|---|---|---|
| `automation/codeSandboxProcess.escape.test.js` | Cannot find module '../utils/ssrfGuard' Require stack: | codeSandboxProcess.js:85 forks the sandbox child with childEnv(), which drops NODE_OPTIONS: no resolver, ../utils/ssrfGuard not found |
| `core/cowork/routine.engine.pg.test.js` | [fallback] core/automationRunner/runDeadline:raceRunDag fell back to a default Error: Cannot find module '../utils/ssrfGuard' | same sandbox child (codeSandboxProcess.js:85) through raceRunDag |

### Cause 5: tool or test kit that walks server/ only (21)

| test file | first error | why |
|---|---|---|
| `auth/accessRegistry.sweep.test.js` | verdacht klein oppervlak (595 routes) — is de parser of index.js kapot, of is er een routegroep stilletjes onleesbaar geworden? | parses index.js and walks route files under server/ only (SERVER = path.resolve(__dirname, "..")) |
| `importPaths.test.js` | unresolvable relative imports: auth/accountProvisioning.js -> ../services/trialService | walks server/ only and resolves relative imports itself: a core import of a moved file is "unresolvable" |
| `boot/bootMigrations.test.js` | deze migraties draaien nergens en zijn nergens verantwoord. Zet ze in LOOSE_MIGRATIONS of NL_TRANSLATIONS (boot/bootMigrations.js) als ze bij | walks server/ for migration names and readdirSync(server/migrations) only |
| `core/privacy/chatSignals.callers.test.js` | a new caller of the chat-signals recorder: decide that its turns are person-to-AI, marked and announced, then add it to ALLOWED + actual - expected | testUtils/requireEdges walks server/ only: callers in module roots vanish from the edge list |
| `appStudio/backgroundRun.parallel.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/backgroundRun.durable.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/backgroundRun.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/backgroundRun.waits.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/runLog/recorder.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/deploySync.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/recordTriggers.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/httpRequestTrigger.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/triggerFire.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/webhook/webhookEndpoints.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `appStudio/triggers/webhook/webhookReceive.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `boot/featureModules.test.js` | only 12 feature module names found in the source | walks server/ for featureModule() names: only 12 left |
| `core/kb/queryLog/searchCallSites.inventory.test.js` | stale inventory entries (the call is gone): appStudio/actionExecutor/aiSteps.js::groundWithKB, appStudio/aiRuntime.js::quickKBSearch, core/automationR | scanSearchCallSites(SERVER_ROOT) walks server/ only: call sites in module roots read as stale |
| `routes/studioAppWebhook.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `stores/studioAppData/runLogStore.test.js` | "ENOENT: no such file or directory, open 'server/stores/studioAppData/schema.js'" | testUtils/studioRunTables.js:27 reads stores/studioAppData/schema.js by a server/ path (a test kit) |
| `migrateDb.registration.test.js` | EXEMPT wijst naar een verdwenen bestand: stores/lib/automationTestingSchema.js | walks server/ for CREATE TABLE and checks an EXEMPT list by server/ path |
| `routes/writeGates.test.js` | routes/studioApps holds no route source — did the router move? | reads route sources under server/ only: routes/studioApps is gone |

### Cause 6: other (3)

| test file | first error | why |
|---|---|---|
| `routes/nextcloudTaskProcessing.agent.test.js` | Cannot find module '../../nextcloud-connector/src/taskProcessing' Require stack: | require("../../nextcloud-connector/...") leaves the tree: the resolver does not map a request that escapes a module root (resolver gap) |
| `appStudio/builderTools/toolRegistry.fixture.test.js` | Cannot find module '../../../agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json' Require stack: | relative require ../../../agent-hub/... leaves the tree (resolver gap, same as nextcloudTaskProcessing) |
| `scripts/run-postgres-tests.test.mjs` | today every listed file is in server/ + actual - expected | asserts "today every listed file is in server/": a guard that is meant to flip at the first move |

## e. fs tracer

There are 5269 distinct records (caller:line, path, op) from 107 calling files:
- 4102 splitDir
- 933 misrouted
- 211 crossOwner
- 23 repoPath

They group into three patterns:

- **Whole-tree walkers that pass while blind.** These walk `server/` (243 to 245 split directories each),
  and their tests stay green: `server/auth/loginPaths.js:164` (production code: the login-path
  inventory no longer sees module files), `server/core/kb/queryLog/searchCallSites.scan.mts:20`
  (production code), `server/testUtils/pgliteTemplate.js:79`, `server/testUtils/requireEdges.js:30`,
  `server/layering.test.js:129/144`, `server/auth/sessionShape.test.js:40`, `server/auth/router.test.js:89`,
  `server/auth/passwordChangedAt.paths.test.js:137`, `server/stores/knowledgeStore.test.js:59`,
  `server/stores/user/organizations.configKeys.test.js:46`, `server/agents/memory/singleExtractor.test.js:33`,
  `server/core/agentRuntime/lending.callSites.test.js:38` and
  `server/core/integrations/ncScopeGuard.callSites.test.js:78`.
  pgliteTemplate is the worst of them: its `sourceHash()` keys the PGlite template cache. A schema change in a
  module root would no longer invalidate the cache, and every PGlite test would then run on a stale schema.
- **Production readers of split directories inside modules.** These still find their own part, but they
  silently miss what other roots hold:
  - apps: `appStudio/componentSpecs/{keyMarks,registryDir,stepRegistry}.js`, `appStudio/actionExecutor/dispatch.js:45`,
    `definitionKeyRegistry.mts`, `triggers/triggerKinds.mts`, `compat/{corpus,formulaBaseline}.mts`,
    `builderTools/toolRegistry.mts:41`
  - compliance: `compliance/checks/index.js:29`, `compliance/connectors/index.js`
  - automation: `automation/triggerSources/index.js:85/120`
  - datatables: `core/dataEngine/sources/index`
  
  These become `listTreeDir()`.
- **Misrouted production reads** (all listed in conversions.json): `modules/int_saas/server/services/testGenerator.js:29/34`
  (prompts/test-generator-prompt.md), plus publicViewer, ogText, triggerSources and the compliance checks from d.

The 211 crossOwner records are reads that work today: `server/i18n/defaults/nl/index.js` reads the nl
files of every module (196, by design through listTreeDir), and `server/jobs/kbSourceRefresh.liveDatatable.test.js`
reads datatables files (15). They are not conversions.

Per calling file. "silent" means its test file passed although it touched a moved or split path:
| caller | owner | kinds | failing? | sample |
|---|---|---|---|---|
| `modules/apps/server/appStudio/appFontRoles.test.js` | apps | repoPath 1 | yes | readdirSync modules/apps/agent-hub/public/fonts/inter |
| `modules/apps/server/appStudio/automationUsage.savePaths.test.js` | apps | splitDir 73, misrouted 2 | yes | readdirSync modules/apps/server/routes/studioApps |
| `modules/apps/server/appStudio/bindingKeys.matchSearch.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/compat/corpus |
| `modules/apps/server/appStudio/builderTools/schemasCore.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/builderTools/traces |
| `modules/apps/server/appStudio/builderTools/toolNames.mirror.test.js` | apps | repoPath 2 | yes | readFileSync modules/apps/agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json |
| `modules/apps/server/appStudio/compat/corpus.mts` | apps | splitDir 2 | **no (silent)** | readdirSync modules/apps/server/appStudio/compat/corpus |
| `modules/apps/server/appStudio/compat/formulaBaseline.mts` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/compat/corpus |
| `modules/apps/server/appStudio/componentSpecs/keyMarks.js` | apps | splitDir 7 | **no (silent)** | readdirSync modules/apps/server/appStudio/componentSpecs/keys |
| `modules/apps/server/appStudio/componentSpecs/registryDir.js` | apps | splitDir 4 | **no (silent)** | readdirSync modules/apps/server/appStudio/componentSpecs/styleKnobGroups |
| `modules/apps/server/appStudio/componentSpecs/stepRegistry.js` | apps | splitDir 2 | **no (silent)** | readdirSync modules/apps/server/appStudio/componentSpecs/steps |
| `modules/apps/server/appStudio/componentSpecs/stepRegistry.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/componentSpecs/steps |
| `modules/apps/server/appStudio/definitionKeyRegistry.mts` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/definitionKeys |
| `modules/apps/server/appStudio/publicationAudit.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/routes/studioApps |
| `modules/apps/server/appStudio/schemaSince.families.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/compat/corpus |
| `modules/apps/server/appStudio/triggers/triggerKinds.mts` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/triggers/kinds |
| `modules/apps/server/appStudio/validate/columnRightsChecks.test.js` | apps | splitDir 1 | **no (silent)** | readdirSync modules/apps/server/appStudio/compat/corpus |
| `modules/apps/server/routes/studioAppUsage.test.js` | apps | misrouted 1 | **no (silent)** | readFileSync modules/apps/server/index.js |
| `modules/automation/server/automation/builderTools/builderTools.traces.test.js` | automation | splitDir 1 | **no (silent)** | readdirSync modules/automation/server/automation/builderTools/traces |
| `modules/automation/server/automation/builderTools/deriveTitle.test.js` | automation | misrouted 1 | yes | readdirSync modules/automation/server/scripts/builder-briefs |
| `modules/automation/server/automation/builderTools/promptCatalogSync.test.js` | automation | splitDir 1 | **no (silent)** | readdirSync modules/automation/server/automation/builderTools |
| `modules/automation/server/automation/builderTools/triggerAdvice.test.js` | automation | repoPath 1 | yes | readFileSync modules/automation/agent-hub/src/components/automation/Builder/flow/settings/triggerFilters.tsx |
| `modules/automation/server/automation/importers/windmill/goldenFixtures.mjs` | automation | splitDir 1 | **no (silent)** | readdirSync modules/automation/server/automation/importers/windmill/fixtures |
| `modules/automation/server/automation/importers/windmill/mapTrigger.test.js` | automation | repoPath 1 | **no (silent)** | existsSync modules/automation/nextcloud-connector/src/webhookListeners.js |
| `modules/automation/server/automation/tableTemplates.test.js` | automation | repoPath 6 | yes | existsSync modules/automation/agent-hub/public/automation-samples/customer-satisfaction.csv |
| `modules/automation/server/automation/triggerSources/index.js` | automation | splitDir 1, misrouted 1 | **no (silent)** | readdirSync modules/automation/server/automation/triggerSources/declared |
| `modules/automation/server/automation/triggerSources/registry.test.js` | automation | splitDir 2 | **no (silent)** | readdirSync modules/automation/server/automation/triggerSources/declared |
| `modules/automation/server/automation/usageSync.savePaths.test.js` | automation | misrouted 2 | yes | existsSync modules/automation/server/stores/datatableStore.js |
| `modules/automation/server/automation/validate/terminalSteps.test.js` | automation | splitDir 2 | **no (silent)** | readdirSync modules/automation/server/automation/builderTools |
| `modules/automation/server/core/automationRunner/egressCoverage.test.js` | automation | misrouted 1 | yes | readFileSync modules/automation/server/routes/webpagesPreview.js |
| `modules/automation/server/core/forms/formStyleAssist.test.mjs` | automation | repoPath 1 | **no (silent)** | existsSync modules/automation/agent-hub/src/components/automation/Builder/flow/settings/formStyle/formClassList.ts |
| `modules/automation/server/stores/automationStore.requires.test.js` | automation | splitDir 1 | **no (silent)** | readdirSync modules/automation/server/stores/automationStore |
| `modules/cms/server/core/seo/ogText.js` | cms | misrouted 1 | **no (silent)** | readFileSync modules/cms/server/assets/fonts/Fraunces-Variable.woff2 |
| `modules/cms/server/core/seo/seo.test.js` | cms | repoPath 1 | yes | readFileSync modules/cms/agent-hub/src/utils/cmsPublicRouting.ts |
| `modules/compliance/server/compliance/checks/index.js` | compliance | splitDir 10 | **no (silent)** | readdirSync modules/compliance/server/compliance/checks/gdpr |
| `modules/compliance/server/compliance/checks/index.test.js` | compliance | splitDir 3 | **no (silent)** | readdirSync modules/compliance/server/compliance/checks/gdpr |
| `modules/compliance/server/compliance/checks/iso27001/a5-15-access-control.js` | compliance | misrouted 2 | **no (silent)** | readFileSync modules/compliance/server/config/orgRoles.json |
| `modules/compliance/server/compliance/checks/iso27001/a8-24-cryptography.js` | compliance | misrouted 1 | **no (silent)** | readFileSync modules/compliance/server/auth/encryptionPrimitives.js |
| `modules/compliance/server/compliance/checks/iso27001/a8-5-secure-auth.js` | compliance | misrouted 2 | **no (silent)** | readFileSync modules/compliance/server/auth/encryptionUserDek.js |
| `modules/compliance/server/compliance/connectors/index.js` | compliance | splitDir 1 | **no (silent)** | readdirSync modules/compliance/server/compliance/connectors |
| `modules/compliance/server/compliance/connectors/index.test.js` | compliance | splitDir 1 | **no (silent)** | readdirSync modules/compliance/server/compliance/connectors |
| `modules/compliance/server/compliance/countsCache.test.js` | compliance | splitDir 1 | **no (silent)** | readdirSync modules/compliance/server/compliance |
| `modules/compliance/server/compliance/dataPortability/exportRegistry.test.js` | compliance | misrouted 1 | yes | readFileSync modules/compliance/server/index.js |
| `modules/compliance/server/compliance/frameworks.test.js` | compliance | repoPath 1 | **no (silent)** | existsSync modules/compliance/.claude/handoff/compliance/keys/be-registry-runner.json |
| `modules/compliance/server/compliance/registry.test.js` | compliance | repoPath 1, splitDir 20 | **no (silent)** | existsSync modules/compliance/.claude/handoff/compliance/keys |
| `modules/cowork/server/core/aiTaskRunner.autoSend.test.js` | cowork | misrouted 1 | yes | readFileSync modules/cowork/server/integrations/toolFamilies.js |
| `modules/datatables/server/core/dataEngine/dataModel/vocabulary.lockstep.test.js` | datatables | repoPath 2 | yes | readFileSync modules/datatables/agent-hub/src/components/admin/Studio/AppStudio/tables/tablesManagerModel.ts |
| `modules/datatables/server/core/dataEngine/sources/index.test.js` | datatables | splitDir 24 | **no (silent)** | readdirSync modules/datatables/server/auth |
| `modules/datatables/server/routes/datatables.test.js` | datatables | misrouted 1 | yes | readFileSync modules/datatables/server/index.js |
| `modules/datatables/server/stores/datatableStore.test.js` | datatables | splitDir 1, misrouted 1 | yes | readdirSync modules/datatables/server/stores/datatableStore |
| `modules/int_saas/server/services/testGenerator.js` | int_saas | misrouted 1 | **no (silent)** | readFileSync modules/int_saas/server/prompts/test-generator-prompt.md |
| `modules/learning/server/learning/learnMediaPack.test.js` | learning | repoPath 2 | yes | existsSync modules/learning/agent-hub/src/components/onboarding/lessons.ts |
| `modules/meetingNotes/server/core/meetingNotes/summaryHelpers.exports.test.js` | meetingNotes | splitDir 12 | **no (silent)** | readdirSync modules/meetingNotes/server/routes |
| `modules/meetingNotes/server/routes/transcriptions.mount.test.js` | meetingNotes | splitDir 1 | **no (silent)** | readdirSync modules/meetingNotes/server/routes/transcriptions |
| `modules/projects/server/projects/stages/deploy.pg.test.js` | projects | misrouted 1 | **no (silent)** | lstatSync modules/projects/server/data/storage/users/so-deploy-pg |
| `modules/projects/server/routes/projects/packaging.capabilities.test.js` | projects | splitDir 2 | **no (silent)** | readdirSync modules/projects/server/projects/packaging/install |
| `modules/webpages/server/core/webpages/bfElements.drift.test.js` | webpages | repoPath 2, splitDir 24 | yes | readFileSync modules/webpages/agent-hub/src/utils/bfElements.ts |
| `modules/webpages/server/core/webpages/webpageShareReconciler.test.js` | webpages | splitDir 1 | **no (silent)** | readdirSync modules/webpages/server/routes/webpages |
| `modules/webpages/server/routes/ai/webpageChat.prompt.test.js` | webpages | splitDir 1 | **no (silent)** | readdirSync modules/webpages/server/routes/ai/webpageChat |
| `modules/webpages/server/routes/publicViewer.js` | webpages | misrouted 1 | **no (silent)** | readFileSync modules/webpages/server/assets/brand/bee-icon.svg |
| `modules/webpages/server/services/publicBridgeScript.test.js` | webpages | repoPath 1 | yes | existsSync modules/webpages/agent-hub/src/shared/webpage/previewBridges.mjs |
| `modules/webpages/server/shared/webpage/previewDocument.pin.test.mjs` | webpages | repoPath 1 | **no (silent)** | existsSync modules/webpages/agent-hub/src/utils |
| `modules/webpages/server/stores/webpage/managedLock.test.js` | webpages | misrouted 1 | **no (silent)** | lstatSync modules/webpages/server/data/storage/users/wp-lock-159aa824-32c2-4ae7-af66-3f6d4ce12717 |
| `server/agents/memory/singleExtractor.test.js` | core | splitDir 243 | **no (silent)** | readdirSync server/agents |
| `server/auth/accessRegistry.sweep.test.js` | core | misrouted 85 | yes | statSync server/routes/ai/templateChat.js |
| `server/auth/documentedRoutes.test.js` | core | splitDir 1 | **no (silent)** | readdirSync server/auth |
| `server/auth/loginPaths.js` | core | splitDir 245 | **no (silent)** | readdirSync server/agents |
| `server/auth/microsoftScopes.test.js` | core | misrouted 1 | yes | readFileSync server/integrations/msGraphClient.js |
| `server/auth/passwordChangedAt.paths.test.js` | core | splitDir 243 | **no (silent)** | readdirSync server/agents |
| `server/auth/router.test.js` | core | splitDir 244 | **no (silent)** | readdirSync server/agents |
| `server/auth/sessionShape.test.js` | core | splitDir 245 | **no (silent)** | readdirSync server/agents |
| `server/auth/sessionShapes.contract.test.js` | core | splitDir 1 | **no (silent)** | readdirSync server/auth |
| `server/boot/bootMigrations.test.js` | core | splitDir 129, misrouted 1 | yes | readdirSync server/stores |
| `server/boot/featureModules.test.js` | core | splitDir 243 | yes | readdirSync server/agents |
| `server/boot/storeSchemas.test.js` | core | splitDir 12 | **no (silent)** | readdirSync server/stores |
| `server/core/agentRuntime/lending.callSites.test.js` | core | splitDir 243 | **no (silent)** | readdirSync server/agents |
| `server/core/agentRuntime/testAs.wiring.test.js` | core | misrouted 1 | yes | readFileSync server/core/tools/datatableTools.js |
| `server/core/integrations/ncScopeGuard.callSites.test.js` | core | splitDir 243 | **no (silent)** | readdirSync server/agents |
| `server/core/kb/queryLog/searchCallSites.inventory.test.js` | core | misrouted 1 | yes | existsSync server/appStudio/actionExecutor/aiSteps.js |
| `server/core/kb/queryLog/searchCallSites.scan.mts` | core | splitDir 244 | **no (silent)** | readdirSync server/agents |
| `server/i18n/defaults/en.app-api-commands.test.js` | core | splitDir 1 | **no (silent)** | readdirSync server/i18n/defaults/nl |
| `server/i18n/defaults/nl/index.js` | core | crossOwner 196, splitDir 1 | **no (silent)** | readFileSync modules/automation/server/i18n/defaults/nl/automation_approval_expiry.json |
| `server/importPaths.test.js` | core | splitDir 244, misrouted 442 | yes | readdirSync server/agents |
| `server/jobs/collabDocCompaction.test.js` | core | splitDir 1 | **no (silent)** | readdirSync server/jobs |
| `server/jobs/kbSourceRefresh.liveDatatable.test.js` | core | splitDir 1, crossOwner 15 | **no (silent)** | readdirSync modules/datatables/server/stores/datatableStore |
| `server/jobs/lib/advisoryLockKeys.test.js` | core | splitDir 1 | yes | readdirSync server/jobs |
| `server/layering.test.js` | core | splitDir 243, misrouted 358 | **no (silent)** | readdirSync server/agents |
| `server/license/featureMap.notes.test.js` | core | misrouted 1 | yes | readFileSync server/routes/studioAppDatasets.js |
| `server/migrateDb.registration.test.js` | core | splitDir 87, misrouted 2 | yes | readdirSync server/stores |
| `server/migrations/add-nl-kb-usage-translations.test.js` | core | splitDir 1 | **no (silent)** | readdirSync server/i18n/defaults/en |
| `server/migrations/approvals-deliveries-2026-08.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/automation-form-audience-2026-09.integration.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/automation-org-backfill-2026-09.test.js` | core | misrouted 3 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/automation-run-root-2026-08.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/automation-run-token-vault-2026-08.test.js` | core | misrouted 2 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/constraintOscillation.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/datatable-field-ids-2026-09.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/datatable-schema-rename-2026-09.test.js` | core | misrouted 1 | yes | readFileSync server/stores/automationStore/core.js |
| `server/migrations/learning-routine-ids-2026-10.test.js` | core | misrouted 1 | yes | readFileSync server/learning/catalog.generated.js |
| `server/modules/moduleGatedTick.test.js` | core | misrouted 2 | yes | readFileSync server/core/automationRunner/scheduler/ticks.js |
| `server/routes/ai/config/integrations.tls.test.js` | core | misrouted 1 | yes | readFileSync server/integrations/n8nTools.js |
| `server/routes/writeGates.test.js` | core | splitDir 2 | yes | readdirSync server/routes/studioApps |
| `server/stores/knowledgeStore.test.js` | core | splitDir 244 | **no (silent)** | readdirSync server/agents |
| `server/stores/usageStore.studioAppRuns.test.js` | core | misrouted 1 | yes | readFileSync server/routes/studioAppsRun.js |
| `server/stores/user/organizations.configKeys.test.js` | core | splitDir 243 | **no (silent)** | readdirSync server/agents |
| `server/testUtils/pgliteTemplate.js` | core | splitDir 245 | **no (silent)** | readdirSync server/agents |
| `server/testUtils/requireEdges.js` | core | splitDir 244 | **no (silent)** | readdirSync server/agents |
| `server/testUtils/studioRunTables.js` | core | misrouted 3 | **no (silent)** | readFileSync server/stores/studioAppData/schema.js |

## f. The three pilot modules

The lists below hold everything from d, e and the static scan that involves the pilot's files, either as
the caller or as the path. On top of these, each pilot is affected by the whole-tree walkers in e. Those
are listed under each pilot as trace callers, and none of them fails for these pilots alone. They are
conversion batch 3.

- **learning** (46 files) has 5 failing tests and 9 conversions:
  - certificates.test.js:24-25 and visibility.test.js:25-26: stub keys built from __dirname.
  - learnMediaPack.test.js:21/27: repoPath to agent-hub lessons.
  - migrations/learning-routine-ids-2026-10.test.js:48 and modules/moduleGatedTick.test.js:97: core tests
    that read learning source text.
  - `scripts/learn-media-fetch.mjs:28` requires `../server/learning/learnMediaInstall.js`, which also
    fails lint:scripts-types.
  - `agent-hub/docker-entrypoint.d/19-beeflow-runtime-config.sh` and 19 other text files get a
    comment rewritten.
- **support** (87 files) has no failing tests and no conversions of its own. It is affected only through
  the whole-tree walkers: pgliteTemplate (stores/supportStore schema hash), storeSchemas.test.js:127,
  migrateDb.registration.test.js:123/201/236, bootMigrations.test.js:175, loginPaths, sessionShape, router,
  layering and importPaths. It is the cleanest pilot.
- **int_google** (43 files) has no failing tests. It has one latent conversion:
  `modules/int_google/server/routes/integrations/googleWorkspace.test.js:40`, which computes
  `auth/googleOAuthConfig.js` (core) from __dirname. The test still passes, because the resolver
  translates the absolute require. accessRegistry.sweep.test.js:78 and layering.test.js:144 stat its 6
  route files and 12 tool files at server/ paths.

### learning

Failing tests (5):
- `modules/moduleGatedTick.test.js` (cause 3): core test reads core/automationRunner/scheduler/ticks.js and jobs/learningNudge.js text
- `learning/learnMediaPack.test.js` (cause 1): repoPath: agent-hub/src/components/onboarding/lessons.ts from the moved test (learnMediaPack.test.js:21)
- `learning/visibility.test.js` (cause 1): stub keys path.resolve(__dirname, "..", "stores", ...) point into modules/learning/server: the stubs miss, the real store connects to Postgres
- `learning/certificates.test.js` (cause 1): stub keys path.resolve(__dirname, "..", "stores", "configStore") (certificates.test.js:24-25) point into modules/learning/server: real configStore connects to 127.0.0.1:5432
- `migrations/learning-routine-ids-2026-10.test.js` (cause 3): core migration test reads the source text of a moved store/catalogue

Conversions (9):
- `modules/learning/server/learning/certificates.test.js:25` treePath: `const configStorePath = path.resolve(__dirname, '..', 'stores', 'configStore');` (static: server/stores/configStore -> modules/learning/server/stores/configStore (missing); its test file fails)
- `modules/learning/server/learning/learnMediaPack.test.js:27` repoPath: `if (!fs.existsSync(file)) continue;` (trace existsSync: modules/learning/agent-hub/src/components/onboarding/lessons.ts (exists in repo); trace existsSync: modules/learning/agent-hub/src/components/)
- `modules/learning/server/learning/visibility.test.js:25` treePath: `const permissionsPath = path.resolve(__dirname, '..', 'auth', 'permissions');` (static: server/auth/permissions -> modules/learning/server/auth/permissions (missing); its test file fails)
- `modules/learning/server/learning/visibility.test.js:26` treePath: `const entitlementsPath = path.resolve(__dirname, '..', 'core', 'entitlements', 'entitlements');` (static: server/core/entitlements/entitlements -> modules/learning/server/core/entitlements/entitlements (missing); its test file fails)
- `server/auth/accessRegistry.sweep.test.js:78` treePath: `return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;` (trace statSync: server/routes/ai/templateChat.js (exists in templates); trace statSync: server/routes/ai/notebookChat.js (exists in notebooks); trace statSync: )
- `server/importPaths.test.js:146` treePath: `try { if (fs.statSync(base + ext).isFile()) return true; } catch (_) { }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)
- `server/layering.test.js:144` treePath: `try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)
- `server/migrations/learning-routine-ids-2026-10.test.js:48` sourceText: `const catalog = fs.readFileSync(path.join(__dirname, '..', 'learning', 'catalog.generated.js'), 'utf8');` (static: server/learning/catalog.generated.js -> server/learning/catalog.generated.js (missing); its test file fails; trace readFileSync: server/learning/catalog)
- `server/modules/moduleGatedTick.test.js:97` sourceText: `const nudge = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'learningNudge.js'), 'utf8');` (static: server/jobs/learningNudge.js -> server/jobs/learningNudge.js (missing); its test file fails)

Trace callers that touch learning files (20, 43 records):
- `server/testUtils/pgliteTemplate.js:79` splitDir: readdirSync server/learning
- `server/testUtils/requireEdges.js:30` splitDir: readdirSync server/learning
- `server/auth/loginPaths.js:164` splitDir: readdirSync server/learning
- `server/auth/sessionShape.test.js:40` splitDir: readdirSync server/learning
- `server/boot/featureModules.test.js:49` splitDir: readdirSync server/learning
- `server/stores/user/organizations.configKeys.test.js:46` splitDir: readdirSync server/learning
- `server/core/kb/queryLog/searchCallSites.scan.mts:20` splitDir: readdirSync server/learning
- `server/auth/accessRegistry.sweep.test.js:78` misrouted: statSync server/routes/ai/learningAdmin.js; statSync server/routes/ai/learning.js; statSync server/routes/verifyCertificate.js
- `server/layering.test.js:129` splitDir: readdirSync server/learning
- `server/layering.test.js:144` misrouted: statSync server/jobs/learningNudge.js; statSync server/learning/learnMediaSync.js; statSync server/auth/certificateToken.js
- `server/importPaths.test.js:129` splitDir: readdirSync server/learning
- `server/importPaths.test.js:146` misrouted: statSync server/routes/ai/learning.js; statSync server/routes/ai/learningAdmin.js; statSync server/stores/learningContentStore.js
- `server/stores/knowledgeStore.test.js:59` splitDir: readdirSync server/learning
- `server/agents/memory/singleExtractor.test.js:33` splitDir: readdirSync server/learning
- `modules/learning/server/learning/learnMediaPack.test.js:27` repoPath: existsSync modules/learning/agent-hub/src/components/onboarding/lessons.ts; existsSync modules/learning/agent-hub/src/components/onboarding/generated/lessons.js
- `server/auth/router.test.js:89` splitDir: readdirSync server/learning
- `server/auth/passwordChangedAt.paths.test.js:137` splitDir: readdirSync server/learning
- `server/core/agentRuntime/lending.callSites.test.js:38` splitDir: readdirSync server/learning
- `server/migrations/learning-routine-ids-2026-10.test.js:48` misrouted: readFileSync server/learning/catalog.generated.js
- `server/core/integrations/ncScopeGuard.callSites.test.js:78` splitDir: readdirSync server/learning

### support

Failing tests (0):

Conversions (3):
- `server/auth/accessRegistry.sweep.test.js:78` treePath: `return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;` (trace statSync: server/routes/ai/templateChat.js (exists in templates); trace statSync: server/routes/ai/notebookChat.js (exists in notebooks); trace statSync: )
- `server/importPaths.test.js:146` treePath: `try { if (fs.statSync(base + ext).isFile()) return true; } catch (_) { }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)
- `server/layering.test.js:144` treePath: `try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)

Trace callers that touch support files (23, 104 records):
- `server/testUtils/pgliteTemplate.js:79` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/testUtils/requireEdges.js:30` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/auth/loginPaths.js:164` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/auth/sessionShape.test.js:40` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/boot/featureModules.test.js:49` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/stores/user/organizations.configKeys.test.js:46` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/core/kb/queryLog/searchCallSites.scan.mts:20` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/boot/storeSchemas.test.js:127` splitDir: readdirSync server/stores/supportStore
- `server/auth/accessRegistry.sweep.test.js:78` misrouted: statSync server/routes/support.js; statSync server/routes/supportInbox.js
- `server/layering.test.js:129` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/layering.test.js:144` misrouted: statSync server/services/supportInboxSyncEngine.js; statSync server/services/supportInboxScanEngine.js; statSync server/services/supportSlaEnforcer.js
- `server/importPaths.test.js:129` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/importPaths.test.js:146` misrouted: statSync server/services/supportInboxSyncEngine.js; statSync server/services/supportInboxScanEngine.js; statSync server/services/supportSlaEnforcer.js
- `server/migrateDb.registration.test.js:123` splitDir: readdirSync server/stores/supportStore
- `server/migrateDb.registration.test.js:201` splitDir: readdirSync server/stores/supportStore
- `server/migrateDb.registration.test.js:236` splitDir: readdirSync server/stores/supportStore; readdirSync server/core/support
- `server/stores/knowledgeStore.test.js:59` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/agents/memory/singleExtractor.test.js:33` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/auth/router.test.js:89` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/boot/bootMigrations.test.js:175` splitDir: readdirSync server/stores/supportStore; readdirSync server/core/support; readdirSync server/routes/support
- `server/auth/passwordChangedAt.paths.test.js:137` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/core/agentRuntime/lending.callSites.test.js:38` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore
- `server/core/integrations/ncScopeGuard.callSites.test.js:78` splitDir: readdirSync server/core/support; readdirSync server/routes/support; readdirSync server/stores/supportStore

### int_google

Failing tests (0):

Conversions (4):
- `modules/int_google/server/routes/integrations/googleWorkspace.test.js:40` treePath: `const googleOAuthConfig = require(path.resolve(__dirname, '../../auth/googleOAuthConfig.js'));` (static: server/auth/googleOAuthConfig.js -> modules/int_google/server/auth/googleOAuthConfig.js (missing))
- `server/auth/accessRegistry.sweep.test.js:78` treePath: `return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;` (trace statSync: server/routes/ai/templateChat.js (exists in templates); trace statSync: server/routes/ai/notebookChat.js (exists in notebooks); trace statSync: )
- `server/importPaths.test.js:146` treePath: `try { if (fs.statSync(base + ext).isFile()) return true; } catch (_) { }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)
- `server/layering.test.js:144` treePath: `try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }` (trace statSync: server/services/trialService.js (exists in billing_stripe); trace statSync: server/core/customIntegrations/featureFlag.js (exists in custom_inte)

Trace callers that touch int_google files (19, 56 records):
- `server/testUtils/pgliteTemplate.js:79` splitDir: readdirSync server/integrations/gmail
- `server/testUtils/requireEdges.js:30` splitDir: readdirSync server/integrations/gmail
- `server/auth/loginPaths.js:164` splitDir: readdirSync server/integrations/gmail
- `server/auth/sessionShape.test.js:40` splitDir: readdirSync server/integrations/gmail
- `server/boot/featureModules.test.js:49` splitDir: readdirSync server/integrations/gmail
- `server/stores/user/organizations.configKeys.test.js:46` splitDir: readdirSync server/integrations/gmail
- `server/core/kb/queryLog/searchCallSites.scan.mts:20` splitDir: readdirSync server/integrations/gmail
- `server/auth/accessRegistry.sweep.test.js:78` misrouted: statSync server/routes/integrations/googleWorkspace.js; statSync server/routes/integrations/googleDrive.js; statSync server/routes/integrations/gmail.js
- `server/layering.test.js:129` splitDir: readdirSync server/integrations/gmail
- `server/layering.test.js:144` misrouted: statSync server/routes/integrations/googleWorkspace.js; statSync server/routes/integrations/googleDrive.js; statSync server/routes/integrations/gmail.js
- `server/importPaths.test.js:129` splitDir: readdirSync server/integrations/gmail
- `server/importPaths.test.js:146` misrouted: statSync server/integrations/gmailTools.js; statSync server/routes/integrations/googleWorkspace.js; statSync server/routes/integrations/googleDrive.js
- `server/migrateDb.registration.test.js:236` splitDir: readdirSync server/integrations/gmail
- `server/stores/knowledgeStore.test.js:59` splitDir: readdirSync server/integrations/gmail
- `server/agents/memory/singleExtractor.test.js:33` splitDir: readdirSync server/integrations/gmail
- `server/auth/router.test.js:89` splitDir: readdirSync server/integrations/gmail
- `server/auth/passwordChangedAt.paths.test.js:137` splitDir: readdirSync server/integrations/gmail
- `server/core/agentRuntime/lending.callSites.test.js:38` splitDir: readdirSync server/integrations/gmail
- `server/core/integrations/ncScopeGuard.callSites.test.js:78` splitDir: readdirSync server/integrations/gmail

## conversions.json

643 entries, as `{ file, line, kind, expression, module, note }`:

| kind | entries |
|---|---:|
| listTreeDir | 232 |
| treePath | 338 |
| repoPath | 39 |
| sourceText | 31 |
| worker | 1 |
| other | 2 |

How to read the list:
- 58 entries are production code. Their note starts with "production code". The rest are tests and test kits.
- 54 entries sit in a test file that failed in d. The others are latent: their test passes today. One
  reason is that the resolver translates an absolute `require(path.join(SERVER, 'stores/x'))`. Another is
  that the test guards with existsSync. A third is that the target does not matter for the assertion.
- The split directories `stores/`, `jobs/`, `i18n/defaults/en|nl`, `migrations/` and `routes/` make up most
  of listTreeDir.
- A hand-computed **server root** (`const SERVER = path.resolve(__dirname, '..')`) is not listed itself.
  Only its uses are listed, because the base becomes `treePath()` (or `moduleRoots.coreRoot`) once its
  uses are converted.
- sourceText is only counted where the same line reads the file. Many treePath entries in tests are
  really source-text reads through a constant: the note shows the target.

## Recommended conversion batches (each behaviour-neutral, before any real move)

1. **Production code first.** These are behaviour changes waiting to happen, and none of them has a
   failing test that would catch every case.
   - `codeSandboxProcess.js:48/85`: keep the resolver preload in the sandbox child's env or execArgv.
   - `publicViewer.js:427-428`, `ogText.js:27/39`, `testGenerator.js:29/34`, `triggerSources/index.js:99/102`
     and the four compliance `checks/iso27001/*` files: convert to `treePath()`.
   - `auth/loginPaths.js:164`, `core/kb/queryLog/searchCallSites.scan.mts:20` and the module-internal
     directory readers in apps, compliance, automation and datatables: convert to `listTreeDir()` or a
     walk over `roots()`.
   - `appStudioRenderFiles.mts:34`: convert to `repoPath()`.
2. **Test kits** in server/testUtils. One file fixes many tests:
   - `studioRunTables.js:27` (13 tests): `treePath()`.
   - `pgliteTemplate.js` sourceHash: walk every root.
   - `requireEdges.js` productionFiles: walk every root.
3. **Whole-tree guard tests** (cause 5): importPaths, layering, accessRegistry.sweep, bootMigrations,
   migrateDb.registration, featureModules, writeGates, searchCallSites.inventory, chatSignals.callers,
   sessionShape, router, passwordChangedAt.paths, knowledgeStore, organizations.configKeys,
   singleExtractor, lending/ncScopeGuard callSites and storeSchemas. Each one becomes a walk over
   `roots()` (or a shared `walkServerTree()` kit in testUtils). They must turn red when a root is missing,
   not quietly measure less.
4. **Source-text tests** (cause 3, 22 files, plus the latent ones in conversions.json): convert to `treePath()`.
   The 10 migration tests reading `stores/automationStore/core.js` share one helper.
5. **Tests that compute repository paths** (agent-hub, nextcloud-connector, public assets): convert to
   `repoPath()`. There are 39 entries.
6. **Stub keys computed from __dirname** (certificates, visibility, rankApps, cmsSitesAdmin): use
   `treePath()` for the key, or `require.resolve()` of the specifier.
7. **Repository tooling still pending**: gen-step-kinds, gen-app-catalog, gen-shared-mirror (and the
   manifest entry `server/shared/appDefinition`, which must be split per file), file-budget, checkjs-ratchet,
   gen-row-types, check-legal-catalogue, check-compat-corpus, learn-media-fetch, stage-server-context.sh,
   generate-sbom.sh, release-notes/draft.js, typecheck.mjs plus rootDirs, and every count ratchet over server.
