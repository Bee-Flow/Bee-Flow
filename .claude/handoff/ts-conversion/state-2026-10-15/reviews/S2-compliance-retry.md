# Opus review s2/b2-retry (BASE 355ae30d, tip 3fe43ca4): CHANGES REQUIRED (small, types/whitespace only)

The compiled program is identical to BASE for all 10 conversions and all 6 edited TS files, and nothing is unsafe at runtime. Two things block the merge:
- `check:fast` is red: `lint:long-function-ratchet` reports 270 against a budget of 269. The cause is one stray blank line.
- An untyped `new Map()` lets implicit `any` flow through CustomChecksTable.

The rest are honesty and contract nits. I applied every fix below in a scratch tree, and all of them still compile identically to the branch (equivalence checked per file).
- **With the fixes:** `npm run typecheck` 0 errors, long-function back to 269, eslint 0 errors.
- **Patch:** `/tmp/claude-0/-home-user-Bee-Flow/dd973543-099f-5ec2-9b45-66ba0a24906f/scratchpad/S2-compliance-retry-fixes.diff`. It is a scratch diff against 3fe43ca4 and was not committed.

## Gate and checks (scratch worktree of 3fe43ca4, removed afterwards)
- **Gate:** `node scripts/ts-equivalence.mjs 355ae30d s2/b2-retry --diff` reports `10 identical, 0 different of 10 converted files`.
- **D/A pairs:** `--name-status -M40%` shows only R/M entries plus 2 A entries (`dsr.types.ts`, `ropa.types.ts`, types only), so there are no pairs to check.
- **Edited existing TS files:** I transpiled the parent and the new version with the gate's own `compile()`. All 6 are identical: FrameworkCandidateCard, StatusPill, useCmsSiteOps, MicrosoftIdentityPanel, guardrailsApi, compliance.server.test.ts.
- **Kept-JS files:** the diff has no `M` on any `.js`/`.jsx`, so every retried file that stayed JS is byte-identical to 355ae30d.
- **Forbidden constructs:** none in the added lines (`any`, `as any`, `as unknown as`, `@ts-*`, non-null `!`, new eslint-disable). The only `as`/`any` hits are inside comments.
- **Typecheck:** agent-hub `npm run typecheck` gives 0 errors.
- **eslint** on the 18 changed files: 0 errors, 19 warnings (max-lines-per-function and complexity, all from the existing code).
- **Ratchets:**
  - duplication: production 15315 (budget 15383), test 26228 at budget.
  - ts-ratchet: 2079 against 2230.
  - file-budget: none past its ceiling.
- **`npm run check:fast`: 38 passed, 1 FAILED, `lint:long-function-ratchet`** (agent-hub 270 > 269). See finding 1.
- **`cd agent-hub && npm run lint:dead`** (knip): clean.
- **vitest** (`src/components/admin/compliance`, `product-website`, `security`): 163 files and 1920 tests pass.
- **mobile jest** (`src/features/compliance`): 9 suites and 125 tests pass.

## Findings

1. **REQUIRED: check:fast red, long-function ratchet.**
   - **Cause:** agent-hub/src/components/admin/compliance/pages/PortabilityPage.tsx:207 has a blank line inserted directly after `renderRow={(row: PortabilityRow, ctx: DataTableContext) => {`.
   - **Effect:** in BASE, `PortabilityPage` ran from line 65 to 264, exactly 200 lines. That one blank line makes it 201, and it joins the list (`--list` diff: +PortabilityPage.tsx).
   - **Fix:** delete that blank line. The ratchet is then at 269, at budget.
   - **Same artifact elsewhere:** it is cosmetic in the other places, but remove them all so they cannot push another function over 200:
     - NcsTab.tsx:306 (after `renderRow={(nc: Nonconformity, ctx: DataTableContext) => {`)
     - CustomChecksTable.tsx:338 (after `renderRow`)
     - DsrTable.tsx:245 (after `renderCard`)
     - PerAutomationTab.tsx:143 (after `renderRow`)
     - IncidentsTable.tsx:179 (after `renderCard = (…): ReactNode => (`)
     - RisksTable.tsx:204 (after `renderCard`)
   - **Two lines split by the drafter's tooling:**
     - RopaPage.tsx:339-340 `const ok\n = isConfirmed(...)`: rejoin to `const ok = isConfirmed(p.operator) || !!p.scc_confirmed;`.
     - ObjectivesTab.tsx:135-136 `const toggle = (o: Objective) => {\n setCreating(false); …`: rejoin onto one line, as in BASE.

