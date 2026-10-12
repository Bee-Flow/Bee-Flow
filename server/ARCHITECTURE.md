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
| `core/documents/` | Turning an uploaded file into text: extraction, PDF/OCR, chunking, image inlining. |
| `core/dataEngine/sources/` | A datatable whose ROWS come from somewhere else. `index.js` is the REGISTRY — the only module routes, jobs and runners require (`isSourceMirror`, `writeThrough`, `kickStale`, `syncRows`, `sourceLabel`, `builderKindOf`), with one LAZY adapter per `managed_kind`; no consumer compares a kind string (`sources/index.test.js` greps for it). `mirror/` is the shared engine every kind runs on: the eleven-step refresh pass (`syncPipeline.makeSync(adapter)`, with the adapter's `open()` able to answer "unchanged" so a probe never moves `data_version`), the probe-then-source-then-rewrite write-through and its batch forms (`writeThrough.makeWriteThrough(adapter)`), staleness/kicks, schema reconciliation, relation indexes, row derivation, linking choreography, the one `SourceError`. |
| `core/dataEngine/sources/nextcloudTable/` | The Nextcloud Tables ADAPTER (`managed_kind = 'nextcloud_table'`): `adapter.js` answers the engine's questions in Nextcloud's terms (the linker's API, columns → fields, a row's cells, the `nc` relation label), plus what only this source has — the REST client, the cell codec, push-event patching, the linking dialog's linkable/describe. `sync.js` / `writeThrough.js` are `makeSync` / `makeWriteThrough` over it, keeping every export their callers and tests knew. |
| `core/dataEngine/sources/spreadsheetFile/` | The spreadsheet-file ADAPTER (`managed_kind = 'spreadsheet_file'`): one worksheet of an xlsx/csv/ods/Google Sheet in Google Drive, OneDrive or Nextcloud Files, same engine, same routes (`/:id/source/*`, `routes/datatablesSpreadsheets.js`). Row identity from a key column or the row number; a cheap version-marker probe before any download; write-through edits the file in place. `providers/` (Drive+Sheets, Graph incl. the Excel workbook API, WebDAV) behind one FileApi, `formats/` (SheetJS read, exceljs in-place edit, a byte-faithful csv rewriter), `infer.js`/`columns.js`/`identity.js` for the header row, and `events.js` for the connector's `file.*` push and the OneDrive drive-wide hint. |
| `core/dataEngine/` | The user-defined-table engine: field/filter/aggregate vocabulary, per-dialect DDL, stable-id migration planning, and `queryCompiler.js` — **the only place SQL is generated** from a validated table descriptor plus a closed-vocabulary request. Shared by App Studio apps and automation datatables; it lives in core precisely because two features need it and neither may require the other. `appStudio/queryCompiler.js` and `appStudio/dataModel/*` are re-export shims over it. |
| `core/dlp/` | Data-loss prevention: scanning, decision queue, ledger. |
| `core/kb/`, `core/rerank/`, `core/embed/` | Retrieval: ingestion, embedding, reranking. |
| `core/memory/`, `core/conversation/` | Long-term memory and conversation shaping. |
| `core/meetingNotes/`, `core/voice/` | Audio capture, transcription, summarisation. |
| `core/markdown/`, `core/seo/`, `core/cms/`, `core/swarms/`, `core/customIntegrations/` | Supporting domains. |

### Grouping the flat files — done

`core/` accumulated ~97 loose `.js` files at its top level. That listing is the
single biggest obstacle to reading this module: nothing about it says which
files belong together. They were grouped into the folders above, a domain at a time.

- **Done.** The flat level is now 22 files, and every one of them is a
  top-level entry point rather than a stray: `aiAgent`, `automationRunner`,
  `aiTaskRunner`, `executionEngine`, `mcpManager`, the two event buses, and a
  handful of small shared helpers. Everything else lives in a named folder:

  `core/llm/` · `core/providers/` · `core/agentRuntime/` · `core/automationRunner/`
  `core/privacy/` · `core/dlp/` · `core/documents/` · `core/tools/` · `core/kb/`
  `core/rerank/` · `core/embed/` · `core/memory/` · `core/conversation/`
  `core/entitlements/` · `core/integrations/` · `core/http/` · `core/text/`
  `core/cms/` · `core/cad/` · `core/webpages/` · `core/cowork/` · `core/seo/`
  `core/swarms/` · `core/meetingNotes/` · `core/voice/` · `core/markdown/`
  `core/customIntegrations/` · `core/dataEngine/` · `core/datasets/`
  `core/findings/` · `core/scheduling/` · `core/skills/`

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
| `db.js`, `migrations/` | Postgres access; `migrations/` holds the loose data migrations and NL catalogues that `boot/bootMigrations.js` runs and records in `schema_migrations`. Store DDL lives in the store itself. |
| `boot/` | Start-up: the migration ladder and its ledger, feature gates, security headers, request timing, background start-up tasks. |
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

`automation/` · `cmsBuilder/` · `compliance/` · `learning/` · `support/` ·
`integrations/` · `mcpServers/` · `appStudio/` · `services/` · `jobs/` ·
`workers/` · `playbooks/` (phased AI builds — the recipe DOCUMENT
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

`layering.test.js` walks every `require` in the package and asserts the arrows
point downward. Two of its checks assert zero (core never requires a feature;
no feature requires another). Three pin a **baseline** instead, because the debt
is real and fixing it is its own piece of work — they fail when the number
grows, never when it shrinks:

- **0 upward edges into `routes/`**, and the baseline is pinned there. The six
  were the support feature reaching into `routes/support` for helpers that were
  never HTTP, and the MCP token CLI loading `routes/mcpServer` for its signer;
  both sets of functions now live below the route that used to hold them.
  `index.js` is exempt — mounting routers is its job.
- **9 edges in a `license/` ↔ `modules/` cycle.** Legal within one layer, still
  a smell.
- **56 platform → core/feature edges**, capped at that count. Down from 200:
  the HTML sanitizer, the field envelope, `appPaths`, `buildInfo`, the request
  client context, the HTTP metrics, the at-rest encryption policy, the
  unattended-OAuth resolver and the geo resolver were platform modules filed
  under `core/`, and moving each one down removed every edge into it.

  The last step from 85 to 56 moved no code at all — it corrected two labels,
  the same way `license/` and `modules/` were corrected before. `core/
  entitlements/` answers the tier-and-capability question those two answer and
  is classified with them; and the 35 Express routers inside `auth/` are API
  surface, so `layering.test.js` now classifies a path rather than just its top
  directory (see `layerOf()` there). `auth/index.js` joins the root `index.js`
  as a composition root, because wiring routers together is its whole job.

  That second label had a concrete cost. `core/http/validate` lives under
  `core/`, so a single zod schema in an auth router read as a platform → core
  violation — and with the guard sitting exactly at its baseline, that put all
  29 unvalidated auth routes out of reach until the label was fixed.

## Conventions

- **Tests sit next to their source** (`x.js` ↔ `x.test.js`), never in a central
  `tests/` directory. `npm test` runs `scripts/run-tests.mjs` over all of them
  (minus the documented exclusions in `scripts/test-exclusions.json`); a single
  file is `node --test --test-force-exit path/to/x.test.js`. Without
  `--test-force-exit` the run hangs on files that keep a handle open.
- **A file's folder is its documentation.** If you cannot name the folder a new
  file belongs in, the design question is not yet answered.
- **Personal data does not leave the product, except over email.** Anything in
  `integrations/` that posts outward carries a record reference and nothing more —
  never a name, address, organisation, verbatim customer text or attachment. Build
  the payload from an explicit allow-list of fields rather than by deleting keys
  from a row, so a column added later cannot leak by default. Email is the one
  exception, because there the data goes to the person it is about. Reading *in*
  from a third party is unconstrained. Full rule: CLAUDE.md → Security.
