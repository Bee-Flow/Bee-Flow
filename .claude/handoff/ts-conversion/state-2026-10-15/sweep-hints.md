# Sweep hints: JS files kept back by a blocker that may now be converted

Collected from the batch reports (batches 21–42). A file was kept as JS when a
dependency was still untyped JS (its inferred props or params rejected the call),
when a mobile test read its source text, or when typing it needed a code change.
After the merge train the dependencies below are TypeScript. Retry the files in
the right-hand column first.

## Blockers converted in later batches (retry the blocked files)

| Blocker, now TS (batch) | Files it kept back (batch) |
|---|---|
| `marketing/components/SectionFrame`, `SectionHeader`, `EditableText` (36) | 12 marketing sections: LiveComponent, MediaText, PricingSection, ReleaseNotes, Roadmap, Security, Showcase, SocialProof, Steps, TechStats, Testimonials, TrustBand (37) |
| `meeting-notes/detail/TagRow` (39) | `meeting-notes/library/UpcomingMeetings` (40) |
| `meeting-notes/detail/TemplateManager` (39) | `admin/meetings/SummaryTemplatesAdminPanel` (30), `pages/settings/SummaryTemplatesSection` (40-rest) |
| `forms/PublicFormRenderer` (29) | `automation/Builder/FormRunOverlay` (21) |
| `meeting-notes/hooks/*`, `lib/transcriptionsApi` (39) | `capture/RecordPanel`, `UploadPanel`, `TalkImportPanel`, `GoogleMeetImportPanel`, `CaptureModal`, `DestinationPicker`, `MeetingNotesPage`, `ActionItemsList` (38) |
| `onboarding/*` logic: lessons, actionChecks, stepTypes, courses (31) | `onboarding/player/*` steps (31) — still need a truthful `t(key?)`; retry now that `TranslateFn` accepts `string | undefined` |

## Blockers that are still JS (convert the blocker first if it can be typed honestly)

| Blocker (still JS) | Files it keeps back |
|---|---|
| `shared/AppIcon.jsx` (29: forwardRef to span/img/svg) | TierSlider (30), CookieBanner, NavIcon, Features, Hero, Footer, Integrations (36), AppsHomePage (38) |
| `AppEmoji` (forwardRef, empty inferred props) | ActivityIndicator, ChatActivity, ToolsUsedTimeline (28), TierSlider, ModelTierSelector (30) |
| `shared/AnchoredMenu.jsx` (`= null` defaults) | DlpHighlightedText (29), TokenisedBadge (28), FieldKeyCombobox, FieldPicker (26), webpages/SourcePicker → BuildBar (41) |
| `flow/FieldHint.jsx` (`title = null`) | fieldChrome, PathField (26) → BindingField, ValueBuilder, TemplateField; `settings/formPrimitives` (25) |
| `StudioSectionHeader` | WebpageEditorHeader, WebpagesList (42), NotebookWorkspace (38) |
| `shared/FilterPills.jsx` | meeting-notes/library/LibraryFilters (40) |
| `licensing/LicenseContext.jsx` (`hasTier`/`hasFeature` infer 0 args) | IntegrationsAdminPanel (29), useVoiceChatReady (28), ConsumerBetaFeaturesSection (40-rest) |
| `licensing/UpgradePrompt` (`= null` defaults) | LicenseContext (30), ConsumerBetaFeaturesSection |
| `skills/SkillFormModal.jsx` (react-hooks eslint-disable) | SkillsPanel, SkillsPopover (32) → ComposerPills (27) |
| `AppsPicker` / `appCatalog` (21) | CoworkComposer, CoworkEditForm (29) → CoworkDetail, CoworkPage |
| `learning/bits.jsx` (`StepKindIcon` requires `style`) | onboarding/player/LessonPlayer (31), learning CourseView, OverviewView, ReviewView (41) |
| `useGoogleWorkspacePicker.ts` (`ExportedAttachment = Record<string, unknown>`, no `authWindowName`) | GoogleWorkspacePickerModal, GoogleDrivePicker (27) — a types-only tightening of the hook unblocks both |
| `admin/org/OrgUsersPanel.tsx` (`initialSection?: string`, unused) | `pages/OrgSettings` (37) — widen to `string | null` |
| `components/shared/AudienceRows` | webpages/WebpageAudiencePanel (41) |
| `useAudioRecorder` (error state inferred `null`) | settings/VoiceprintEnrollModal (41), RecorderContext (39) |

## Mobile test infrastructure

- `mobile/src/shared/testing/webModule.ts` `loadWebFunctions` (line ~47) has no `stripTypes`, unlike `loadWebModule`. Adding the same `ts.transpileModule` step lets `chat/ThinkingPanel` and `chat/timelineParts` (28) convert.
- Files kept JS because a mobile test or script reads their source text with a regex are not sweep candidates unless that test is changed to tolerate annotations (allowed: a minimal regex change, as done for `iconRegistry` and `code.test.ts`).

## Not sweep candidates (need a runtime change)

Date arithmetic (`end - start`), nullable refs dereferenced without a guard, `Map.get(k).push`, `parseInt(nullable)`, `.replace('{n}', number)`, `window[string]` indexing, i18n keys passed as possibly-undefined to `t` from server-authored content. Leave these as JS and list them in the final report.
