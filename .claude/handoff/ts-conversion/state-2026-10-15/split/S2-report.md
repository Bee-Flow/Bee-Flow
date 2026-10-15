# S2 report: admin compliance, modules, product website, org (batches 13–17)

- Branch: `ccr-ccac4823-i270ro`
- BASE: `9c28cceaa` = `origin/ccr-28820270-xkvwp8` (a3afd896) + `--no-ff` merge of `origin/ts-local/prep2` (fe97b2c6)
- Integration base: `80112891` = BASE + `--no-ff` merge of `origin/ccr-28820270-xkvwp8` @ 95b13ce7 (wave1, duplication and serverClosure fixes, at the integrator's request). The batch branches gate against BASE `9c28ccea`; the files in scope are identical in both.
- Final commit: (filled at each push)

## Baseline measured on BASE (before any S2 work)
- check:fast 39/39 pass; server typecheck 0 errors; gitleaks clean.
- **Duplication is already red on BASE: production 15423 against a budget of 15419 (+4).** The convert branch alone
  measures 15379; prep2 adds +44, all from `agent-hub/src/components/admin/Studio/AppStudio/runtime/resolveBinding.ts`
  (now text-identical to `mobile/src/features/app-studio/core/runtime/{resolveBinding,paths,dataKeys}.ts`; the
  `.js` clone with `server/services/appStudioRender.js` drops out). Studio is b2-owned, so S2 does not touch it:
  integrator, turn the mobile port into a mirror entry. Fixed upstream at 95b13ce7 (merged, see above): 15375 ≤ 15419.
- ts-ratchet agent-hub: 2438 .js/.jsx (budget 2443).

## Batches

### 13 + 14 (admin/compliance, admin/modules), branch `s2/compliance`, merged
- Converted: b13 7/37, b14 26/54, pass 2 +2 (SeverityTag, VerificationChip) → 35 converted. auditForms.js stays JS (b2).
- Gate: b13 types `7 identical, 0 different of 7`; b14 types `25 identical, 0 different of 25`; pass 2 `2 identical, 0 different of 2`;
  overall vs BASE after the review fixes `33 identical, 2 different of 35` (the 2 = catch commits: QuestionnaireImport,
  SideloadDialog; token substitutions only, Opus-confirmed equivalent). No D/A pairs.
- Kept JS, b13: blocked by b2 (DataTable.jsx): DsrTable, CustomChecksTable, CheckRow, CheckExpansion, ChecksTable, EvidenceTab,
  PerAutomationTab, IncidentsTable, MachineryPage, PoliciesPage, PortabilityPage, RopaPage, SoaPage, TrainingPage, AuditsTab,
  NcsTab, ObjectivesTab, ReviewsTab. Blocked by b2 (SideDrawer.jsx): DsrDrawer, ConnectorDrawer, AttestDrawer,
  FrameworkEditorDrawer, IncidentDrawer. Blocked by shared/RegulatoryCalendar.jsx: TimelineTab, OverviewPage. Blocked by
  RisksTable.jsx (→ b2 DataTable): RisksPage. runtime: dsrArticles.js (`.includes(row?.status)` on nullish fields);
  SettingsPage (`update()` reads `.displayName` off an unknown form value in the `__fill_dpo__` branch).
- Kept JS, b14: blocked by b2: DeadlinesCard (DeadlineClock), RiskDrawer/SoaDrawer (SideDrawer), RisksTable/SoaTable (DataTable),
  SettingsGroup (auditForms), PolicyDrawer (SideDrawer, auditForms). Blocked by batch files kept JS: UpcomingDatesCard
  (RegulatoryCalendar), AttentionList (ArticleRef), FrameworkScoreCard (ScoreRing, MiniBars). Blocked by monitoring/shared.jsx
  (batch 15): monitoring ActivityPage, OverviewPage, TerminationsPage. runtime: sections.js (`Map.get(k)` deref), soaThemes.js
  (`.map(Map.get).filter(Boolean)` element type), ArticleRef (`max > 0` on optional max), MiniBars/ScoreRing (`TONES[tone]`, tone
  optional without default), RegulatoryCalendar (`Math.abs(daysUntil())` on number|null), TimelinePhases, calendarMath,
  miniBarsMath, incidentClocks (null/Date arithmetic), modules/index.jsx (clearTimeout on a null-initialised ref),
  moduleActions (nullable `installing.name`; `.status`/`.body` on a typed Error), MarketplaceTab (`.body.details.detail` beyond
  the catch recipe; BASE's body.detail follow-up untouched).
- Review: `reviews/S2-compliance.md` (both CHANGES REQUIRED, small; all required + recommended applied in one fix commit).
- Watch at merge: the mobile `src/features/compliance/model/lockstep.test.ts` reads `settingsFields.ts` now; new
  `settingsFields.types.ts`; `.file-budget.json` key renames; `i18nGuard.test.js` path edit; `OrgUser` has 4 definitions
  across the tree (unify later); b13 types commit c2698ab9 alone does not typecheck (QuestionnaireImport), fixed by 4768fda3.
