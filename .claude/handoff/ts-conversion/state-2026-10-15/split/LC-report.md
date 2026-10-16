# L-C report: remaining agent-hub JS sweep (laptop)

Status: round 3 pushed (all checks green). Retry package p9 drafted (3 files); Opus review next.
Done: 78/314 files, 10 packages merged (round 1: 43; round 2: 26; round 3: p8a 2, p8b 7).
Next: review + integrate p9 + push (~1 h); then final report. Remaining JS is listed below as blocked / follow-up.

Branch `ts-laptop/sweep-c`. BASE `0ae29a17` (= origin/ccr-28820270-xkvwp8 at branch time; ts-local/prep2 already in it).
Final commit: see `git log -1` of the branch (this file is updated with every push).

## Scope
Every agent-hub JS file outside components/admin/Studio/**, components/admin/compliance/**,
components/admin/product-website/**, components/automation/Builder/**: 314 files at BASE.
Left out by instruction: AuthedApp.jsx, AgentHub.jsx, AgentHub/useAgentHubData.js,
components/chat/InputArea/index.jsx, components/skills/SkillsPopover.jsx,
components/onboarding/generated/**, src/i18n/en-defaults.js.
Stays JS by rule (react-hooks eslint-disable): StudioSectionHeader.jsx, SkillFormModal.jsx,
ComposerPill.jsx, RemoteStudioApp.jsx, BeeEditor.jsx, LearningCenterSection.jsx.

Packages (fan-in first; round 1 = the most-imported shared modules):
| Package | Area | Files | Round |
|---|---|---|---|
| p1a | utils, lib, config, moduleRuntime, theme | 37 | 1 |
| p1b | components/shared, components/apps | 21 | 1 |
| p2 | editor | 15 | 1 |
| p3 | pages/meeting-notes, components/global | 25 | 1 |
| p4 | chat, AgentHub, cowork, skills, shell, support, knowledge, renderers | 40 | 2 |
| p5 | agents, automation/index | 27 | 2 |
| p6 | admin (rest), integrations, AdminDashboard, OrgSettings | 54 | 2 |
| p7 | pages/settings, pages/login, top-level settings/login pages | 37 | 2 |
| p8 | documents, webpages, marketing, demo, onboarding, entry files | 57 | 3 |

Owner scope rule (2026-10-16): convert only types-only files and catch-recipe substitutions. No new runtime-equivalent
rewrites; such files stay JS byte-identical and are listed under "Follow-up: needs runtime rewrite". This branch contains no
runtime-equivalent rewrites.

## Status per package
| Package | Converted | Gate | Review |
|---|---|---|---|
| p1a utils/lib/config/moduleRuntime/theme | 22/37 (21 types + downloadWebpageZip catch recipe) | merged: 41 identical / 2 different (the 2 = catch-recipe commits) | reviews/LC-round1.md (Opus, CHANGES REQUIRED small → fixed in the fix commit) |
| p1b components/shared, apps | 15/21 | (same gate line) | same |
| p2 editor | 1/15 (serialization/index.ts barrel; bundles rebuilt, emitted code identical) | (same gate line) | same |
| p3 meeting-notes, global | 5/25 (4 types + SpeakerEditor catch recipe) | (same gate line) | same |
| p4 chat, cowork, renderers | 6/40 (4 types + CoworkPage, VegaLiteRenderer catch recipe) | round 2 merged vs 77793e85: 20 identical / 6 different (the 6 = catch-recipe files) | reviews/LC-round2.md (Opus incl. security, CHANGES REQUIRED → fixed in the round-2 fix commit) |
| p5 agents | 2/27 (deleteBlock + ExternalShareSection catch recipe) | (same gate line) | same |
| p6 admin, integrations | 16/54 (12 types + RuntimeRow types + localRuntimeApi, LocalModelsCard, RerankerConfig catch recipe; countries reverted by review) | (same gate line) | same |
| p8a documents, webpages, apps | 2/28 (SourcePicker, BuildBar; documentsApi and AppsHomePage reverted by review) | rounds 2+3 vs 77793e85: 29 identical / 6 different (the 6 = round-2 catch-recipe files) | reviews/LC-round3.md (Opus, CHANGES REQUIRED → fixed in the round-3 fix commit) |
| p8b marketing, demo, entry files | 7/29 (CookieBanner, LanguageSwitcher, NavIcon, Features, Footer, Integrations, TrustBand; Hero reverted by review) | (same gate line) | same |
| p7 settings, login | 2/37 (LearningRail, ConsumerBetaFeaturesSection; 5 reverted by review: bits, OverviewView, ReviewView, widgets, ConsumerUsageSection) | (same gate line) | same |

Catch-recipe commits: downloadWebpageZip `String(err?.message || err)` → `describeError(err)` (// behaviour: a truthy
non-string message is no longer stringified; recipe row, accepted by review). SpeakerEditor 2× `messageOf(e, '<literal>')`.
Round 2: CoworkPage 3× and VegaLiteRenderer 1× `errorMessage`; ExternalShareSection 4× `setError(errorMessage(e))`
(state `string | null | undefined`); localRuntimeApi/RerankerConfig recipe swaps; LocalModelsCard handleDetect
`messageOf(e, '')` (// behaviour: target is a string field). CoworkPage also collapses a 3-line import to 1 (formatting).

### Kept JS: blocked or by rule
- react-hooks disable: moduleRuntime/RemoteStudioApp, editor/react/BeeEditor, shared/StudioSectionHeader.
- utils/lazyWithReload: typing `lazy<P>` breaks 5 TS importers that pass JS-inferred components / `{default:null}` mocks.
- utils/buildWebpagePreview: catch read `e.formatted` (outside the recipe).
- utils/platform: `navigator.userAgentData` not in lib.dom. utils/mcpLogos: `isUrl` predicate would lie. utils/messageShape: no shared ChatMessage type.
- apps/appCatalog: was blocked by integrationGlyphs (now TS) — retry in the sweep.
- editor/nodeviews/FormulaView: blocked by editor/engine/view.js.
- meeting-notes: MeetingHeader (StudioSectionHeader), MeetingVisibility (VisibilityCapsule, now TS → retry), LibraryFilters (FilterPills, now TS → retry), MeetingNotesPage, MeetingDetail, SummaryActionsLayout, InsightsPanel (blocked by JS siblings), useAudioRecorder (error state read by files outside p3; `webkitAudioContext`).

- Round 2 blocked: p4 GoogleDrivePicker (ExternalFilePickers/KnowledgePanel onFilesSelected), ChatActivity (timelineParts DurationPill), CoworkRunHistory (coworkFormat), SupportAIConfig + p5 AgentDesignerPanel (AgentEditorUI `@param {Object}`), AgentChatView/DirectChatView/ComposerPills (InputArea/index, ComposerPill, SkillsPopover: excluded / react-hooks), ElevenLabsSettings/MusicGenSettings/MediaCreationPanel (useMediaGenSection returns Record<string, unknown>), WorkspaceNotebook (NotebookEditorFacade). p5 toolChooserModel (toolGrants), AdvancedDrawer (BehaviorPicker), AgentEditorUI (KnowledgePanel has no agentId), BuilderChatPanel (PlanCard), AgentEditorHeader (StudioSectionHeader), TestSetCard/useAgentTests (testSetFacts), AgentWizard/index + AgentStudio/index (BuilderSplit props), automation/index (Builder off limits). p6 OverviewPage/UsageExplorerPage/ActivityPage (monitoring/shared), FeaturesSection (FeatureCardGrid), MarketplaceTab (moduleActions), ai-config/index (WebSearchInferenceConfig), OrgShieldEditor (orgShieldPosture), AdminDashboard (ProductWebsitePanel, SupportInboxPanel props), OrgSettings (OrgUsersPanel initialSection string|undefined vs null). p7 CourseView (LearningHeader), UsageSection (OrgFeedbackPanel, OverviewTab), SimpleApiKeyIntegration (IntegrationsSection), VoiceprintEnrollModal (useAudioRecorder), SignupWizard (Signup steps), LoginPage (SignupWizard). p7 reverted by review: bits (StepMixLine `mix?.[k]` has no honest typing), OverviewView/ReviewView (need bits), widgets/ConsumerUsageSection (nullable DB `source`/`model` used as map index).

- Round 3 blocked: WebpageDeleteDialog (DangerZone), WebpageDataTab (WebpageDbViewer has no theme prop), WebpageEditorHeader + NotebookWorkspace (StudioSectionHeader), WebpageSources (AnchoredMenu / ideProps optional sources), WebpageChat (IdeChatPanel / ideProps), WebpageCodeStrip (useBfMarks marks: unknown[]), AppRunPage (AppDataScope/AppRenderer/useActionRunner), WebpagesPage (WebpagesList), WebpageAudiencePanel (WebpageDataCards Chip.title), WebpageAppsPanel (useAutomationApi), demo/ComplianceDemo (compliance/index.jsx focusCheckId), appRuntimeHeadless (AppRenderer, themeVars; vite.runtime.config names the entry), demo/registry (lazy Component union needs any). Data/generated, no benefit: demo/fixtures/complianceCatalog.js (GENERATED by server/scripts/genComplianceDemoCatalog.js as .js), demo/fixtures/compliance.js (2851 lines of logic). Reverted by review: documentsApi (number entries asserted as strings), AppsHomePage (+types; StudioAppRow duplicates StudioApp, accentColor null from server), Hero (CMS string asserted into a CSS union).

## Follow-up: needs runtime rewrite (file — construct)
- lib/googleOAuthPopup — `= {}` destructured default whose fields are called unguarded
- lib/opaque — `hex.match(...)` nullable deref (generateRecoveryKey, hexToBuf)
- moduleRuntime/registry — `.filter(Boolean)` does not narrow `(Descriptor|null)[]`
- utils/imageResize — `e.target.result` nullable deref
- utils/sseStream — `buf = lines.pop()` is `string|undefined`
- utils/emojiCatalog — index by possibly-undefined id
- utils/terminationsModel — `row.prompt_tokens / total` on nullable
- utils/studioRecents, utils/formRecents — `recents[item?.id]` index by possibly-undefined
- shared/AppActionPicker — `selection[appId]` with `focused?.id`
- shared/StatusActionPill — `action.onClick` under `plan &&` with nullable action
- shared/resolveTarget — `for…of definition.screens` without array guard
- shared/builder/revealSchedule — `Number.isFinite(stagger) && stagger >= 0` on optional number
- shared/DangerZone — `inUsePayload` reads fields of unknown without guard
- editor/engine/doc, normalize, tables, react/SectionDragLayer — `content[i]` on optional `content`; tables also `parseInt(number)`
- editor/engine/reconcile, render — `setAttribute(name, number)`, `style.x = unknown`, `__bf*` expandos
- editor/engine/view — `getSelection()` on nullable, undeclared class fields
- editor/nodeviews/ImageView — `<img src>` with nullable src
- editor/serialization/util, astToMd — `parseInt(number)`
- editor/serialization/htmlToAst, mdToAst — nullable `textContent`/match deref, `last.text += n.text`
- meeting-notes/lib/sourceMeta, playerData — index by possibly-undefined key; `Map.get(a) - Map.get(b)` (review: sourceMeta may be easy, retry)
- meeting-notes/lib/transcriptOutputs — `r.lineCount > 0` on optional number
- meeting-notes/lib/insightsMetrics — model built by later assignment
- meeting-notes/lib/meetingRules — untyped JSON walk
- meeting-notes/hooks/useWaveform — `webkitAudioContext`, `keys().next().value` to delete
- meeting-notes/library/MeetingLibrary — Date arithmetic
- meeting-notes/detail/ExtractedPanel, TranscriptLineMenu, DestinationPicker, TranscriptView — nullable props/values in closures
- meeting-notes/detail/insights/FollowUpTab — `.replace('{n}', number)`
- chat/AnswerTracePanel, settings/usage/OverviewTab, settings/ConsumerIntegrationsSection, admin/org/people/useUserDirectory, admin/subscriptions/ui/FeatureCardGrid — `Map.get(k).push`
- chat/MessageItem/timelineParts — `Number.isFinite(ms)` does not narrow; ThinkingPanel — `.filter(Boolean)` does not narrow
- chat/MessageItem/ToolsUsedTimeline — `tool.resultPreview?.length > 150`; MessageContentBody — `msg.completedToolCount > 0`; ComposerToolsMenu — `item.badge > 0`
- chat/MessageItem/ActivityIndicator — `toolCall.name` unknown, optional `phase.stage`; KbSourcesPanel — `msg.kbSources` unguarded
- chat/TokenisedBadge — FALLBACK_T / interpolate param; shell/sidebar/NavRow — NavItem lacks primary/kbd, nullable onClick; shell/Sidebar — untyped prop bag (not attempted)
- chat/MessageItem/CalendarDraftCard, cowork/coworkFormat, shell/SearchOverlay, AgentHub/useAgentHubActions, AgentHub/useDirectChatEvents — Date arithmetic
- renderers/PageRenderer — `<pre>{unknown}</pre>`; ResearchRenderer — `src={string|null}`; TestReportRenderer — `statusConfig[test.status]` with undefined key
- knowledge/SystemKnowledgeBasesPanel — `clearInterval(null)`, computed key string|undefined; skills/SkillsPanel — `err.message` into toast.error(string)
- agents/AgentWizard/canUse/toolGrants — `effective.length` on `string[]|null` correlated via `known`; `granted.includes(a.name)` optional
- agents/AgentWizard/tests/testSetFacts — `Math.min(intOrNull(...), total)`; `best.item` from null start
- agents/AgentWizard/PlanCard — `capabilities?.length > 0`; pickers/BehaviorPicker — optional callbacks called unguarded; pickers/AvatarPicker, AgentDesigner/sections/IdentitySection, settings/AvatarPicker — `ev.target.result`
- agents/AgentWizard/pickers/SchedulePickers, agents/AgentMarketplace — Date arithmetic (+ `.replace('{n}', n)`)
- agents/VersionHistory — `prompt.length` on re-read optional; AgentSkillsTab — `s.name.toLowerCase()` optional; canUse/ToolChooser — optional onClose passed to required Modal prop
- agents/AgentStudio/DeleteBlockedNotice — `othersChats > 0` nullable; AgentDesigner/hooks/useAgentChat — `res.body` deref
- admin/monitoring/shared, monitoring/index, TerminationsPage, integrations/azure/SSOSection — Date arithmetic
- admin/ai-config/chatModelTiers/TierCard — possibly-undefined modelId to string params; WebSearchInferenceConfig — narrowing through alias
- admin/security/guardrails/GuardrailsHub — nullable `active` to Tabs value; Info — `string|null` title; orgShield/activity/shieldRows — optional timestamp; orgShieldDirty — `v?.external` untyped; orgShieldPosture — `egress.x` after Number.isFinite
- admin/org/orgInfo/OrgInfoSection — nullable ncOrg; access/CloudCeilingEditor — `encodeURIComponent(undefined)`
- admin/subscriptions: PlanCard, QuickAssignDialog, TrialOffersPanel — `%`/`>` on nullable; OrgEditor — `includes(undefined)`; PromoEditor — `parseInt(number)`; GrantsView — `g.blob` narrowing lost in closure
- integrations/azure/ChatModelsSection — `replace` with a number; admin/modules/moduleActions, modules/index, integrations/nextcloud/NcScopeSection — nullable deref / `clearTimeout(null)`; GitHubSyncPanel — nullable `status.config`; NextcloudSyncPanel — spread of nullable config; IntegrationsAdminPanel — Dispatch<number> as `(value: string) => void`
- settings/learning/LearningHeader — SegmentedControl onChange vs CourseView; AchievementsView — `earnedById[c.badge?.id]`; CertificateDrawer — `writeText(string|null)`; admin/AcademyContentEditor — nullable course in closures
- login/MfaLoginStep, SignupStepAuth, SignupStepPrivacy, SignupStepOrg, SignupStepAccount — optional callbacks called unguarded
- TemplatesPage — `setFillTemplate(prev => ({...prev}))` on nullable; EmbedChat — `response.body.getReader()`; PublicFormPage — `FormDef|null` to required prop; AdvancedSettings — `onBack` prop mismatch (+ mobile lockstep reads its path)
- documents/DeckLookFields, HouseStylePanel — `.replace('{size}', number)`; notebook/hooks/useResizableWidth — `parseInt(localStorage.getItem())`
- documents/notebook/CitationChips, CitationOverlay — `Number.isInteger(x) && x > 0` on unknown; NotebookChat, SendForSigningModal — `x?.length > 0`; MermaidBlock — nullable canvas context, `parseFloat(getAttribute())`; DocumentWorkspacePanel — untyped contract/proposal state (not attempted)
- webpages/WebpageDataCards — `columns?.length > 0`; WebpageActionsPanel — optional numbers with `>`; FileExplorer — nullable `creating.parent`; WebpagesList — optional name `.trim()`
- App.jsx — `out.set('tag', params.get('tag'))` string|null; main.jsx — `createRoot(getElementById('root'))`; onboarding/player/LessonPlayer — nullable `stepDoc.origin`
- marketing/components/analyticsEvents — `window.umami.track` after typeof only; GoogleAnalyticsTracker — `window[string]`; sections/GitHubStats — Number.isFinite on number|undefined, nullable `publishedAt`; LiveComponent — `enabled !== false` after narrowing; Security — `card.link.href` after derived guard; Content — `el.width > 0` on undefined; CustomerSupport — `STATUS_TEXT[status]` undefined index (+ catch read); PricingPage, Roadmap, ReleaseNotes, demo/fixtures/knowledge — `Map.get(k).push`; ProductWebsite — index by possibly-undefined displaySize, `includes(undefined)`; demo/fixtures/appStudio — `query.get` on Partial context, nullable `record[key]`
- settings/OrgFeedbackPanel — `agent_id?.length > 20`; OrgTerminationsPanel — unguarded nullable fields; ConnectionsManager — `authType.id` nullable; IntegrationsSection — `filter(Boolean)` + destructuring; PolicyAcknowledgements — `t(..., null)`; OrganisationSection — prop mismatch + null vs string; SecuritySection — `securityKeys > 0`

## Push log
| Pushed commit | check:fast | server typecheck | duplication (prod / test) | gitleaks | agent-hub tsc | agent-hub vitest | mobile tsc | mobile jest | server npm test |
|---|---|---|---|---|---|---|---|---|---|
| round 3 (at the round-3 fix commit e61d29d8; report-only commit on top) | 39/39 | 0 errors | 15184 ≤ 15290 / 26228 = 26228 | clean | 0 errors | 1858 files, 21872 pass, 0 errors | 0 errors | 762 suites, 13428 pass | 29058 pass, 0 fail, 0 HUNG |
| round 2 (+ cherry-pick -x cfb10394, the integrator's useBfMarks test mock: first vitest run had 21872/21872 pass but 2 unhandled 'window is not defined' from WebpageIDE.i18n.test.jsx → useBfMarks.ts; full rerun after the cherry-pick green) | 39/39 | 0 errors | 15184 ≤ 15290 / 26228 = 26228 | clean | 0 errors | 1858 files, 21872 pass, 0 errors | 0 errors | 762 suites, 13428 pass | 29058 pass, 0 fail, 0 HUNG |
| round 1 (checks at the fix commit; then merged c79185eb, a 1-line server test change: that test + check:fast re-run green) | 39/39 | 0 errors | 15225 ≤ 15290 / 26228 = 26228 | clean | 0 errors | 1858 files, 21872 pass | 0 errors | 762 suites, 13428 pass | 29058 pass, 0 fail, 0 HUNG |

## Integrator: watch at merge
- Round 1 edited outside agent-hub/src: ci.yml path filters (cmsPublicRouting, utils glob `.{js,ts}`), mobile/scripts/sync-web-tokens.mjs (path + FONT_STACKS regex tolerates an annotation; webTokens.generated.ts regenerated, comment-only), mobile lockstep tests (billing, http, palette, roles, derive, insights), server tests reading bfElements/publicBridgeScript/seo/previewDocument paths, scripts/lib/editor-bundles.mjs + check-editor-bundles.test.mjs + both editor bundles (serialization/index.ts), agent-hub knip.json.
- Type-only edits in already-TS files outside the packages: pages/webpages StatusBar.tsx, ide/ideProps.ts, WebpageEditorBody.tsx (`lastSavedAt: Date | null`).
- Accepted casts (review notes): guarded `Map.get(k) as T` after has/set in SpeakerEditor, insightsData, transcriptLines; `segments as MentionSegment[]` after Array.isArray with per-entry guards.
- useTranscription.ts error is `unknown` with `TODO(err-unknown)`: MeetingDetail.jsx (JS) passes it to MeetingLoadError, which reads it as ApiError.
- Redundant FilterPills cast shims now removable (OverviewToolbar, ExecutionsFilterBar, MemoryFilters, studioParts, SolutionsOverviewParts); studioParts duplicates FilterPillOption/FilterPillsProps.
- Round 2 type-only edits in TS files outside the packages: hooks/useGoogleWorkspacePicker.ts (status.user = session user object, optional authWindowName), cowork/cowork.types.ts (CoworkPageProps), useProviderConfig.ts, tierTypes.ts (CustomTier budgetTokens, verbosity), AddRuntimeForm.tsx (imports new ProviderCards/local/runtimeTypes.ts). Accepted casts: ExternalShareSection `s.url as string` and OrgAuthSection `as OrgFormData` (value cannot change after the guard).
- Cherry-picked (-x) the integrator's cfb10394 (WebpageIDE.i18n.test.jsx mocks ./useBfMarks) from ts-int/staging: without it the full vitest run ends red on 2 unhandled rejections. Identical patch, merges cleanly with staging.
- Mirror candidates (under budget, not mirrored): FilterPills ↔ mobile shared/ui/Chip.tsx; VisibilityCapsule ↔ mobile shared/patterns/AudienceSheet.tsx; subscriptions/access/countries.js ↔ mobile features/org/model/countries.ts (kept JS: converting makes a 105-line clone).
