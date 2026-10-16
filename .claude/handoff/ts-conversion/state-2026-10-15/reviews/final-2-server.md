# Final review, part 2 of 3: `server/`

Range: `77c40ea85` (origin/main) .. `05393c5fa` (convert branch). 1005 server files changed (+77k / -62k).

Most of the server diff (730 files) arrives through the multi-root snapshot commit `2d36c711`. No commit in the range covers it on its own: the automationRunner splits (runDag, stepDispatch, runFinalize), featurePorts, the KB sources split and the routes/ai config dedupe all come in that way. I sampled those directly, alongside the commits that are named.

## How I checked
- **Tests:** ran `node --test` on sheetDocument, studioDocuments/sheet, sheetChartSpec, sheetDocumentTools, simulatedPaths, meetingPrefsOptIn, teamsAutoImport, adoptOrphanDocuments, transcriptions/teams and the five runDag suites. All green.
- **Typecheck:** `cd server && npm run typecheck`: 1080 files, 0 errors.
- **Gate inventory, base vs tip:**
  - `requireLicenseFeature`: 12 → 12, same features.
  - `requireCapability`: 56 → 56, same ids.
  - `requirePermission`, `requireSuperAdmin`, `requireOrgAdmin`, `canAccessKB`, `canManageKB` and `requireSheets`: unchanged.
  - The `requireAuth` drop of 9 is fully explained. routes/ai/config/modelTiers.js now registers its model-id settings through a `modelIdSetting()` helper, and each route keeps `requireAuth, requireAdmin` in the same order. sheet.js has +1, its injected default.
- **Long-function splits read against base (closures, early returns, transactions, error flow):**
  - runFinalize → runFinalizeEffects
  - stepDispatch → stepLeaf, handleStepFailure and retryStep
  - runDag (replayDecision, replayRoute, routeOutEdges, warnDeadEnds)
  - solutionStage/deployments and the other LF-S2 store factories (script check for references across sub-factories: none unbound)
  - documentEditBridge → bridgeCore, bridgeDraw and bridgeWire (shared state through accessors on B)
  - the KB sources route split: route table and middleware identical, `addFiles` identical
  - testsGuards/testsRun
- **Grep of the added diff:**
  - The only new `res.status(5xx)` lines are the two OAuth HTML close pages, moved verbatim.
  - The only new `console.*` is browser code in exportTemplateParts.js.
  - SQL built from `${}` is always constants, column lists or `$n` placeholders: no injection.
  - Empty catches: all moved cleanup code (the ratchet counts them).
- **Callers of the error contract:** extracted all 467 removed `error: '…'` 5xx strings. 354 no longer exist in the server. I grepped every one of them through agent-hub, mobile, desktop and nextcloud-connector, plus every client `.error === '<token>'` comparison (22 tokens). The only tokens whose emission changed (`hub_unavailable`, `mcp_registry_unavailable`) are kept as the HttpError message. `MarketplaceTab` reads `details?.detail ?? detail`.

## Scores
| Dimension | Score | Why |
|---|---|---|
| Behaviour preservation of refactors | 8/10 | The splits I sampled are faithful: same await order, transaction boundaries and rethrows, and the leaf switch was moved verbatim. One intentional semantic shift: authenticated studio data `handleErr` now passes other 4xx through instead of a 500. |
| Error-contract consistency | 7/10 | Server side it is uniform: HttpError + terminal handler, tokens kept where clients branch on them. Two weak spots: client fallback sentences (`body.error \|\| '…'`) are now masked by "Internal server error", and some routes still log and then throw, so the error is logged twice. |
| Bug-fix correctness | 8/10 | #158, #159, #160, #162 and #175 are correct, and every REQUIRED review item is applied (mark check before the token refresh, eager `_simulatedPaths`, managed-KB skip, `truncated` carried). One new chart-limit bypass in the feat/164 code. |
| Tests | 8/10 | Every fix has colocated tests and all of them pass; the refactors have key-set and characterisation tests. Gap: duplicate ids in `removeCharts` are untested. |
| Security/privacy | 7/10 | No PII goes to an outbound destination, gates are intact and fail closed (entitlements, licence tier, erasure ports). But path tokens now reach the terminal-handler log; one pre-existing issue is reported privately. |
| Convention adherence | 8/10 | New code is in domain folders, uses `log`, `@typecheck`, `db.withTransaction` and stores rather than SQL in routes. Nits: some double logging, and a GET that writes (KB adoption, deliberate and documented). |

