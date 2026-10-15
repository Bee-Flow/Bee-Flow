# Structural plan: 5xx responses, server import cycle, long functions

Base: `ccr-28820270-xkvwp8` @ `44072b7db`. Measured 2026-10-15 (read-only analysis).

| Gate | Command | Measured | Budget file |
|---|---|---|---|
| status-5xx | `node scripts/count-ratchet.mjs status-5xx server` | **118** in 62 files | `server/.status-5xx-ratchet.json` (118) |
| SCC | `node scripts/scc-ratchet.mjs server` | **552** of 3,400 files | `server/.scc-ratchet.json` (552) |
| long-function server | `node scripts/count-ratchet.mjs long-function server` | **132** | `server/.long-function-ratchet.json` (132) |
| long-function agent-hub | `node scripts/count-ratchet.mjs long-function agent-hub` | **269** | `agent-hub/.long-function-ratchet.json` (270, 1 slack) |

## 0. Rules for every package (read first)

- **One worktree per package**, branched from the base:
  `git -C $REPO worktree add $WT/<ID> -b refactor/<ID> 44072b7db`.
  Only touch the files listed for the package. If a fix needs a file that belongs to another package, stop and report it.
- **Do NOT run `--update` and do not commit any budget JSON** (`.*-ratchet.json`, `.file-budget.json`,
  `.layering-ratchet.json`). Every one has `count`/`size` plus a `_generated` date, so two branches lowering it
  conflict. A gate passes when you are under budget (it prints ✅). The integrator lowers all budgets once at the end (§5).
- Gates that bite while you refactor:
  - `lint:file-budget` (`scripts/file-budget.mjs`): source files are limited to **400 lines**, and a file already over that
    (listed in `<pkg>/.file-budget.json`) **may not grow past its ceiling**. Adding an `HttpError` import to a file at
    its ceiling fails, so remove a line elsewhere (see commit `e500fa5ee`). A new extracted file has to stay ≤ 400 lines.
  - `lint:dutch-comment-ratchet` counts *files* with a Dutch comment. Copying a Dutch comment into a new file raises the
    count, so translate any comment you move into English.
  - agent-hub `lint:ts-ratchet`: new files must be `.ts`/`.tsx`, never `.js`/`.jsx`. Type the props explicitly:
    noImplicitAny on extracted React code is the usual failure. Also `lint:import-zones-ratchet` (`hooks/` and `api/`
    never import `components/` or `pages/`) and `npm run lint:dead` (knip: every new file must be imported).
  - server `lint:checkjs-ratchet`: a moved function's new file keeps `// @typecheck` if the source had it.
  - server `layering.test.js`: `boot/` is the composition root and may require anything. `stores/` (platform) may not
    gain a new require into `core/`, `jobs/`, `projects/` and so on.
- Before you commit: `npm run check:fast`, plus the tests next to every touched file (server: `node --test <file>`;
  agent-hub: `cd agent-hub && npx vitest related --run <files> && npm run typecheck && npx eslint <files>`).
- Commit message: conventional (`refactor(routes): …`), with the attribution trailer. Do not push unless asked.

## 1. Hand-written 5xx → throw / `next(err)` (118)

**Rule** (`count-ratchet.mjs` `status-5xx`): counts `/\.status\(\s*5\d\d\s*\)/` in non-test server code.
**Sanctioned replacement** (CLAUDE.md "Errors in routes"): throw, or call `next(err)`, and let
`server/core/http/terminalErrorHandler.js` (mounted last in `index.js`) answer. A message the client may see goes in an
`HttpError(status, code, message, details?)` from `server/core/http/errors.js` (re-exports `shared/httpErrors.js`, which also has
`unavailable(code, msg)` for 503). Express 5 forwards a rejected async handler, so a try/catch that only logs and answers
500 is redundant. eslint (`server/eslint.config.js`) already forbids echoing `err.message` in a 5xx.

Reference conversions: `git show dddabb802` (auth routes), `f64f2d44c` (transcriptions: whole try/catch removed),
`server/routes/dictate.js` (`throw new HttpError(500, 'dictation_failed', 'Could not transcribe that recording.')`).
Test style: `server/routes/transcriptions/transcriptions.validation.test.js` ("lekt zijn tekst niet meer") and
`server/routes/supportInbox.errors.test.js` `assertGeneric500`: serve the router through `testUtils/routeHarness.js`, which mounts the
terminal handler, then assert `status === 500`, `body.error === 'Internal server error'`, `body.correlationId` is set, and
no leaked text.

