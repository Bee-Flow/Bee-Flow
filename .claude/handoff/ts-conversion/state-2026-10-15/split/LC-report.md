# L-C report: remaining agent-hub JS sweep (laptop)

Status: round 1 pushed (all checks green). Round 2 drafting/review (p4-p7, drafted on the round-1 drafts).
Done: 43/314 files, 4 packages merged (p1a 22, p1b 15, p2 1, p3 5).
Next: Opus review + integrate round 2 (~2-3 h), then round 3 (p8) and a blocked-file retry.

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

Catch-recipe commits: downloadWebpageZip `String(err?.message || err)` → `describeError(err)` (// behaviour: a truthy
non-string message is no longer stringified; recipe row, accepted by review). SpeakerEditor 2× `messageOf(e, '<literal>')`.

### Kept JS: blocked or by rule
- react-hooks disable: moduleRuntime/RemoteStudioApp, editor/react/BeeEditor, shared/StudioSectionHeader.
- utils/lazyWithReload: typing `lazy<P>` breaks 5 TS importers that pass JS-inferred components / `{default:null}` mocks.
- utils/buildWebpagePreview: catch read `e.formatted` (outside the recipe).
- utils/platform: `navigator.userAgentData` not in lib.dom. utils/mcpLogos: `isUrl` predicate would lie. utils/messageShape: no shared ChatMessage type.
- apps/appCatalog: was blocked by integrationGlyphs (now TS) — retry in the sweep.
- editor/nodeviews/FormulaView: blocked by editor/engine/view.js.
- meeting-notes: MeetingHeader (StudioSectionHeader), MeetingVisibility (VisibilityCapsule, now TS → retry), LibraryFilters (FilterPills, now TS → retry), MeetingNotesPage, MeetingDetail, SummaryActionsLayout, InsightsPanel (blocked by JS siblings), useAudioRecorder (error state read by files outside p3; `webkitAudioContext`).

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

## Push log
| Pushed commit | check:fast | server typecheck | duplication (prod / test) | gitleaks | agent-hub tsc | agent-hub vitest | mobile tsc | mobile jest | server npm test |
|---|---|---|---|---|---|---|---|---|---|
| round 1 (checks at the fix commit; then merged c79185eb, a 1-line server test change: that test + check:fast re-run green) | 39/39 | 0 errors | 15225 ≤ 15290 / 26228 = 26228 | clean | 0 errors | 1858 files, 21872 pass | 0 errors | 762 suites, 13428 pass | 29058 pass, 0 fail, 0 HUNG |

## Integrator: watch at merge
- Round 1 edited outside agent-hub/src: ci.yml path filters (cmsPublicRouting, utils glob `.{js,ts}`), mobile/scripts/sync-web-tokens.mjs (path + FONT_STACKS regex tolerates an annotation; webTokens.generated.ts regenerated, comment-only), mobile lockstep tests (billing, http, palette, roles, derive, insights), server tests reading bfElements/publicBridgeScript/seo/previewDocument paths, scripts/lib/editor-bundles.mjs + check-editor-bundles.test.mjs + both editor bundles (serialization/index.ts), agent-hub knip.json.
- Type-only edits in already-TS files outside the packages: pages/webpages StatusBar.tsx, ide/ideProps.ts, WebpageEditorBody.tsx (`lastSavedAt: Date | null`).
- Accepted casts (review notes): guarded `Map.get(k) as T` after has/set in SpeakerEditor, insightsData, transcriptLines; `segments as MentionSegment[]` after Array.isArray with per-entry guards.
- useTranscription.ts error is `unknown` with `TODO(err-unknown)`: MeetingDetail.jsx (JS) passes it to MeetingLoadError, which reads it as ApiError.
- Redundant FilterPills cast shims now removable (OverviewToolbar, ExecutionsFilterBar, MemoryFilters, studioParts, SolutionsOverviewParts); studioParts duplicates FilterPillOption/FilterPillsProps.
- Mirror candidates (under budget, not mirrored): FilterPills ↔ mobile shared/ui/Chip.tsx; VisibilityCapsule ↔ mobile shared/patterns/AudienceSheet.tsx.