## Findings

No BLOCKING regressions in the branch's own changes.

### FOLLOW-UP 1: `removeCharts` with repeated ids gets past the 40-chart cap
- **Where:** `server/core/documents/sheetChartSpec.js:35`, `:64` (new in feat/164).
- **Why:** `removed` is not deduplicated. The cap check subtracts `removed.length`, but `addCharts` removes each id only once.
- **Reproduced:** a sheet holds 40 charts. Calling `chartsFrom([new, new, new], 't1', have, ['c0','c0','c0'])` is accepted and saves 42 charts, and the result reports 3 removed.
- **Fix:** `const removed = [...new Set(Array.isArray(remove) ? remove.map(String) : [])];` plus a one-line test.

### FOLLOW-UP 2: secret tokens in the URL path now reach the error log
- **Where:** `server/core/http/terminalErrorHandler.js:65`.
- **Why:** the handler strips the query string because "public links carry their token there", but it logs the full path. This branch moved many routes onto the terminal handler, and some carry a bearer token in the path. For example, `GET /auth/invite/:token` (`server/auth/login/inviteRoutes.js:23`) used to log only `[Invite] Token validation error`. On a 500 it now logs `[HTTP] 500 GET /auth/invite/<plaintext invitation token>` at error level. Invitation tokens are stored and looked up in plaintext (`stores/invitationStore.js:67`). Public studio app, form and share routes (`/:token`) log the same way on 5xx, and on every thrown 4xx at warn level.
- **Fix:** log `req.route?.path` (the pattern) with the mount path instead of `originalUrl`, or mask long opaque segments (`/[A-Za-z0-9_-]{20,}/` → `…`). Add a test that a `/invite/<token>` 500 does not log the token.

### FOLLOW-UP 3: friendly fallback sentences in clients are masked by the generic 500 text
- **Where:** `agent-hub/src/pages/PublicFormPage.jsx:240`, `agent-hub/src/components/forms/PublicFormRenderer.tsx:811`, and the server side at `server/routes/automation/formPublic/page.js:150`.
- **Why:** clients write `body.error || '<fallback>'`, and every generic 500 now carries `error: 'Internal server error'`, so the fallback never shows.
- **Concrete case:** an anonymous visitor whose app_pick search fails used to see "That app could not be searched". They now see "Internal server error", untranslated, on a public page.
- **Same pattern elsewhere:** EncryptionSetup "Recovery failed", nextcloud-connector `bootstrap.js:521` "Verification failed (HTTP n)", plus about 40 admin fallbacks (grep list in the session).
- **Fix, either way:**
  - in clients, ignore `error` when `status >= 500 && !body.code` (a shared helper next to `caughtError.ts`), or
  - on the server, `throw new HttpError(500, 'pick_failed', 'That app could not be searched')` on public, visitor-facing routes.

### FOLLOW-UP 4: authenticated studio data routes now echo non-standard 4xx messages
- **Where:** `server/routes/studio/appDataContext.js:143`.
- **Why:** `handleErr` ends in `throw err`, and the terminal handler answers any 4xx with `{ error: err.message }`. On base, a 404, 413 or 429 here became `500 'Data request failed'`. Review-notes flagged this for 5XX-3, but 96106eaf fixed only the public twin (`studioAppPublic.js`).
- **Leaks:** none found; I found no 4xx error with an internal message on this path. It is a status and contract change, though.
- **Fix:** apply the same rule as `studioAppPublic.handleErr`:

  ```js
  if (err instanceof HttpError) throw err;
  throw Object.assign(new Error('Data request failed'), { cause: err });
  ```

  Or keep the pass-through and add a test pinning the 404 body.

### FOLLOW-UP 5: (redacted — a pre-existing security issue, reported privately to the owner per SECURITY.md)
### FOLLOW-UP 6 (nit): the same 5xx is logged twice
- `server/routes/studioDocuments.js:223-224` runs `log.error(...)` and then `throw new HttpError(500, …)`, and the terminal handler logs it again. Same pattern in `routes/ai/voice.js` (availability) and `routes/agents/testsGuards.js` (`log.error` before the 503 throws).
- **Fix:** drop the route-side `log.error`, or pass `{ cause }` and let the handler log once.