2. **REQUIRED: implicit `any` through the untyped `new Map()`** in agent-hub/src/components/admin/compliance/pages/custom/CustomChecksTable.tsx.
   - **Problem:** both maps are `Map<any, any>`.
     - In `indexResults` (line 85), `index.get(...)` in `joinChecks` returns `any`. So `result` in every `JoinedCheck` is claimed `CustomResultRow | null` without the compiler seeing it.
     - In `groupBuiltinChecks` (line 104), `list`, `c`, `[a]` and `[b]` in the `.sort/.map` chain are all `any`.
   - **Fix (verified: typecheck 0 errors, compiled output identical):**
     ```ts
     // line 85
     const map = new Map<string, CustomResultRow>();
     // line 104
     const groups = new Map<string, BuiltinCheck[]>();
     // line 108 — present by the has/set on the line before (the guard at the site)
     (groups.get(code) as BuiltinCheck[]).push(c);
     ```
   - **Contract note:** the brief lists `Map.get(k).push` as a "stay JS" construct. The `as` above removes `undefined` behind a guard on the immediately preceding line, which the brief allows ("only with a runtime guard at that site").
   - **If you read the contract strictly:** revert CustomChecksTable to JS. Do not keep the untyped Map, which is the worst of both: the `any` is invisible to the forbidden-construct grep.
   - **Related, for the next shared pass:** RisksPage.jsx:80 and AuditsTab.jsx:57 have the same construct.

3. **REQUIRED (contract: "types never between JSDoc and the code it documents").** In ObjectivesTab.tsx:29-49, `ObjectiveDraft` and `ObjectivesTabProps` were placed under the `/** ObjectivesTab — security objectives … */` block. That block now documents an interface. Fix: move both interfaces above the `/**` block (NcsTab does it correctly).

4. **Recommended: IncidentRecord is incomplete** (IncidentsTable.tsx:19-36). The comment says it is "typed from stores/incidentStore.js", but it leaves out columns that incidentClocks.js reads from the same row:
   - `regimes`
   - `deadline_at`
   - `authority_notified_at`, `authority_reference`
   - `early_warning_due_at`, `early_warning_sent_at`
   - `notification_due_at`, `notification_sent_at`
   - `final_report_due_at`, `final_report_sent_at`
   - `customer_notice_due_at`, `customer_notified_at`
   - `subjects_notified_at`
   - `reported_at`, `reported_via`

   It compiles today only because incidentClocks.js is JS (`any` params). Add them as optional now (`regimes?: string[] | null`, the timestamps `?: string | null`, `authority_reference?`/`reported_via?: string | null`), so this stays the single home when incidentClocks converts.
   - **Honest as written:** `title`/`severity`/`status` required match `TEXT NOT NULL` (schema lines 69/71/74) and `VALID_STATUSES` equals `keyof typeof STATUS_LABEL` (7 words, same set).
   - **`IncidentStatusPill({ status: IncidentStatus })`** reads `|| STATUS_LABEL.open` defensively, but optional would break the `STATUS_LABEL[status]` index (same precedent as SeverityTag). Accept it.

5. **Recommended: one home per shape.**
   - **Column type:** `RiskColumn` (RisksTable.tsx:26-32) and `IncidentColumn` (IncidentsTable.tsx:39-45) are the same shape `{ id; width; labelKey; fallback; foldBelow? }`. Export one `RegisterColumn` (for example from RisksTable.tsx, or a `compliance/shared/registerColumn.types.ts`) and import it in the other.
   - **Pill-entry type:** `StatusPillEntry` (CustomChecksTable.tsx:51) and `OutcomePill` (PerAutomationTab.tsx:27) differ only in `key: string` vs `key: string | null`. Leave them separate (the null is real), or name one `PillEntry<K>`. Optional.
   - **RiskTreatment** (RiskDrawer.tsx:13-20) sits in RiskDrawer, while RisksTable types the same rows as `readonly unknown[]` (line 152). Fix:
     - Move `RiskTreatment` next to `RiskRow` in riskDraft.ts.
     - Type `treatmentsByRisk?: ReadonlyMap<number, readonly RiskTreatment[]> | null`.
     - Import it in RiskDrawer.

     That gives one home and no type cycle.

