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

## Summary (final)
| Batch | Converted | Still JS | Review |
|---|---|---|---|
| 13 compliance pages | 7 / 36 | 29 (23 blocked by b2 DataTable/SideDrawer) | reviews/S2-compliance.md |
| 14 compliance shared, modules, monitoring | 28 / 54 | 26 | reviews/S2-compliance.md |
| 17 product-website builder, admin/security | 44 / 60 | 16 | reviews/S2-product-website.md |
| 16 analytics, block editors | 30 / 46 | 16 | reviews/S2-product-website.md (+ S2-org-website.md for retried sections) |
| 15 org, product-website panels, analytics charts | 27 / 43 | 16 | reviews/S2-org-website.md |
| **Total** | **136 / 239 (57%)** | 103 | three Opus reviews, all fixes applied |

Ratchets measured on the final tree (no --update run): ts-ratchet agent-hub 2095 (budget 2230); file-budget ok (1 ceiling can
come down); duplication and the count ratchets: see the push-3 gate line below; every `check:fast --list --slack` ratchet at
slack 0 except where noted by the integrator's budgets.

Retry list once b2-A lands (DataTable, SideDrawer, DeadlineClock, auditForms → TS): b13 DsrTable, CustomChecksTable,
CheckRow, CheckExpansion, ChecksTable, EvidenceTab, PerAutomationTab, IncidentsTable, MachineryPage, PoliciesPage,
PortabilityPage, RopaPage, SoaPage, TrainingPage, AuditsTab, NcsTab, ObjectivesTab, ReviewsTab, DsrDrawer, ConnectorDrawer,
AttestDrawer, FrameworkEditorDrawer, IncidentDrawer, RisksPage; b14 DeadlinesCard, RiskDrawer, SoaDrawer, RisksTable, SoaTable,
SettingsGroup, PolicyDrawer.

Latent JS bugs seen (not fixed, types-only scope): analytics HeatmapSection reads `scrollReach.pageW` that `toScrollReach`
never returns; RoadmapEditor passes `checked=` to the fields Toggle whose prop is `value`.

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
- Full gate at the merge (push 1): check:fast 39/39; server typecheck 0; duplication 15375 ≤ 15419; gitleaks clean; agent-hub
  typecheck 0, vitest 1836 files / 21619 tests pass; mobile jest 762 suites / 13430 pass, tsc 0; server npm test 28933 pass,
  0 fail (28964 tests, 2584 files, no HUNG).
- Watch at merge: the mobile `src/features/compliance/model/lockstep.test.ts` reads `settingsFields.ts` now; new
  `settingsFields.types.ts`; `.file-budget.json` key renames; `i18nGuard.test.js` path edit; `OrgUser` has 4 definitions
  across the tree (unify later); b13 types commit c2698ab9 alone does not typecheck (QuestionnaireImport), fixed by 4768fda3.

### 17 + 16 (product website builder, block editors, analytics; admin security), branch `s2/batch-16` (on `s2/batch-17`), merged
- Converted: b17 44/60 (incl. blockEditors/shared.tsx via an Opus-approved pure move of GroupedItemsField into a new
  GroupedItemsField.jsx, re-exported; net ts-ratchet 0), b16 27/46 (incl. analytics/ui.tsx). New type homes:
  primitives.types.ts, analytics/ui.types.ts, blockEditors/editorProps.ts, HeaderEditor.types.ts.
- Gate: b17 types `35 identical, 0 different of 35`; shared move+convert `1 identical, 0 different`; b16 types `27 identical,
  0 different of 27`; overall vs BASE `62 identical, 10 different of 72` (9 catch files + shared.tsx minus the moved
  function). Review-fix commit: transpile of the 28 touched files parent vs fix, 0 differences.
- Catch commits: b17 8 files (`// behaviour:` bare `setError/toast.error(err.message)` → `messageOf(err, '')`: '' instead of
  undefined, both render as no text; toast.error requires a string), b16 PricingEditor.
