CHANGES REQUIRED (one small type fix; everything else approved)

# Opus review S3 batch 18 (s3/b18: cc002b55 types + d8ec7343 catch recipe), base b36ec171

## Gate results
- `ts-equivalence b36ec171 cc002b55 --diff`: 39 identical, 0 different of 39.
- `git diff -M40% --name-status`: there are no D/A pairs with the same stem. The non-rename changes are
  A `plans/planTemplates.types.ts` (new type home), D `ui/typedUi.ts`, M access/{AccessView,GeoRestrictions,SignupToggles,WaitlistQueue}.tsx,
  M `i18n/i18nGuard.test.js`, M `.file-budget.json`.
- `ts-equivalence cc002b55 d8ec7343 --diff`: 7 different. Each difference is a catch-recipe token plus its import (see 2).
- Forbidden constructs in the added lines (any, as any, as unknown as, @ts-*, `!`, eslint-disable, `as Error`): none. The only `as` in the batch is the type name in JSDoc text, so there are no casts at all.
- eslint on changed files: 0 errors (23 warnings, all complexity/max-lines that existed before). check:fast: 39/39 pass. duplication-ratchet: OK (15411/15419, test 26228/26279).
  file-budget: OK, none past ceiling.
- Typecheck (head + merged): see "Typecheck" at the end.
- Merge into HEAD claude/batch-18-lf-s7-server-me5ppc (contains 95b13ce7 wave1): clean, no conflicts, and no references to the deleted typedUi or to the old paths (comments only).

