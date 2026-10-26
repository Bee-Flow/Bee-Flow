# `server/` — how it is laid out and why

This document exists so a developer opening `server/` for the first time can
answer three questions without reading code: **what is the core of Bee Flow**,
**what is built on top of it**, and **what may depend on what**.

It describes the target layout and marks honestly which parts of the tree have
been moved there and which have not yet. Where the two disagree, this file is
the intent and the tree is the backlog.

---

## The three layers

Everything in `server/` belongs to exactly one of these. The layer decides who
may depend on you, and it is the only rule that must never be bent.

```
       ┌─────────────────────────────────────────────┐
       │  API          HTTP surface. No logic.       │   routes/
       └──────────────────────┬──────────────────────┘
                              │  may call anything below
       ┌──────────────────────┴──────────────────────┐
       │  FEATURES     One product surface each.     │   cms, learning, support,
       │               Independent of each other.    │   compliance, automation,
       └──────────────────────┬──────────────────────┘   appStudio, …
                              │  may call CORE + PLATFORM
       ┌──────────────────────┴──────────────────────┐
       │  CORE         What Bee Flow *is*: talking   │   core/
       │               to models, safely, on behalf  │
       │               of an org, with its data.     │
       └──────────────────────┬──────────────────────┘
                              │  may call PLATFORM only
       ┌──────────────────────┴──────────────────────┐
       │  PLATFORM     Infrastructure. Knows nothing │   db, stores, auth,
       │               about AI or product features. │   utils, middleware
       └─────────────────────────────────────────────┘
```

**Dependency rule — the one that matters.** Arrows point downward only.

- CORE must not require a FEATURE. If core code needs something from a feature,
  the dependency is upside down: the feature should pass it in.
- A FEATURE must not require another FEATURE. Two features that need the same
  thing means that thing belongs in CORE or PLATFORM. `core/cms/themeSpec.js`
  carries a comment explaining exactly this case — it was moved out of
  `appStudio/` the moment `automation/` needed it too.
- Nothing may require `routes/`.

Violations are the main reason a large codebase stops being navigable, because
they make "where does this live?" unanswerable.

---

## CORE — `server/core/`

The part of the system that is Bee Flow rather than plumbing: take a request
from a user in an org, decide which model may serve it, strip what must not
leave the building, call the model, run whatever tools it asks for, and account
for the cost.