- Kept JS, b17: runtime: googleFonts.js (push of possibly-undefined entry), localeMerge.js/translatable.js/previewContent.js
  (untyped JSON indexing), pageIO.js (`e.target.result` to JSON.parse), AddBlockDialog (`out.get(k).push`), security/guardrails/
  Info.jsx (FieldHint title string|null into a button title), useCmsBlockEditing/useCmsContentMutations/useCmsPagesTemplates
  (`.blocks.map`/`.pages.map` on optional), useCmsBuilderBridge (`includes(nullable)`). Blocked: PageInspector (utils/
  cmsPublicRouting.js `= null` defaults; blockEditors/catalogue string index), ChromeInspector (CookieBannerEditor/
  AnnouncementEditor `locales = null`), SecurityHub (admin/shared/HubScaffold.jsx `titleFor` required), GuardrailsHub
  (guardrails/overview/HealthBanner.jsx, StatStrip.jsx), useCmsPreviewBridge (previewContent.js).
- Kept JS, b16: react-hooks disable: useAnalyticsQuery.js. Blocked: ContentEditor (marketing/sections/contentMigration.ts
  ContentElement), VariantPicker (blockEditors/blockData.generated.mjs string index), FeatureDemoEditor (demo/registry.js),
  ArchitectureEditor (GroupedItemsField.jsx `groups = []` → never[]). runtime: HeatmapSection (reads `scrollReach.pageW`
  that `toScrollReach` never returns — latent JS bug), BehaviorSection (`Map.get().days.set`), SettingsSection (null fetch
  result deref), CmsAssistantPane (`?.length > 0`), RoadmapEditor (passes `checked=` to Toggle whose prop is `value` —
  latent bug), ShowcaseEditor (`includes(undefined)`). Sections retried in batch 15 (see there).
- Review: `reviews/S2-product-website.md` (both CHANGES REQUIRED, small; all required + most recommended applied in 06fe267f,
  re-signed as f627c205). Security code: API shapes match orgRoutes.js, encryptionAvailability.js, microsoftBindingRoutes.js,
  orgPrivacyShield.js; no logic change.
- Out-of-scope edits (types only): `export` on `PublicPlan` (marketing/sections/PricingSection.tsx) and `CmsSeo`
  (marketing/useCmsHead.ts); existing TS cmsPanelTypes.ts (`CmsPageSeo`, `seo?`) and panelView.ts tightened.
- Full gate at the merge (push 2): check:fast 39/39; server tc 0; duplication 15324; gitleaks clean; agent-hub tc 0, vitest
  1836 / 21619 pass; mobile jest 13430 pass, tsc 0; server 28933 pass, 0 fail, no HUNG.
- Integrator follow-ups: shims in product-website/blog/jsComponents.ts, fieldKit/jsDeps.ts, panel/panelJsComponents.ts still
  cast now-typed components `as unknown as` (can be deleted); generic `apiJson<T>` in guardrailsApi.ts (PatternSections.tsx
  relies on its any); duplicate block-editor shapes (SectionHeaderData, StyleBlob/TextStyleBlob, media slot ×4, CTA ×3);
  GuardStatus ×4.
- History note: the b17 types commit was unsigned (drafter worktree); the unpushed chain was re-created signed with
  identical trees before push 2 (ccdba2f7 → c5cd3a5f… ; batch-16 tip f627c205).

### 15 (admin/org, product-website panels, analytics charts/heatmap; monitoring), branch `s2/batch-15` (on `s2/batch-16`), merged
- Converted: 27/43 of batch 15, plus batch-16 sections RealtimeSection and OverviewSection retried (Pages, Sources, Replays
  retried then reverted per review: their types needed casts on JS-inferred `pivot()` / `sessionSignals` results).
  New type home: org/access/accessTypes.ts. Existing TS edited types-only (transpile identical): userManagement GroupModal,
  OrganizationModal, OrganizationsSection (`isFullAdmin: boolean | undefined`), primitives (generic SegmentedControl),
  SiteVersionMenu, cmsPanelTypes (`CmsBlock.type` required — server drops typeless blocks), analyticsApi (AnalyticsSite, url).
