# PR description (draft, kept current by the integrator; used when the PR is opened)

## Why TypeScript

agent-hub (the React frontend) moves from JavaScript to TypeScript. The server stays JavaScript by design.

**What it buys us**
- **Mistakes surface at build time, not in production.** A wrong prop name, a missing field or a value that can be
  `null` is a compile error instead of a blank screen or a silent wrong answer for a customer. The conversion itself
  proved the point: once `resolveBinding` was typed, 16 App Studio call sites turned out to pass values the resolver
  did not expect, and a record-detail field formatter was narrower than the data it really receives.
- **The contract with the server is written down.** Response shapes (support inbox, probes, approvals, datatables, …)
  are now types that the Opus reviews checked field by field against the server routes; fields the server can leave
  empty are `| null` or optional, so the UI must handle them.
- **Refactors become safe.** Renaming a field, splitting a 600-line component or changing a hook's return shape now
  shows every place that breaks. The long-function splits in this branch relied on that.
- **Errors are read honestly.** A caught error is `unknown` in TypeScript; `agent-hub/src/utils/caughtError.ts` reads
  `message`/`status`/`code` without throwing on odd values, instead of `e.message` on whatever was thrown.
- **Web and phone share one implementation where they should.** Typing exposed web↔mobile copies that had drifted into
  hand-maintained twins; several are now generated mirrors (`scripts/shared-mirror.manifest.json`), so a fix lands on
  both platforms at once.
- **Faster onboarding and better tooling.** Editors autocomplete props and API fields, and new contributors read the
  shape of the data from the types instead of from the call sites.

**Why it is safe**
- Every type-only conversion is checked by `scripts/ts-equivalence.mjs`: the old `.jsx` and the new `.tsx` are compiled
  to JavaScript and must be identical. For those files the shipped code did not change, only its description.
- Code changes that typing needed are separate commits: caught-error token substitutions (reviewed as such), a small
  number of runtime-equivalent rewrites (each with an equivalence argument and a test that passes before and after),
  and bug fixes with their own tests.
- No `any`, `@ts-ignore` or `@ts-expect-error` were added. A file that could not be typed honestly stayed JavaScript,
  byte-identical. [INTEGRATOR: fill in after fix-b2/fix-b3 land: the final review (reviews/final-1-agent-hub.md) found
  ~165 caught-error casts, 9 non-null `!` and ~51 `as unknown as` shims over modules that are now TypeScript; state the
  counts that remain vs main and where (the boundary shims over still-JS modules are listed as follow-up).]
- `scripts/ts-equivalence.mjs` now checks every rename in a range (it silently checked 28 of 1,310 on main..convert
  before the rename-limit fix); the final run over the whole PR is [INTEGRATOR: result].
- Not type-only, and called out here so it gets a look: the inline-style sweep (`style={{…}}` from 9,313 to 5,647)
  moves static styles to Tailwind classes on the same theme variables. A scan of the 4,857 added classes found no
  precedence conflict; it has no visual review.

**Why the server stays JavaScript**
The server is CommonJS (~3,400 files). It already gets most of the benefit through `// @typecheck` + JSDoc
(`cd server && npm run typecheck`), without a rewrite that would touch every `require`/`module.exports`. Its structural
work in this branch (5xx handling, import cycles, long functions) is in JavaScript.

**Where we end up**
agent-hub non-test source: 63% TypeScript at the start of this round, ~83% now; the rest is either a file with a
react-hooks eslint exception (stays JS by rule) or listed as follow-up because it needs a small runtime change first.

## Behaviour changes (client-visible)

**Error contract (server)**
- An unexpected 5xx answers `{ error: 'Internal server error', correlationId }`; ~350 route-specific 500 sentences are
  gone. A deliberate one (`HttpError`) answers `{ error, code, details?, correlationId }`. No client compares against a
  removed `error` token (checked in agent-hub, mobile, desktop and nextcloud-connector).
- Exceptions kept on purpose: the anonymous public form routes keep the sentence visitors read before ("That app could
  not be searched", "Could not accept this submission", …) as a 500 `HttpError` with its own `code`. The App Studio data
  routes answer a generic 500 for anything that is not an `HttpError`, as before.
- Moved under `details`: `retry_after` (entitlement/tier 503s; the `Retry-After` header stays), `detail`
  (hub_unavailable), `messageId` (support reply send failure), `event_id` (Stripe webhook, still 500 so Stripe retries).
- Gone: `message` on compliance not_provisioned / notify_failed (the sentence is `error`, the token `code`), `{enabled:false}`
  on the voice-availability 500 (`availability_failed`), `valid:false` on the invite-validation 500, `ledger_unavailable`
  on the Stripe webhook (generic 500), `detail` on mcp_registry_unavailable.
- The error log names the route pattern (`/api/auth/invite/:token`), never a token in the path or query.

**Spreadsheets (feat/164, the chart-data-loss fixes)** [INTEGRATOR: move this block to the top of the PR body]
- Adding, renaming or removing a tab keeps the sheet's charts; removing a tab removes the charts pinned to it; orphaned
  charts are cleaned on the next tab write. Duplicating a sheet copies its charts.
- Chat `document_write` updates only charts on its tab, refuses an id updated twice or both updated and removed, counts a
  repeated `removeCharts` id once against the 40-chart cap, and returns `chartIds`.

**Meeting notes (#158, #159, #160)**
- A personal "record" mark imports a Teams meeting even with autoImport off; new `processing` recording state; the
  no-recording deadline goes from 24 h to 48 h; Teams/Meet/Talk imports honour the Azure engines; Google Meet is no longer
  pinned to WhisperX, so its audio goes to the speech-to-text provider the admin configured.

**Knowledge bases (#162):** `GET /:id/sources` adopts source-less documents of that KB (a write on a GET, under a per-KB lock).

**Automations (#175):** a dry run that reads a file a simulated step would have created gets a sample instead of failing.

**Lint:** `react-hooks/rules-of-hooks` now runs on agent-hub TypeScript source.