6. **Nit: hidden claims at the JS boundary** (no syntactic cast, same category as the earlier nit 9 about `asArray`):
   - PortabilityPage.tsx:97 `const rows: PortabilityRow[] | null = res.data;` (`useResource.js` returns `any`).
   - PerAutomationTab.tsx:74 `const rows: AiActAssessment[] = Array.isArray(assessments) ? assessments : [];` (`aggregates.js`, so `any[]`).

   Both shapes match the server (`exportRegistry.coverageMatrix` lines 379-391; `routes/compliance/aiAct.js:100-109`), and every read is null-tolerant, so accept them. Add a one-line comment at each: `// shape of <route>; useResource/aggregates are JS, so this is the boundary claim`.

7. **Nit: DsrRow** (dsr.types.ts):
   - All fields optional except `id`. That matches the defensive readers in dsrArticles.js, which is the brief's rule.
   - Missing `days_left?: number | null`, which `listRow` sends (routes/dsr.js:165).
   - The comment should say `received_at` is not a server column: it is only read for client/demo rows, and the server stores it as `created_at`.
   - Use `interface` rather than `type` for consistency with the other row types. That also stops the implicit index signature from hiding a weak-type mismatch later.
   - The mobile `DsrRequest` (mobile/src/features/org/model/types.ts:93) is a separate package, so it is not a duplicate.

8. **Honest as written, no change:**
   - **RiskRecord** `title`/`status` required: `iso_risks.title/status TEXT NOT NULL` (riskStore.js:28/34). `score` is NOT NULL but optional (lenient; `scoreOf` reads it defensively).
   - **RopaActivity / RopaProcessor / RopaBody:**
     - `transfers: string[]` required: every producer sets it (ropa.js:105/171/193/213; datatable/project/chatMonitoring activities).
     - `critical`/`country` are `| null` per the `processorRows` mapping.
     - `error?: boolean` matches registers.js:92 `{ error: true }`.
     - `scc_confirmed_operators` as objects matches settings.js:116-124; the `|| o` string tolerance in `sccConfirmedSet` is unchanged runtime.
   - **PortabilityRow:** field for field equal to `coverageMatrix`.
   - **CustomCheck:** equal to `compliance_custom_checks` (ref/title/severity NOT NULL; `mapped_check_id` nullable).
   - **AiActAssessment:** equal to the route allow-list; `outcome` is `TEXT NOT NULL`.
   - **Nonconformity** (`id: string | number`, `title` required) matches `iso_nonconformities`. It reuses `NcEdit`/`NcPatch`, `Objective`/`ObjectiveStatus` and `OrgUser` from existing homes; OrgUser's 4 homes are still the integrator's follow-up.
   - **`extends RowLike`** on AiActAssessment, PortabilityRow, RopaActivity and RopaProcessor works around TS weak-type detection. DataTable's `Row extends RowLike` needs at least one shared property. It adds only an optional `id` the rows never carry. Each of these tables passes its own `rowKey` (PerAutomationTab:102, PortabilityPage `r.kind`, RopaPage:249/309), so no default key ever reads the absent `id`. Nothing is hidden.
     - Cleaner later: give DataTable an overload where `rowKey` is required when `Row` does not extend RowLike. That is out of scope here.

## The AuthFetchOptions fix (3fe43ca4)
- **Correct.** helpers.types.ts:4 has `AuthFetchOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }`, and authFetch merges headers by object spread. A `Headers` instance or tuple array would be lost silently, so the narrower type is the true contract.
- **Callers:** the three callers compile with plain-object headers (useCmsSiteOps builds `{ 'Content-Type': … }`, or none for FormData).
- **Other TS files:** the full typecheck is clean. Every other TS `RequestInit` in agent-hub either does not reach authFetch (analyticsApi, demoTransport, learnMedia, publicAppTransport) or already `Omit`s `headers` (webpagesApi, notebookApi, client.ts `JsonResourceInit`). No other site is affected.