### Recipes

**R1. Generic catch, log and 500** (most of studioApps/*, support, transcriptions):
```js
// before
router.get('/', requireAuth, async (req, res) => {
    try { …; res.json({ apps }); }
    catch (err) { rethrowClientError(err); log.error('[StudioApps] List failed:', err); res.status(500).json({ error: 'Failed to list apps' }); }
});
// after: no try/catch at all
router.get('/', requireAuth, async (req, res) => { …; res.json({ apps }); });
```
**R2. A deliberate 5xx with a meaning for the client** (an upstream 502, a "not configured" 503):
`throw new HttpError(503, 'github_unavailable', 'GitHub statistics are unavailable right now.')`. If the route set
headers first (`res.set('Retry-After','1')`), keep that line before the throw: the terminal handler does not clear headers.
**R3. Middleware gate**: `return next(new HttpError(503, 'entitlement_unavailable', 'entitlement_unavailable'))`.
Keep **message = the existing token** wherever a client branches on `body.error` (see the risks below).
**R4. Stream error callback** (`stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); })`):
add `next` to the handler signature and use `stream.on('error', next)`. The terminal handler already does
`if (res.headersSent) return next(err)`, and Express then destroys the socket. Never `throw` inside an event callback:
nothing catches it there.
**R5. Shared "send error" helper** (`sendStoreError` in studioDocuments.js, the one at the end of studioAppPublic.js,
webpagesPreviewTables.js, studio/appDataContext.js): keep the 4xx branch and replace the final
`log.error + res.status(500)` with `throw err` (or `throw new HttpError(500, code, fallback)` when the sentence matters to the UI).

### Behaviour that changes (check each one, and adjust tests on purpose)
| Aspect | Before | After |
|---|---|---|
| body, generic 500 | `{ error: 'Failed to list apps' }` | `{ error: 'Internal server error', correlationId }` |
| body, HttpError | `{ error: '<token or sentence>', …extra top-level fields }` | `{ error: message, code, details?, correlationId }`. Extra top-level fields (`retry_after`, `detail`, `messageId`, `event_id`) **move under `details`** or disappear |
| logging | route's own `log.error('[Tag] …', err)` | terminal handler `log.error('[HTTP] 500 GET /path correlationId=…', err)`. Every 5xx is logged at **error**, including an exposed 503 (a burst of gate 503s used to be `warn`) |
| status | same | same; a non-numeric status becomes 500 |
| headers | as set | headers set before the throw survive. Response is always JSON (bad for HTML pages) |
| headersSent | hand-guarded | the handler calls `next(err)`, so Express destroys the socket |

Clients that read these fields: `mobile/src/core/api/client.ts` (`code ?? error`, `entitlement_unavailable`),
`agent-hub/.../AutomationPicker.jsx` (`code`, else `error`, `tier_unavailable`), `agent-hub/.../MarketplaceTab.jsx`
(`status === 502 || body.error === 'hub_unavailable'`, plus the hub detail), `agent-hub/src/api/queries/serverMcp.ts`
(`mcp_registry_unavailable`), `MachineryPage.jsx` (`not_provisioned`), `mobile/.../automations/api/lifecycle.ts`
(`usage_unavailable`), `compliance/data/registers.js` (`notify_failed`). Server tests that assert a token:
`auth/permissions.failClosed.test.js`, `auth/permissions.characterisation.test.js` (`auth_unavailable`),
`routes/projects/notebookGate.test.js` and `collab.notebookGate.test.js` (`entitlement_unavailable`),
`routes/studio/attention.test.js` and `aiRoute.test.js` (`tier_unavailable`), `routes/publicGithubStats.validation.test.js`,
`routes/compliance/machinery.test.js`, `modules/packageLoader.gates.test.js`. Before you change a body, grep agent-hub/ and
mobile/ for the token.

### Work packages (disjoint files; the count is the number of occurrences)
| ID | Files (server/) | n | Risk |
|---|---|---|---|
| **5XX-1** | routes/studioApps/crud.js (9), routes/studioApps/appImport.js (1) | 10 | low: R1 |
| **5XX-2** | routes/studioApps/publish.js (5), templates.js (5), runtime.js (4), publicPages.js (3) | 17 | low: R1 (two are `if (!x) return 500`, which becomes `throw new Error(...)`) |
| **5XX-3** | routes/studioAppFiles.js (4), studioAppPublic.js (3), studioAppsRun.js (1), studioAppBrowse.js (1), studio/appDataContext.js (1), studioDocuments.js (1), webpagesPreviewTables.js (1) | 12 | med: R4 streams, R5 helpers, public app pages |
| **5XX-4** | routes/automation/events.js (4), approvals.js (2), catalog.js (1), crud.js (1), formPublic/session.js (1); automation/formQueue.js (1) | 10 | med: webhook `.end()` (GitHub retries on any 5xx, so a JSON body is fine), R4, the public form "busy" 503 → R2 |
| **5XX-5** | routes/agents/testsGuards.js (4), tests.js (1), testsRun.js (1), chat.js (1); routes/ai/voice.js (1), ai/config/integrations.js (1, echoes `err.message` in `detail`), ai/directChat/swarmTurn.js (1); routes/transcriptions/reprocess.js (2), audio.js (1), upload.js (1); routes/dictate.js (1); routes/notebooksGenerate.js (2) | 17 | med: testsGuards carries `code`. voice.js answers `{enabled:false}` with a 500, so check the UI |
| **5XX-6** | routes/support/inboxSettings.js (1), inboxThreads.js (1), threads.js (1); routes/compliance/incidents.js (2), machinery.js (1); routes/stripe/checkout.js (3), webhook.js (1); routes/projects.js (1), projects/resources.js (1); routes/datatables/grade.js (1); routes/integrations/gamma.js (1) | 14 | med: stripe webhook 500 must stay 5xx (Stripe retries), and `event_id` moves to details |
| **5XX-7** | routes/admin/modules.js (6), routes/releaseNotes.js (3), routes/publicGithubStats.js (2), routes/cmsAnalytics.js (2), routes/maintenance.js (1) | 14 | med: `hub_unavailable` plus `detail`, read by MarketplaceTab |
| **5XX-8** gates | auth/opaqueRoutes.js (2), microsoftSession.js (1), permissionsRequireAuth.js (1), connectorJwt.js (1), connectorBootstrap.js (1), connector/bootstrapBranches.js (1); core/entitlements/entitlements.js (2), betaFeatures.js (2); license/middleware.js (2); boot/featureGate.js (1); modules/packageActivation.js (1) | 15 | **high**: fail-closed auth and entitlement gates, a wire contract with mobile retry logic, error-level log noise under degradation. R3 with message = token. Do this one last, by itself |
| **5XX-9** HTML (optional) | routes/publicViewer.js (4), routes/publicRender.js (2), routes/support/inboxOAuth.js (2), routes/support/satisfaction.js (1) | 9 | browser HTML/XML pages (nonce'd 404 page, OAuth popup close page, CSAT, a deliberate 503 sitemap). The JSON terminal handler would break them. Recommend **leaving them** as the floor, or a deliberate HTML error helper in core/http. Not part of waves 1 and 2 |

Sum: 10+17+12+10+17+14+14+15+9 = 118. Doing 5XX-1…7 gives **118 → 24**, and 5XX-8 brings it to **9**.

Verification per package:
```bash
cd <worktree>
node scripts/count-ratchet.mjs status-5xx server --list | grep -E '<your files>'   # expect nothing left
node scripts/count-ratchet.mjs status-5xx server                                  # ✅ under 118
cd server && npx eslint <files> && node --test <the *.test.js next to each file>
# add or adjust one routeHarness test per file: generic 500 => { error:'Internal server error', correlationId }; HttpError => status+code
cd .. && npm run lint:file-budget && npm run check:fast
```

## 2. Server import cycle (552 → ~60)

How it was found: a throwaway script that reuses `importsOf`/`stronglyConnected` from `scripts/scc-ratchet.mjs` (the same graph,
lazy requires included) and searches greedily for the edge cut that shrinks the largest SCC. The SCC has 1,728 internal edges,
774 of them lazy. The hubs by in-degree are `stores/configStore.js` (115), `stores/userStore.js` (78),
`stores/automationStore.js` (43), `stores/datatableStore.js` (33) and `auth/permissions.js` (29). The hubs are not the
problem: they are pulled in by a few **up-calls from the storage layer into features** (lazy requires). Cut those and the
hubs become sinks.

**Important:** the effect is *conjunctive*. Each cut on its own moves the SCC only a little (552 → 514 to 552); all five
together give **60** (simulated). So no single PR will show the ratchet moving. Each package proves that *its* edge is
gone and that the SCC did not grow, and the drop shows after the last merge.

| ID | Edge(s) to remove | Why it closes a loop | Fix (recipe) | Files | Risk |
|---|---|---|---|---|---|
| **SCC-A** | `stores/datatableStore/liveChanges.js` → `jobs/kbSourceRefresh.js` and → `core/webpages/webpageShareReconciler.js` (both lazy defaults in `notifyDatatableChanged`) | datatableStore → liveChanges → jobs/core → kb/sources and webpages → datatableStore | **Port/listener inversion**: liveChanges keeps a list `onDatatableChanged(listener)`, with each listener caught separately as today. Register both listeners in a new `jobs/`- or `integrations/`-side registering module loaded by `boot/featureRegistrations.js` (the same pattern as `jobs/runnerPorts.js` and `core/automationRunner/featurePorts.js`). Keep the `arm`/`reSnapshot` injection params for tests. Also drop the `= require('../core/kb/sources')` default in `jobs/kbSourceRefresh.refreshOne` only if it is needed (it is not, once liveChanges is cut) | liveChanges.js, boot/featureRegistrations.js, new registering file, kbSourceRefresh.liveDatatable.test.js | med: a missing registration means a deleted row stays on a public page. Add a test that loads featureRegistrations and asserts both listeners are present |
| **SCC-B** | `stores/user/users.js` → `core/kb/notebookCascade.js` (in `deleteUser`) and `stores/user/projectErasure.js` → `projects/projectTeardown.js` (`opts.teardown ‖ require`) | userStore → users → kb/projects → … → userStore | **Erasure port in platform**: new `stores/user/erasurePorts.js` (`registerErasurePorts({ notebooks: { deleteAllForUser }, projects: { makeTeardown } })`, and `erasurePort(name)` **throws** when unregistered, *fail-closed* for GDPR). Register from a feature-side module loaded by `boot/featureRegistrations.js`. Scripts that delete users (`scripts/deleteOrgs.js`, `scripts/cleanupAzureDuplicates.js`, `reset-nc.js`) must require that registering module | stores/user/users.js, stores/user/projectErasure.js, new erasurePorts.js, new registering module, boot/featureRegistrations.js, the 3 scripts, users.*.test.js and projectErasure.test.js (register a fake) | **high**: account erasure path. Do it as a pure move, with no change to the order of steps |
| **SCC-C** | `integrations/automationEvolutionTools.js` → `automation/evolution.js` (or `core/integrations/integrationTools.js` GROUP_DEPS → automationEvolutionTools) | integrationTools → evolution tools → evolution → builderTools → aiStep → aiStepAgent → integrationTools | **Extract a leaf**: move the `AUTOMATION_EVOLUTION_TOOLS` schema array (data) into `integrations/automationEvolutionToolDefs.js` with no requires. Point `GROUP_DEPS.automationEvolutionTools` (`integrationTools.js:131`, used by `integrationToolFeatures.js:137`) at it. Execution already goes through `integrations/toolFamilies.js`. Alternative cut with the same result: evolution.js `defaultDeps().applyToolCall` | integrationTools.js, integrationToolFeatures.js, automationEvolutionTools.js, new defs file, automation/toolRegistry.js (if it reads the array) | low |
| **SCC-D** | `core/kb/extractSummary.js` → `core/agentRuntime/index.js` (`require('../agentRuntime').resolveAgentModel`) | agentRuntime → chatStream → knowledgeSearch → localKBIngest → embeddingMigration → kb/sources → extractSummary | **Bypass the barrel**: `require('../agentRuntime/modelResolver').resolveAgentModel` (the same function; agentRuntime/index re-exports it) | core/kb/extractSummary.js | **very low** |
| **SCC-E** | `modules/index.js` → `modules/packageLoader.js` (`packageLoader()` in `importModule`/`removeModule`) | packageLoader → index (`runtime().isModuleActive`) and → hostApi → license, entitlements, permissions | Move `importModule`/`removeModule` (the orchestration that calls activate/deactivate) into a new `modules/moduleLifecycle.js` above both, and repoint its only caller, `routes/admin/modules.js:337,348` (that file is also in 5XX-7, so SCC-E runs after it). Alternative: cut `packageLoader → hostApi` by injecting `hostApiFactory` (simulates to 44) | modules/index.js, new moduleLifecycle.js, routes/admin/modules.js | med: module activation gating. Tests: modules/packageLoader*.test.js |

Not needed (simulated as redundant once A–E land): the `configStore ↔ userStore` and `configStore ↔ integrationConnectionStore` lazy
edges. A cheap follow-up is configStore `_auditCredentialChange` → `require('./user/audit')` instead of the `./userStore` facade.
After A–E the remaining SCC (~60) is the user, license and entitlements core: `stores/user/{users,organizations,billingLifecycle,subscriptions}`,
`license/*`, `core/entitlements/*`, `modules/{index,entitlementRefresh,subjects,remoteCatalog,hubClient}`, `auth/{permissions,orgScope,…Escrow}`,
`services/{stripeService,planEntitlements,trialService}`. The next step there is the same erasure/seat-sync port for `users.js` →
`services/stripeService` and `license`.

Simulated (cumulative, in merge order): A 534 → A+B **127** → +D 116 → +C 116 → +E **60**. Merge order: D, C (trivial) → A → E → B.

Verification per SCC package:
```bash
node scripts/scc-ratchet.mjs server                 # must not exceed 552 (➖ or ✅)
grep -n "<removed require>" <file>                  # the edge is gone (comments do not count)
node --test server/layering.test.js                 # no new upward pair; ideally stores->jobs/core/projects counts drop
node --test <tests next to the touched files>; npm run check:fast
```
Simulator for a package that wants to see the combined effect (save it in your own scratch dir and run it from the repo root):
```js
// node sim.mjs 'from.js>to.js' ...   prints the SCC size of server with those edges removed
import fs from 'node:fs'; import path from 'node:path';
import { importsOf, stronglyConnected } from './scripts/scc-ratchet.mjs';
const dir = path.resolve('server'), EX = ['.ts','.tsx','.js','.jsx','.mjs','.cjs'], SKIP = new Set(['node_modules','dist','build','coverage','.vite','__tests__','__mocks__']);
const list = []; (function w(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { if (e.name.startsWith('.')) continue; const f = path.join(d,e.name);
  if (e.isDirectory()) { if (!SKIP.has(e.name)) w(f); } else if (/\.(?:[cm]?js|jsx|ts|tsx)$/.test(e.name) && !/\.(?:test|spec|testkit)\.|\.d\.[cm]?ts$/.test(e.name)) list.push(f); } })(dir);
const files = new Set(list), rel = (f) => path.relative(dir, f);
const res = (from, s) => { if (!s.startsWith('.')) return null; const b = path.resolve(path.dirname(from), s.replace(/[?#].*$/,'')); return [b, ...EX.map(e=>b+e), ...EX.map(e=>path.join(b,'index'+e))].find(x=>files.has(x)); };
const cut = new Set(process.argv.slice(2)); const g = new Map();
for (const f of list) g.set(rel(f), new Set(importsOf(fs.readFileSync(f,'utf8')).map(s=>res(f,s)).filter(t=>t && t!==f).map(rel).filter(t=>!cut.has(rel(f)+'>'+t))));
console.log(Math.max(...stronglyConnected(g).map(c=>c.length)));
```

## 3. Functions over 200 lines (server 132, agent-hub 269)

The metric is a brace-depth scanner. A long function nested in a long function counts twice (`PageRenderer` and
`renderElement`). "T*n*" = *n* colocated `*.test.*` files (same dir or `__tests__/`). "--" = none.

**Recipe (behaviour-preserving extract-function):**
1. Characterise first when the "T" column is `--`: one test that pins the current output (route response, return value,
   or rendered DOM) **before** you move code.
2. Server: lift a phase (validate → load → act → respond, or one `case` of a tool `switch`) into a named top-level
   function in the same file, passing what it reads as parameters and returning what it writes. No reordering of awaits or
   side effects. A **giant `switch (action)`** in `execute*Tool` becomes a `const HANDLERS = { action: async (args, ctx) => … }`
   map, one function per case, and the default branch stays identical. **`make*Store`/`create*` factories** (closures over
   `db`/deps) split into sub-factories `makeReads(ctx)`/`makeWrites(ctx)` merged with `{ ...a, ...b }`. Keep the exported
   object's key set identical (assert it in a test). If the file is at its file-budget ceiling or over 400 lines, move the
   extracted helpers into a sibling file (≤ 400 lines).
3. React: extract presentational subcomponents (JSX sections + their props) and custom hooks (state + effects + handlers)
   into new `.tsx`/`.ts` files. Keep **hook call order and effect dependency arrays identical**, never wrap hooks in conditions, and keep
   `data-testid`/aria and i18n keys unchanged. Keep `style={{}}` and unkeyed strings as they are (other ratchets count them).
4. Verify: `node scripts/count-ratchet.mjs long-function <pkg> --list | grep <file>` drops by the expected amount, and the tests
   next to the file pass unchanged.

### Top 30, server
| # | Lines | Tests | Function | Package |
|---|---|---|---|---|
| 1 | 461 | T1 | routes/transcriptions/upload.js:123 `POST /` | LF-S7 (wave 2, after 5XX-5) |
| 2 | 454 | T4 | integrations/workspaceTools.js:166 `executeWorkspaceTool` | LF-S1 |
| 3 | 437 | T1 | stores/agent/initSchema.js:25 `_doInit` | LF-S3 |
| 4 | 429 | -- | stores/solutionStage/deployments.js:101 `makeDeploymentsStore` | LF-S2 |
| 5 | 414 | T2 | routes/ai/cmsBuilder.js:114 `POST /stream` | LF-S4 ⚠ SSE |
| 6 | 412 | T1 | projects/projectFiles.js:161 `makeProjectFiles` | LF-S6 |
| 7 | 409 | T1 | automation/formQueue.js:82 `createFormQueue` | LF-S7 (after 5XX-4) |
| 8 | 403 | T1 | stores/memoryQueries.js:60 `createMemoryQueries` | LF-S2 |
| 9 | 394 | -- | appStudio/validate/actions.js:641 `validateStep` | LF-S5 ⚠ security validation, untested |
| 10 | 394 | T1 | integrations/youtrackTools.js:321 `executeYouTrackTool` | LF-S1 |
| 11 | 393 | T2 | stores/lib/pgAppEngine.js:318 `createPgAppEngine` | LF-S8 ⚠ SQL engine (tenant isolation) |
| 12 | 392 | T1 | projects/chatAssistant.js:363 `makeChatAssistant` | LF-S6 |
| 13 | 389 | T3 | auth/connectorJwt.js:320 `connectorJwtMiddleware` | LF-S7 ⚠ auth (after 5XX-8) |
| 14 | 387 | T1 | stores/projectAiParticipationStore.js:191 `make…Store` | LF-S2 |
| 15 | 380 | T2 | automation/builderTools/addSteps.js:202 `applyAddSteps` | LF-S5 |
| 16 | 379 | T4 | appStudio/validate.js:295 `validateAppDefinition` | LF-S5 |
| 17 | 378 | T3 | routes/ai/templateChat.js:112 `POST /chat/template/stream` | LF-S4 ⚠ SSE |
| 18 | 368 | -- | appStudio/builderTools/definitionTools/addComponents.js:24 `applyAddComponents` | LF-S5 |
| 19 | 349 | T4 | routes/automation/catalog.js:58 `GET /catalog` | LF-S7 (after 5XX-4) |
| 20 | 347 | T1 | templates/exportTemplate.js:28 `buildExportHTML` | LF-S6 |
| 21 | 346 | -- | integrations/n8nWorkflowTools.js:598 `executeN8nWorkflowTool` | LF-S1 |
| 22 | 345 | T1 | stores/projectTaskStore.js:189 `makeProjectTaskStore` | LF-S2 |
| 23 | 341 | T1 | services/documentEditBridge.js:47 `bridge` | LF-S6 |
| 24 | 338 | -- | integrations/nextcloudDeckTools.js:337 `executeNextcloudDeckTool` | LF-S1 |
| 25 | 335 | T1 | stores/documentHistory.js:45 `makeDocumentHistory` | LF-S2 |
| 26 | 331 | -- | stores/project/schema.js:21 `applyProjectSchema` | LF-S3 ⚠ DDL order |
| 27 | 327 | -- | routes/transcriptions/reprocess.js:54 `POST /:id/reprocess` | LF-S7 (after 5XX-5) |
| 28 | 321 | T1 | integrations/driveTools.js:326 `executeDriveTool` | LF-S1 |
| 29 | 321 | -- | stores/cms/exportImport.js:265 `importSite` | LF-S6 |
| 30 | 319 | T1 | routes/ai/directChat/toolExec.js:95 `executeDirectChatToolCall` | LF-S4 ⚠ (the user's tool path) |

### Top 30, agent-hub (`src/`)
| # | Lines | Tests | Function | Package |
|---|---|---|---|---|
| 1 | 978 | T3 | pages/LoginPage.jsx:30 `LoginPage` | LF-A1 ⚠ auth (OPAQUE/MFA), alone |
| 2 | 856 | -- | pages/TemplatesPage.jsx:25 `TemplatesPage` | LF-A2 |
| 3 | 780 | -- | AgentHub/useAgentHubData.js:46 `useAgentHubData` | LF-A3 ⚠ core data hook, untested |
| 4 | 720 | T1 | pages/AdvancedSettings.jsx:238 `AdvancedSettings` | LF-A2 |
| 5 | 715 | -- | components/support/SupportInboxPanel.tsx:124 | LF-A7 |
| 6 | 711 | T2 | components/agents/AgentWizard/BuilderSplit.jsx:37 | LF-A8 |
| 7 | 678 | -- | components/renderers/PageRenderer.jsx:8 `PageRenderer` (+ nested `renderElement` 518 = 2 counts) | LF-A6 |
| 8 | 670 | T4 | editor/react/BeeEditor.jsx:62 `BeeEditor` | LF-A6 ⚠ collab editor (Yjs) |
| 9 | 652 | -- | AuthedApp.jsx:119 `App` | LF-A3 ⚠ routing shell, untested |
| 10 | 628 | T7 | AgentHub.jsx:54 `AgentHub` | LF-A3 |
| 11 | 621 | -- | components/integrations/IntegrationsAdminPanel/TranscriptionSection.tsx:27 | LF-A7 |
| 12 | 617 | -- | components/automation/index.jsx:24 `AITasksDesigner` | LF-A5 |
| 13 | 609 | T9 | components/automation/Builder/DiagramPane.jsx:193 (forwardRef) | LF-A5 |
| 14 | 570 | T2 | hooks/useAppBuilderStream.ts:155 | LF-A9 ⚠ streaming |
| 15 | 539 | T1 | automation/Builder/flow/settings/approvalEditors.jsx:168 `ApprovalFields` | LF-A4 |
| 16 | 533 | T7 | automation/Builder/flow/nodes/StepNodeBase.tsx:89 | LF-A4 |
| 17 | 528 | T7 | automation/Builder/flow/settings/routeEditors.jsx:72 `RouteFields` | LF-A4 |
| 18 | 518 | -- | renderers/PageRenderer.jsx:44 `renderElement` | LF-A6 |
| 19 | 511 | T6 | automation/Builder/mapping/ValueBuilder.jsx:95 | LF-A5 |
| 20 | 508 | T3 | hooks/useKnowledgeBases.ts:114 | LF-A9 |
| 21 | 504 | T1 | pages/EmbedChat.jsx:23 `EmbedChat` | LF-A2 |
| 22 | 498 | T1 | components/skills/SkillsPopover.jsx:41 | LF-A8 |
| 23 | 489 | T1 | admin/Studio/Playbooks/stages/AccessStage.jsx:58 | LF-A8 |
| 24 | 489 | -- | components/chat/InputArea/index.jsx:113 | LF-A8 ⚠ chat input, untested |
| 25 | 485 | T1 | components/chat/Voice/useVoiceSession.ts:60 | LF-A9 ⚠ audio and WebSocket lifecycle |
| 26 | 484 | -- | components/onboarding/OnboardingTour.tsx:61 | LF-A7 |
| 27 | 482 | T9 | automation/Builder/BuilderShell.jsx:79 | LF-A5 |
| 28 | 465 | -- | integrations/github/GitHubSyncPanel.jsx:7 | LF-A7 |
| 29 | 464 | -- | agents/AgentStudio/index.jsx:31 `AgentStudio` | LF-A8 |
| 30 | 462 | T3 | admin/Studio/Datatables/NewDatatableDialog.jsx:98 | LF-A8 |

### Long-function work packages (disjoint files)
- **LF-S1** tool executors (switch → handler map): workspaceTools, youtrackTools, n8nWorkflowTools, nextcloudDeckTools, driveTools. Low/med. Characterise n8n and deck first.
- **LF-S2** store factories: solutionStage/deployments, memoryQueries, projectAiParticipationStore, projectTaskStore, documentHistory. Low. Assert the key set of the factory's exported object.
- **LF-S3** schema init: stores/agent/initSchema `_doInit`, stores/project/schema `applyProjectSchema`. Med (DDL order). Verify with the pglite-backed store tests.
- **LF-S4** ⚠ streaming AI routes: ai/cmsBuilder, ai/templateChat, ai/directChat/toolExec. High. Extract only pure prompt and payload builders; leave the SSE write and abort flow in place.
- **LF-S5** app/automation validators and builders: appStudio/validate/actions `validateStep`, appStudio/validate `validateAppDefinition`, definitionTools/addComponents, automation/builderTools/addSteps. Med. Characterise `validateStep` first (security-relevant refusals).
- **LF-S6** misc: projects/projectFiles, projects/chatAssistant, templates/exportTemplate, services/documentEditBridge, stores/cms/exportImport.
- **LF-S7** wave 2 (the files are also in 5XX packages): transcriptions/upload and reprocess (after 5XX-5), automation/formQueue and routes/automation/catalog (after 5XX-4), auth/connectorJwt ⚠ (after 5XX-8).
- **LF-S8** ⚠ stores/lib/pgAppEngine `createPgAppEngine`, alone, with a reviewer.
- **LF-A1** ⚠ LoginPage, alone. **LF-A2** TemplatesPage, AdvancedSettings, EmbedChat. **LF-A3** ⚠ AuthedApp, AgentHub, useAgentHubData (shared state, so one agent).
- **LF-A4** flow/settings/approvalEditors, flow/settings/routeEditors, flow/nodes/StepNodeBase. **LF-A5** DiagramPane, BuilderShell, ValueBuilder, automation/index.
- **LF-A6** PageRenderer (2 counts), BeeEditor ⚠. **LF-A7** SupportInboxPanel, TranscriptionSection, OnboardingTour, GitHubSyncPanel (all untested: characterise first).
- **LF-A8** BuilderSplit, SkillsPopover, AccessStage, InputArea ⚠, AgentStudio, NewDatatableDialog. **LF-A9** ⚠ useAppBuilderStream, useKnowledgeBases, useVoiceSession.
- The remaining ~100 server and ~240 agent-hub functions follow the same recipe in later waves, one directory per package (largest clusters:
  agent-hub components/admin 101, components/automation 27; server routes/ai 14).

Verification:
```bash
node scripts/count-ratchet.mjs long-function server --list | grep -F '<file>'   # server
node scripts/count-ratchet.mjs long-function agent-hub --list | grep -F '<file>'
npm run lint:file-budget && npm run lint:dutch-comment-ratchet && npm run lint:ts-ratchet && npm run check:fast
server: node --test <tests next to file>   |   agent-hub: npx vitest related --run <files> && npm run typecheck && npm run lint && npm run lint:dead
```

## 4. Waves (to keep merge conflicts low)

- **Wave 1 (parallel):** 5XX-1…7, SCC-C, SCC-D, LF-S1, LF-S2, LF-S3, LF-S5, LF-S6, LF-A2, LF-A4, LF-A5, LF-A7, LF-A8. The file sets are disjoint.
  The only shared file in SCC is `boot/featureRegistrations.js`, used by SCC-A and SCC-B: one `require` line each, so a trivial conflict. Merge A first.
- **Wave 2:** SCC-A, SCC-E, then SCC-B. 5XX-8 (gates). LF-S4, LF-S7, LF-S8, LF-A1, LF-A3, LF-A6, LF-A9.
- Optional: 5XX-9 (HTML pages): needs a design decision first.

## 5. Lowering the ratchets (the integrator, once, after merging)

Each `--update` writes `min(measured, budget)` and today's `_generated`, and never raises:
```bash
node scripts/count-ratchet.mjs status-5xx server --update        # server/.status-5xx-ratchet.json  count
node scripts/count-ratchet.mjs long-function server --update     # server/.long-function-ratchet.json
node scripts/count-ratchet.mjs long-function agent-hub --update  # agent-hub/.long-function-ratchet.json
node scripts/scc-ratchet.mjs server --update                     # server/.scc-ratchet.json  size
node scripts/file-budget.mjs server agent-hub --update           # per-file ceilings come down
node server/layering.test.js --update                            # upward pairs (the SCC cuts remove stores->jobs/core/projects edges)
node scripts/count-ratchet.mjs big-file server --update; node scripts/count-ratchet.mjs big-file agent-hub --update
npm run check:fast -- --list --slack                             # shows any remaining slack
```
Commit as one `chore(gates): lower the budgets to what <wave> measured` (precedent: `5f66fc31d`, `2ac6dac03`).