Checked and fine (no finding):
- The chart-data-loss fixes. `settingsWithTabs` keeps charts and drops orphans for every tab writer (route add/rename/delete, document_write addTab, workbook import). `keepSheetOnUpdate` merges correctly. Duplicating a sheet carries the charts, remapped to the new tabs. The tab-scoped update and remove rules hold.
- SCC ports are registered on the only process entrypoint (`index.js`) and in the scripts that delete users or write datatables. There are no worker threads that run the runner.
- The #175 path recorded and the path compared are both taken before egress masking.
- #162 adoption is scoped by kbId, takes a per-KB advisory lock, and skips managed, system and project-files KBs.

## Client-visible behaviour changes (for the PR description)

**Error contract**
- **Every unexpected 5xx:** body is `{ error: 'Internal server error', correlationId }`. About 350 route-specific sentences are gone ("Failed to save config", "Failed to list apps", "Upload failed", …).
- **Deliberate 5xx (HttpError):** body is `{ error: <message>, code, details?, correlationId }`.
- **Extra top-level fields moved under `details`:**
  - `retry_after` (entitlement_unavailable, tier_unavailable; the `Retry-After` header is kept)
  - `detail` (hub_unavailable)
  - `messageId` (support reply_send_failed, 502)
  - `event_id` (Stripe handler_failed, still 500, so Stripe still retries)
- **Fields that are gone or changed:**
  - `detail` from mcp_registry_unavailable.
  - `message` from compliance not_provisioned, notify_failed and notification_failed: `error` is now the sentence and the token moved to `code`.
  - `{ enabled:false, reason:'error' }` from the voice availability 500, now `availability_failed`.
  - `valid:false` from the invite-validation 500.
  - Stripe ledger-unavailable is now a generic 500 (was `ledger_unavailable`).
- **Fail-closed 503s:** gate 503s (entitlement, tier, feature service, auth) are logged at error level and answered by the terminal handler.
- **Other 4xx from authenticated studio app data routes:** answered with their own status and message instead of `500 Data request failed`.

**Spreadsheets (feat/164)**
- Adding, renaming or removing a tab keeps the sheet's charts. Removing a tab removes the charts pinned to it, and orphaned charts are cleaned up on the next tab write.
- Duplicating a sheet copies its charts (new ids, pinned to the copied tabs), and the response is the copy as saved (tabs, charts, version).
- Chat `document_write`:
  - updates only charts on the tab it writes to (or charts with no tab)
  - refuses an id that is both updated and removed, or updated twice
  - returns `chartIds` for new charts
- Chat `document_read` chart summaries include `categoriesRange`, with a default size for charts stored without one.
- The spreadsheet assistant's add_chart pins the chart to the active tab (it used to show on every tab).
- Excel export: the whole-number format check ignores non-finite values.

**Meeting notes**
- **#158:**
  - A personal "record" mark on a Teams meeting imports it even with autoImport off, and overrides an org-level off.
  - Series marks always count; event marks count for 10 days.
  - Deleted and deactivated users are no longer polled.
  - `/teams-meetings` shows `will_import` for marked meetings.
- **#159:**
  - `/teams-recordings` returns `recordingState: 'processing'` within the deadline (new UI string).
  - The no-recording deadline goes from 24 h to 48 h, so auto-import keeps looking twice as long.
- **#160:**
  - Teams, Meet and Talk imports honour the `azure` and `whisper_azure` engines (they used to fail with "Mistral API key not configured").
  - A truncated Azure transcript gets a notice in the summary.
  - Google Meet imports are no longer pinned to WhisperX and follow the workspace engine. Meeting audio can therefore go to whichever cloud STT provider the admin configured.

**Knowledge bases (#162)**
- `GET /:id/sources` adopts pre-source-model documents into sources (it writes rows) for non-managed, non-system, non-project-files KBs. The Sources tab now lists what the overview counts.

**Automations (#175)**
- In a dry run, a Nextcloud "not found" read on or below a path that a simulated step would have written returns a sample with `dryRunFallback: 'simulated_upstream'` instead of failing.

**Logging (operator-visible)**
- The terminal handler logs the path without the query string. Every 5xx is logged once by `[HTTP] <status> <path> correlationId=…`; some routes also log it themselves.