## Kept-JS reasons (spot-checked)
- **CheckRow / SoaTable / SoaDrawer / DeadlinesCard, "blocked by ArticleRef.jsx": valid.** `<ArticleRef>{x}</ArticleRef>` (CheckRow.jsx:144/248, SoaTable.jsx:113/140) omits `refs`. The JS-inferred props make `refs` required, so the TSX fails. Converting ArticleRef with `refs?` unblocks all four. Next shared blocker.
- **ChecksTable, "PILL_TONE in checkSort.ts": valid but not the only blocker.**
  - The honest types-only tightening is `export const PILL_TONE: Readonly<Record<string, 'neutral' | 'success' | 'warning' | 'error' | 'muted'>> = Object.freeze({…})` in checkSort.ts:119. `'muted'` is FilterPills' fifth tone, not a `Tone`.
  - I verified it compiles identically with typecheck at 0 errors; it is included in the patch, and you may drop it from this branch.
  - ChecksTable also renders CheckRow.jsx (ArticleRef-blocked) and imports FilterPills.jsx, so it converts after ArticleRef.
- **CheckExpansion / EvidenceTab / MachineryPage, "asObject/ofSubject return types": valid.**
  - `asObject` returns `object | null`, so field reads fail. Tightening it to `Record<string, unknown>` needs a guard, which is a runtime change.
  - `ofSubject` can be made generic as types only: `ofSubject<T extends Record<string, unknown>>(rows: T[] | null | undefined, scopeId: unknown, field = 'scope_id'): T[]`. That unblocks CheckExpansion's history/evidence lists once their element types exist.
- **AttestDrawer / FrameworkEditorDrawer, "catch passed to a reader of `.error`": valid.** `attestErrorText`/`editorErrorText` read `err?.code || err?.error || err?.message`. The recipe has no helper for `.error` on the error object itself, and a local type guard would change the program.
- **IncidentDrawer, "incidentClocks.js": plausible, not reproduced.** incidentClocks stays JS for `new Date(a) - new Date(b)` (lines 145/152). IncidentsTable imports the same module fine, so the drafter should name the failing expression in IncidentDrawer.
- **RisksPage ("FilterPills.jsx") and AuditsTab ("FindingRow.jsx"): the label is incomplete.** Both also contain `map.get(k).push(x)` (RisksPage.jsx:80, AuditsTab.jsx:57). That is a runtime-class construct, so they stay JS even after FilterPills/FindingRow convert, unless the guarded-`as` pattern of finding 2 is accepted.
- **"runtime" for TrainingPage, DsrDrawer, SettingsGroup (and SoaPage, ReviewsTab, ConnectorDrawer, PolicyDrawer, SettingsPage): the construct is unnamed.**
  - A grep of TrainingPage, DsrDrawer and SettingsGroup finds none of the brief's runtime constructs: Date arithmetic, `Map.get().push`, nullable ref deref, `parseInt`, `window[...]`. It also finds no react-hooks disable.
  - The JS dependencies are SettingsGroup → shared/FilterPills.jsx, and DsrDrawer → dsrArticles.js and StudioSectionHeader.jsx.
  - The brief requires `runtime: <construct>`. Name the construct per file, or relabel the file as `blocker <file>`, before these are counted as runtime cases.

## Merge
After fixes 1–3 (4–5 recommended), re-run `npm run check:fast` and the agent-hub typecheck. The patch above already passes both in scratch.

Process notes:
- The scratch worktrees `rev4/{b2r,base,fix}` are removed.
- Small logs remain in `scratchpad/rev4/` (checks.log, lf-*.txt).
- `wt/b2r` was not touched.

## Resolution (S2, commit on s2/b2-retry after 5f1e177a)
Required 1 and 3 applied from the reviewer's patch (blank/split lines; ObjectivesTab interfaces). Required 2: CustomChecksTable
reverted to JS byte-identical to 355ae30d (strict reading of the `Map.get(k).push` rule) instead of the guarded cast.
Recommended 4 (IncidentRecord clock columns, optional) applied. Not applied: 5 (RiskColumn/IncidentColumn, RiskTreatment home),
PILL_TONE typing, nits — left for a later round. Final: `ts-equivalence 355ae30d HEAD` 9 identical, 0 different; typecheck 0;
check:fast 39/39; vitest compliance 91 files / 1141 tests pass.