| Folder | What lives there |
|---|---|
| `core/llm/` | Model orchestration: `llmClient`, `modelResolver`, `modelCosts`, `pricingService`, `tokenBudget`, prompt shaping and cache stability. |
| `core/providers/` | One adapter per LLM vendor (`claude`, `openai`, `google`, `azure`, `mistral`, `scaleway`, `local`) behind the factory in `providers/index.js`. **Add a provider here, never ad hoc elsewhere.** |
| `core/agentRuntime/` | The streaming chat turn: context building, history hydration, tool dispatch, SSE lifecycle, attachment processing. |
| `core/automationRunner/` | Execution engine for automations — steps, loops, approvals, pause/resume. |
| `core/automationModel/` | The automation definition model, pure (no stores, db or network): `bind.js` (the binding resolver), `codeOutput.js` (the Code step's envelope), `sideEffectMap.js` (which tools read, write or send), `approvalStages.js` (the stage chain's rulebook) and `constants.js` (the validator's vocabulary and ceilings). The runner, agentRuntime, App Studio and the builder all read it, so it lives below them; `automation/{bind,codeOutput,sideEffectMap,approvalStages}.js` and `automation/validate/constants.js` are re-export shims. |
| `core/documents/` | Turning an uploaded file into text: extraction, PDF/OCR, chunking, image inlining. And back: `render/` turns text into a PDF or Word file (`documentRenderer.js`), `office/` builds real office files (`officegen.js`: xlsx, ods, docx, odt, pptx). |
| `core/dataEngine/sources/` | A datatable whose ROWS come from somewhere else. `index.js` is the REGISTRY — the only module routes, jobs and runners require (`isSourceMirror`, `writeThrough`, `kickStale`, `syncRows`, `sourceLabel`, `builderKindOf`), with one LAZY adapter per `managed_kind`; no consumer compares a kind string (`sources/index.test.js` greps for it). `mirror/` is the shared engine every kind runs on: the eleven-step refresh pass (`syncPipeline.makeSync(adapter)`, with the adapter's `open()` able to answer "unchanged" so a probe never moves `data_version`), the probe-then-source-then-rewrite write-through and its batch forms (`writeThrough.makeWriteThrough(adapter)`), staleness/kicks, schema reconciliation, relation indexes, row derivation, linking choreography, the one `SourceError`. |
| `core/dataEngine/sources/nextcloudTable/` | The Nextcloud Tables ADAPTER (`managed_kind = 'nextcloud_table'`): `adapter.js` answers the engine's questions in Nextcloud's terms (the linker's API, columns → fields, a row's cells, the `nc` relation label), plus what only this source has — the REST client, the cell codec, push-event patching, the linking dialog's linkable/describe. `sync.js` / `writeThrough.js` are `makeSync` / `makeWriteThrough` over it, keeping every export their callers and tests knew. |
| `core/dataEngine/sources/spreadsheetFile/` | The spreadsheet-file ADAPTER (`managed_kind = 'spreadsheet_file'`): one worksheet of an xlsx/csv/ods/Google Sheet in Google Drive, OneDrive or Nextcloud Files, same engine, same routes (`/:id/source/*`, `routes/datatablesSpreadsheets.js`). Row identity from a key column or the row number; a cheap version-marker probe before any download; write-through edits the file in place. `providers/` (Drive+Sheets, Graph incl. the Excel workbook API, WebDAV) behind one FileApi, `formats/` (SheetJS read, exceljs in-place edit, a byte-faithful csv rewriter), `infer.js`/`columns.js`/`identity.js` for the header row, and `events.js` for the connector's `file.*` push and the OneDrive drive-wide hint. |
| `core/dataEngine/` | The user-defined-table engine: field/filter/aggregate vocabulary, per-dialect DDL, stable-id migration planning, and `queryCompiler.js` — **the only place SQL is generated** from a validated table descriptor plus a closed-vocabulary request. Shared by App Studio apps and automation datatables; it lives in core precisely because two features need it and neither may require the other. `appStudio/queryCompiler.js` and `appStudio/dataModel/*` are re-export shims over it. |
| `core/packaging/` | The Blueprint format's leaves: `manifest.js` (the format), `scrub.js` (what never leaves an installation), `pointers.js` (every place a part points at another), `walkers.js` (`walkObjects`, `walkAllSteps`). App Studio capture, automation export and `projects/packaging/` all use them, so they live below all three; `projects/packaging/{manifest,scrub,pointers}.js` are re-export shims, and `appStudio/templateCapture.js` / `automation/portability.js` re-export the walkers. |
| `core/dlp/` | Data-loss prevention: scanning, decision queue, ledger. |
| `core/kb/`, `core/rerank/`, `core/embed/` | Retrieval: ingestion, embedding, reranking. |
| `core/memory/`, `core/conversation/` | Long-term memory and conversation shaping. |
| `core/meetingNotes/`, `core/voice/` | Audio capture, transcription, summarisation. |
| `core/markdown/`, `core/seo/`, `core/cms/`, `core/swarms/`, `core/customIntegrations/` | Supporting domains. |

### Grouping the flat files — done

`core/` accumulated ~97 loose `.js` files at its top level. That listing is the
single biggest obstacle to reading this module: nothing about it says which
files belong together. They were grouped into the folders above, a domain at a time.

- **Done.** What is left at the flat level falls in three kinds, and none of
  them is a stray:

  - **Entry points** that stay where they are because half the tree (and
    `CLAUDE.md`) names them: `aiAgent`, `aiTaskRunner`, `automationRunner`
    (+ its `automationRunner.partial.testkit.js` for the runner tests),
    `executionEngine`, `mcpManager` (+ `mcpChildEnv`, the environment its two
    spawn sites hand an MCP child), and the two event buses `projectEventBus`
    and `runEventBus`.
  - **A CI contract**: `releaseNotesFormat` (+ `releaseNotesDrafter`). The
    release workflow and `scripts/release-notes/draft.js` load
    `server/core/releaseNotesFormat.js` by that path, so it moves only together
    with them.
  - **Re-export shims** at the old path of a file that moved into its domain
    folder. Each is one `module.exports = require(...)` with a comment naming
    the new home; existing requires, test stubs keyed on the old require string
    and `require.cache` keys on the old path keep working. New code requires the
    new path.

    | Old path (shim) | Now lives in |
    |---|---|
    | `core/azureServiceCosts.js` | `core/llm/azureServiceCosts.js` |
    | `core/webSearchInferenceResolver.js` | `core/llm/webSearchInferenceResolver.js` |
    | `core/n8nWorkflowConverter.js` | `core/kb/n8nWorkflowConverter.js` |
    | `core/umamiClient.js` | `core/cms/umamiClient.js` |
    | `core/automationErrors.js` | `core/automationRunner/automationErrors.js` |
    | `core/serviceAuth.js` | `core/http/serviceAuth.js` |
    | `core/projectFeed.js`, `core/projectFeed.runs.js` | `core/projectContent/` |
    | `core/concurrencyUtil.js` | `utils/concurrencyUtil.js` (dependency-free, so platform) |

    A shim that sits between two files of an import cycle grows that cycle by
    one and trips `lint:scc-ratchet`; point the importers inside the cycle at
    the new path instead (that is why the importers of `azureServiceCosts` and
    `webSearchInferenceResolver` already do).

  Everything else lives in a named folder:

  `core/llm/` · `core/providers/` · `core/agentRuntime/` · `core/automationRunner/`
  `core/privacy/` · `core/dlp/` · `core/documents/` · `core/tools/` · `core/kb/`
  `core/rerank/` · `core/embed/` · `core/memory/` · `core/conversation/`
  `core/entitlements/` · `core/integrations/` · `core/http/` · `core/text/`
  `core/cms/` · `core/cad/` · `core/webpages/` · `core/cowork/` · `core/seo/`
  `core/swarms/` · `core/meetingNotes/` · `core/voice/` · `core/markdown/`
  `core/customIntegrations/` · `core/dataEngine/` · `core/datasets/`
  `core/findings/` · `core/scheduling/` · `core/skills/` · `core/packaging/`
  `core/automationModel/` · `core/projectContent/` · `core/classify/`
  `core/collab/` · `core/media/` · `core/versioning/`

New code goes in the folder for its domain. Do not add to the flat level.

#### How to move a group safely

Two things bite, and only the first is obvious.

1. **Relative imports** across ~3400 files. Resolve every specifier against the
   old layout, then re-derive it from the new one — do not pattern-match paths.
   `importPaths.test.js` then proves the result: it walks the tree and asserts
   every relative `require`/`import` resolves to a real file.

2. **Module ids that are not require calls.** Tests reach for the module under
   test's require string in four shapes an import rewriter cannot see, and all
   four fail *quietly* — the stub simply stops matching, the real module loads,
   and the test dies somewhere that looks unrelated (typically a live Postgres
   connect, or an assertion about output the real implementation produced):

   ```js
   installResolveStub({ '../stores/configStore': stub })      // an object KEY
   require(path.join(__dirname, '..', 'piiDetection'))         // path SEGMENTS
   if (request === '../piiDetection') return STUB              // a comparison
   mock(path.join(SERVER, 'core/integrationToolMap'), stub)    // DOTLESS id
   ```

   The fourth is the worst of them: it is package-root-relative, so it carries
   no leading `./` and every repair keyed on "starts with a dot" walks straight
   past it.

   `testUtils/stubRequire.js` matches on the require string *as written inside
   the module under test*, not relative to the test file — so after a move the
   key has to follow the module, not the test. `importPaths.test.js`
   deliberately does not scan these, because resolving them from the test's own
   directory reports nonsense. Grep for the old specifier by hand after a move;
   the whole-suite failure list is the backstop.

---

## PLATFORM

Infrastructure that knows nothing about AI or about any product feature.

| Folder | What lives there |
|---|---|
| `db.js`, `migrations/` | Postgres access; `migrations/` holds the loose data migrations and NL catalogues that `boot/bootMigrations.js` runs and records in `schema_migrations`. Store DDL lives in the store itself, in its `makeStoreInit` init, and is recorded in the same table per statement (`stores/lib/ddlLedger.js`): no hand-written "is the new column there yet" probes. |
| `boot/` | Start-up: the migration ladder and its ledger, feature gates, security headers, request timing, background start-up tasks. Listed here for what it holds, but `layering.test.js` classifies it as an **entry** (composition root) beside `index.js`: it wires features together at start-up. |
| `stores/` | Persistence per aggregate. A store owns its table(s) and its encryption. `stores/lib/sqlBuilder.js` is the only sanctioned way to build a dynamic `UPDATE`. |
| `auth/` | Sessions, permissions, org membership, OAuth/SSO, MFA, signed tokens. `auth/lib/` holds the shared signing-secret ladder and HMAC envelope used by the token modules. |
| `utils/` | Small dependency-free helpers. If it needs a store, it is not a util. |
| `middleware/` | Express middleware (upload guards, public uploads). |
| `telemetry/` | Metrics, traces and the logger (`telemetry/log.js`). |
| `testUtils/` | Test doubles — see the `installResolveStub` warning above. |
| `license/`, `modules/` | Entitlement resolution: what tier an org is on and which capabilities it holds. Classified here, not as features — see the note below. |

**Encryption at rest** is a platform concern with more than one shape, on
purpose. `utils/secretBox.js` (scrypt from `SESSION_SECRET`) is for small JSON
secret blobs; `stores/orgVault.js` (HMAC from `MASTER_ENCRYPTION_KEY`, per-org)
is for tenant secrets; `stores/agent/messageEncryption.js` (HKDF + AAD, per
conversation) is for user content. The per-feature salts and key-derivation
contexts are **deliberately distinct** and must never be unified — a compromise
scoped to one feature must not decrypt another's.

Which of them runs for a given org is decided by `stores/encryptionPolicy.js`
(tier and per-surface scope, consulted on every write), `stores/encryptionAvailability.js`
(may this org select that tier — entitlement and deployment readiness) and
`stores/initialTier.js` (what a brand-new org starts on). They sit here, not
under `core/privacy/`, because every caller is a store writing a row or an auth
route reporting what the org may choose; nothing about them concerns a model or
a product surface. Privacy Shield — the PII work in `core/privacy/` — is a
different subject that happens to share the word.

---

## FEATURES

One product surface each, independent of one another.

`automation/` · `cms/` · `cmsBuilder/` · `compliance/` · `learning/` ·
`support/` · `integrations/` · `mcpServers/` · `appStudio/` · `projects/` ·
`agents/` · `services/` · `jobs/` · `workers/` · `legal/` · `eval/` ·
`pipeline/` · `playbooks/` (phased AI builds — the recipe DOCUMENT
(`recipeDoc.js`: what an AI or a person writes, `composeRecipe.js`: the
Fast-tier call that writes one), the built-in recipes, the lifecycle and the
three server-run phases (table, fill, and `design` — the app as a designer sees
it, before any builder tool); it may require core/stores/auth, never `appStudio/`
or `automation/` — the route does that glue)

**`license/` and `modules/` are NOT features**, though this document said they
were until the dependency data disproved it. They answer "what tier is this org
on, which capabilities does it hold" — the same cross-cutting question as auth —
and `core/entitlements/` is supposed to depend on them. Ten apparent violations
turned out to be one wrong label.

`integrations/` is the widest: one file per third-party system (Google,
Microsoft, Nextcloud, …). `jobs/` and `workers/` are the scheduled/background
halves of features, not a layer of their own.

---

**Automation builder tools** (`automation/builderTools/`) have their own doctrine in
`automation/builderTools/README.md`: server-side repair over rejection, prefix-apply batches,
a replay corpus of recorded model batches, and the live-run gate on the local model.

## API — `routes/`

Express routers only: parse, authorise, delegate, serialise. A route that
contains business logic is a bug in the wrong place — the logic belongs in the
feature or in core, where it can be tested without HTTP.

Every route that gates a paid capability goes through
`requireLicenseFeature('...')`, verified against JWTs from Bee Flow's private
license server.

---

## The rule is enforced, not just written down

`layering.test.js` puts every top-level entry of `server/` in one layer —
`tooling` (`scripts/`, `testUtils/`, the CLIs) above `entry` (`index.js`,
`auth/router.js`, `boot/`, `boot-init.js`, `migrations/`) above `api`
(`routes/`, the routers in `auth/`) above `feature` above `core` above
`platform` (`stores/`, `auth/`, `utils/`, `db.js`, `telemetry/`, `license/`,
`modules/`, `core/entitlements/`, …), plus `data` (no code) — and fails on a new
folder that is not in its `LAYERS` table. It then counts every require that
points UP a layer, or sideways from one feature to another, per pair of units
(`stores -> core`, `core -> automation`, …), lazy requires inside function
bodies included, and compares each pair with `server/.layering-ratchet.json`:
a pair may shrink, never grow, and a pair that is not listed has budget 0. It
runs with the server suite and in `npm run check:fast` (`npm run
lint:layering-ratchet`); `node server/layering.test.js --list` shows each pair's
count against its budget, and `node server/layering.test.js --update` lowers
the budget after you remove edges (it never raises one). The baseline was
measured when every folder got its layer (66 pairs, 599 requires; the biggest
are `core -> integrations` and `core -> automation`), so the debt is visible per
pair instead of hidden in one total.

Cycles are budgeted separately: `npm run lint:scc-ratchet` (`scripts/scc-ratchet.mjs`)
measures the largest strongly connected component of the import graph, lazy
requires included, against `server/.scc-ratchet.json`, and fails when a new
require makes it bigger; `node scripts/scc-ratchet.mjs server --list` prints its
files.

Two checks stay hard rather than budgeted:

- **0 upward edges into `routes/`**, and the baseline is pinned there. The six
  were the support feature reaching into `routes/support` for helpers that were
  never HTTP, and the MCP token CLI loading `routes/mcpServer` for its signer;
  both sets of functions now live below the route that used to hold them.
  The `entry` and `tooling` layers sit above `api` and are exempt — mounting
  routers is a composition root's job.
- **9 edges in a `license/` ↔ `modules/` cycle.** Legal within one layer, still
  a smell.

How the platform → core/feature edges came down, before they were budgeted per
pair (they were one total, 56, against a narrower list of features). Down from
200: the HTML sanitizer, the field envelope, `appPaths`, `buildInfo`, the request
client context, the HTTP metrics, the at-rest encryption policy, the
unattended-OAuth resolver and the geo resolver were platform modules filed
under `core/`, and moving each one down removed every edge into it.

The last step from 85 to 56 moved no code at all — it corrected two labels,
the same way `license/` and `modules/` were corrected before. `core/
entitlements/` answers the tier-and-capability question those two answer and
is classified with them; and the 35 Express routers inside `auth/` are API
surface, so `layering.test.js` now classifies a path rather than just its top
directory (see `unitOf()` there). `auth/router.js` joins the root `index.js`
as a composition root, because wiring routers together is its whole job.
(`auth/index.js` used to compose them; it is now only the facade that
re-exports the gates from `auth/permissions.js` and `auth/audience.js`, loads
no route file, and keeps `router` as a lazy getter, the one `auth ->
auth/router.js` edge in the budget. Only `server/index.js` requires
`auth/router.js`: `auth/router.test.js`.) The routers inside `auth/` include
`auth/securityKeys/index.js`, which builds and exports the two security-key
routers.

That second label had a concrete cost. `core/http/validate` lives under
`core/`, so a single zod schema in an auth router read as a platform → core
violation — and with the guard sitting exactly at its baseline, that put all
29 unvalidated auth routes out of reach until the label was fixed.

## Conventions

- **Tests sit next to their source** (`x.js` ↔ `x.test.js`), never in a central
  `tests/` directory. `npm test` runs `scripts/run-tests.mjs` over all of them
  (minus the documented exclusions in `scripts/test-exclusions.json`), each file
  in its own process with its own timeout; a single file is
  `node --test path/to/x.test.js`. Do not add `--test-force-exit`: it ends the
  process as soon as the runner thinks it is done and silently drops results
  that were not reported yet (the reasoning is in the header of
  `scripts/run-tests.mjs`). A file that keeps the event loop open after its
  tests is a bug in that file, and the runner names it (`HUNG`).
- **A file's folder is its documentation.** If you cannot name the folder a new
  file belongs in, the design question is not yet answered.
- **Personal data does not leave the product, except over email.** Anything in
  `integrations/` that posts outward carries a record reference and nothing more —
  never a name, address, organisation, verbatim customer text or attachment. Build
  the payload from an explicit allow-list of fields rather than by deleting keys
  from a row, so a column added later cannot leak by default. Email is the one
  exception, because there the data goes to the person it is about. Reading *in*
  from a third party is unconstrained. Full rule: CLAUDE.md → Security.

## CMS A/B tests on a block

A block becomes an experiment through four content fields: `abKey`, `abAlt`
(the fields that differ), `abShare` (1-99, default 50) and `abGoal`.
`cmsBuilder/experiments.js` warns about bad values; `core/seo/renderBlocks.js`
ignores them, so crawlers always get the original; `core/cms/cmsTranslate.js`
leaves `abKey`/`abGoal` alone and translates `abAlt`.

The split is cookieless by construction: the variant is drawn in the browser
(`agent-hub/src/marketing/experiments/experiment.ts`, `crypto.getRandomValues`)
once per page view and held in memory. Nothing is written to cookies,
localStorage, sessionStorage or the URL, and there is no visitor id, so there
is nothing to consent to. The cost is that a reload draws again, so results
count page views, not people. Events go to the site's own Umami through
`window.umami.track`, which only exists once the (consent-gated) tracker has
loaded: `ab_view` on render and the goal event on the first click on a link or
button, or form submit, inside the block, each with `{ experiment, variant }`
and nothing else. The editor preview never draws; it shows the original.