## 1. ui/typedUi.ts deletion: correct
It was a shim of 7 `X as unknown as ComponentType<...>` casts over the then-JS kit (Badge, Banner, Card, SectionHeader, Spinner, Toggle, Checkbox).
Its only importers were the four access/*.tsx files, which now import the real typed components. The typed props are equal to or wider than the shim's.
Differences: Badge `tone` is now `BadgeTone` (adds sky and teal). Card extends HTMLAttributes<HTMLDivElement>, which is honest because it spreads `...rest`. Toggle `label?` is optional, which is honest because the code checks `!label && !description`.
Removing 7 `as unknown as` casts is a net gain.

## 2. Commit 2 (catch recipe): approved
Every difference is a recipe substitution: `e.message || <t()/literal>` → `messageOf(e, …)` (x9), `setError(e.message)` → `setError(errorMessage(e))`
(GrantWizard, with state `string | null | undefined`, so the user sees the same thing), and `e.body?.error` → `errorBodyRecord(e)?.error` (OrgsView).
- The commit message says "every fallback is a string literal or a t(...) call". PromosView.tsx's fallback is a ternary of two `t()` calls. That is pure and cheap, so `messageOf` evaluating it eagerly changes nothing. Accepted, but the commit message is slightly inaccurate.

## 3. Forbidden constructs and required-vs-defensive rulings
1. **orgShield/orgShieldClamps.ts:135 MUST FIX.** `const listOf = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v : [])`.
   `Array.isArray(unknown)` narrows to `any[]`, so `listOf<string>(data?.clamped_fields)` (l.150) asserts `string[]` with no element check.
   That is an `any` escape that reads like a guard. The server sends `clamped_fields` as a string[] of field names (server/routes/orgPrivacyShield.js:374), and `termErrors`/`typeErrors` as arrays.
   Fix (types only, same JS):
   ```ts
   interface SaveResponse {
       clamped_fields?: string[] | null;
       termErrors?: unknown[] | null;
       typeErrors?: unknown[] | null;
       config?: { piiDetectionAction?: string | null };
   }
   const listOf = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
   // l.150: const clamped = listOf(data?.clamped_fields);
   ```
   Then retypecheck `useOrgShield.ts:303`, the caller.
2. AuditView.tsx:19 `action: string` required while l.87/l.156 read `(log.action || '')`: **ACCEPT**. The column is `subscription_audit_log.action TEXT NOT NULL` (server/stores/user/schemaTables.js:137), so the server always sets it.
   Making it optional would break `ACTION_TONE[log.action]` (a runtime change would be needed). Optionally add a one-line comment: `// NOT NULL column; the || '' is belt-and-braces`.
3. OrgsView.tsx:26 `OrgSubscription.status: string` required: **ACCEPT**. The insert writes `data.status || 'active'` (stores/user/subscriptions.js insert path), and the zod body takes `status` as `.optional()` enum, never null.
   `STATUS_TONE[status] || 'neutral'` covers unknown values (past_due, incomplete, paused), not a missing status.
4. activityLabels.ts `surfaceLabel(row: SurfaceRow, …)` is non-null while the body uses `row?.`: **ACCEPT**. Every caller passes a row (ActivityTab.tsx:128).
   Widening to `| null | undefined` breaks the narrowing for `row.agent_name` in the first two branches, which would force a runtime change. The rule is about fields, and here only the parameter is non-null.
5. activityLabels.ts `wordFor(table, value: string | number, t)`: **ACCEPT**. A number index into `Record<string, Words>` is valid, and `String(value ?? '')` is unchanged JS. The callers' axis values are string|number.
6. AuditView.tsx:24 `readonly new_values`: **ACCEPT**. It enables TS 4.4 aliased-condition narrowing for `const hasDetails = log.new_values && …` → `Object.entries(log.new_values)`. The code never mutates it, and the runtime is unchanged.

## 4. Entitlement typing against the server
- Plans (`GET /api/subscriptions/plans` → stores/user/plans.js parsePlan):
  - The cap columns are INTEGER/REAL, nullable, and `cap()` zod is `.nullish()`. So `number | null` (null = unlimited) is honest.
  - `allowed_integrations`/`allowed_beta_features`: null = unrestricted, kept explicitly by parsePlan, so `string[] | null` is honest.
  - `allowed_models` is always an array from parsePlan, so `string[] | null` is wider than needed, which is fine.
  - `markup_percent` is coerced to a Number on the server.
  - No field is sent as 'unlimited', -1 or a numeric string.
- `LimitValue = number | '' | null` is honest. `''` comes only from LimitField's override button (`planDefault ?? ''`). NumberInput itself emits `null` on empty.
  Pre-existing note (NOT this batch): an override saved as `''` reaches `z.coerce.number()` as 0, a cap of 0. That fails closed, not open. Worth a separate ticket.
- UsageBar/StatRow treat `limit == null` / `value == null` as unlimited (∞), and `limit > 0` guards division. No typing invites `?? 0` on a limit, so I found no fail-open path.
- OrgSubscription `effective_limits` is typed as a subset of getEffectiveLimits (structural, fine). `current_usage` is always set by the route.
- `useResource` overloads (non-null data when `initial` is given): honest except for one pre-existing edge. `apiJson` returns `null` for a 2xx with an unparsable body, so `data` can become `null` at runtime.
  Callers destructure `data: x = []`, which does not catch null, so the JS behaviour is the same as the base. Non-blocking.
  Follow-up: `apiJson` returns implicit `any` (from `res.json()` via `let body = null`). Typing it `Promise<unknown>` would make every `useResource<T>` an explicit unchecked claim, which is a later batch's job.
- OrgListEntry.id is required, but OrgsView.tsx:53 filters `o.id && …`. That is a falsy check on a string, so it is accepted.

## 5. Files kept JS: all 14 byte-identical to base
These are GrantsView, OrgEditor, QuickAssignDialog, TrialOffersPanel, PlanCard, PromoEditor, FeatureCardGrid, FeaturesSection, OrgShieldEditor, orgShieldPosture, orgShieldDirty, shieldFilters, shieldRows and access/countries.
Reasons that are clearly plausible:
- countries.js: read by path by mobile `countries.lockstep.test.ts:14`.
- FeatureCardGrid: `map.get(cat).push`.
- PlanCard: `CURRENCY_SYMBOL[plan.currency]` with an optional key.
- PromoEditor: `parseInt(form.x)`.
Possibly convertible in a follow-up: GrantsView, OrgEditor, QuickAssignDialog and TrialOffersPanel. Their visible catch reads are recipe-covered (`e.message || t(...)`), and I found no other runtime blocker by grep. The drafter's per-file reasons were not available to me.

## 6. Importers outside the batch: correct and minimal
access/*.tsx only swap the import lines. The i18nGuard `rel` follows `activityLabels.ts`. The `.file-budget.json` key is renamed planTemplates.js→.ts at the same ceiling (446).
Mobile/server: no test reads a converted file by path. The mobile `clamps.ts`/`activity.ts` mention the web files only in comments.
Stale comments (nit, optional): planTemplates.ts:4 ("usePlanForm.js"), shieldRows.js:30, locationCopy.ts:5, OrgShieldEditor.jsx:47.

## Typecheck / tests
- agent-hub `npm run typecheck` (project tsconfig): head d8ec7343 exit 0; merged tree (HEAD + s3/b18) exit 0.
- vitest: guardrails/, subscriptions/, modalOverlays, OrgHealthBanner, OrgInfoPanel, useSubscriptionActions, chatModelTiers, privacyShield fixtures, i18nGuard, ConsumerLicenseSection: 57 files / 679 tests pass.
- Fix 3.1 is types only. The caller useOrgShield.ts:303 passes `res.json()` output (any), so the narrower SaveResponse cannot break it. The fix still needs one typecheck after it is applied.

## Resolution (integrator S3)
- 1: fixed in a types-only commit on s3/b18 (`fix(ts): type orgShieldClamps listOf by its input…`): SaveResponse `clamped_fields?: string[] | null`, `termErrors?/typeErrors?: unknown[] | null`, `listOf = <T,>(v: T[] | null | undefined): T[]`. Gate b36ec171..HEAD: 39 identical + the 7 commit-2 files (catch recipe); agent-hub typecheck 0 errors; orgShield vitest 41 files / 522 tests pass.
- 5 (pre-existing LimitField '' → cap 0 server-side, fails closed) and 6 (GrantsView, OrgEditor, QuickAssignDialog, TrialOffersPanel retry with the catch recipe) are listed for the integrator in split/S3-report.md.