- Gate: types `22 identical, 0 different of 22`; catch commit 8 different (token substitutions, Opus-approved);
  after fixes vs s2/batch-16 `21 identical, 8 different of 29`.
- Kept JS: runtime: monitoring/shared.jsx and monitoring/index.jsx (Date arithmetic `now - d`), OrgInfoSection (`ncOrg.baseUrl`
  behind a flag, parent passes ncOrg|null), OrgAuthSection (updater spreads possibly-null state), useUserDirectory.js
  (`Map.get(k).push`), DesignEditor (unguarded `d.colors.x` on Record<string, unknown>), analytics/model.js (`Map.get(k) + 1`,
  find() deref), heatmap/model.js (`TYPE_LABELS[nullable]`), heatmap/PageStage (`?.length > 0`), usePreviewBackdrop
  (`clearTimeout(null)`), b16 PerformanceSection (`b.value / b.bands[0]` nullable), AudienceSection (find() deref). Blocked:
  UsageExplorerPage + b14 monitoring ActivityPage/OverviewPage/TerminationsPage (monitoring/shared.jsx), CloudCeilingEditor
  (subscriptions/plans/PlanEditor.jsx `onDelete` required), ProductWebsitePanel (useCmsPreviewBridge.js, CmsAssistantPane.jsx,
  useCmsBlockEditing.js), TranslationPanel (translatable.js), AnalyticsPanel (sections/SettingsSection.jsx `sites = []` →
  never[]), b16 PagesSection/SourcesSection/ReplaysSection (analytics/model.js). Duplication: CookieBannerEditor (typing it
  raises production duplication over budget; kept JS).
- Review: reviews/S2-org-website.md (CHANGES REQUIRED, small; applied). Org access/ceiling code: no logic change, no fail-open;
  wire types match featureAccessRoutes.js, orgAiContext.js, orgIntegrationCache.js, releaseNotesStore.js, cmsAnalytics.js.
- Integration: merged origin/ccr-28820270-xkvwp8 @ e738f454 first (clean), then s2/batch-15 (one conflict in
  i18nGuard.test.js: adjacent renames modelMeta.ts / filters.ts, both kept; i18nGuard 16/16).

- Full gate at the merge (push 3, after e738f454 + batch 15): check:fast 39/39; server tc 0; duplication production 15362 ≤
  15383, test 26228 at budget; gitleaks clean; agent-hub tc 0; vitest 1836 files / 21619 tests pass BUT rc=1 from 3 unhandled
  rejections ("window is not defined") in `src/pages/webpages/WebpageIDE.i18n.test.jsx` via `useBfMarks.ts:57` — a setState
  after jsdom teardown (out of S2 scope, identical to the convert branch; 3 isolated reruns clean). Fix belongs with the
  owner of pages/webpages: await/abort the fetch in the test or guard the setState after unmount. Mobile jest 762 suites /
  13430 pass, tsc 0; server 28933 pass, 0 fail, no HUNG.

## What the integrator must watch at merge
- `agent-hub/src/i18n/i18nGuard.test.js`: S2 renamed entries (filters.ts; earlier batches' paths); other sessions edit the
  same list — keep both sides.
- `agent-hub/.file-budget.json`: key renames only (settingsFields, ui.tsx, …).
- Mobile `src/features/compliance/model/lockstep.test.ts` reads `settingsFields.ts`.
- Out-of-scope types-only edits: `export` on PublicPlan (marketing/sections/PricingSection.tsx) and CmsSeo (marketing/useCmsHead.ts);
  tightened existing TS in admin/org/userManagement/*, product-website cmsPanelTypes.ts, panelView.ts.
- New JS file blockEditors/GroupedItemsField.jsx (pure move out of shared.jsx, Opus-approved; net ts-ratchet 0).
- Commit signatures: every S2 commit on the branch is signed; the batch branches `s2/*` are local scratch, not pushed.
- No mirror candidates found in S2 scope.
