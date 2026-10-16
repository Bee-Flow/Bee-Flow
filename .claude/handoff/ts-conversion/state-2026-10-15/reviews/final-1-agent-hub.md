# Final review, part 1 of 3: agent-hub (TS conversion and structural refactors)

Range: `77c40ea8` (merge-base with origin/main) .. `05393c5f` (`ccr-28820270-xkvwp8`), `-M`, renameLimit 6000.
agent-hub: 2317 files changed (1305 R, 571 A, 396 M, 45 D); 1302 `.js/.jsx -> .ts/.tsx` renames.
The history before `2d36c711` is cut off by the shallow clone, so the early commits (the batch 01-21 drafts, the
AgentDesigner/Sidebar/NotificationCenter/BuildTab splits and the inline-style sweep) show up only as one root commit.
I judged them from the base..head diff.

## What I ran (all read-only)
- Forbidden-construct grep over every added line, minus any line that already exists verbatim on base.
- `ts-equivalence.mjs 77c40ea8 05393c5f --diff` over the whole range, with `diff.renameLimit=6000`. The script's own
  git call otherwise skips rename detection and reports only 28 files. Every DIFFERENT file was then put in a class.
- One `tsc --noEmit -p .` on a scratch copy of `agent-hub/src` (under the scratchpad, `r1-agenthub/root`). In that copy
  the 51 `as unknown as` shims whose target module is now TypeScript were removed. Nothing else changed.
- eslint with only `react-hooks/rules-of-hooks` and `exhaustive-deps` over all 3088 TS/TSX source files (scratch
  config). The repo config has no react-hooks rules for TS.
- Spot checks against the server routes. Shapes: memory recent/by-conversation, support threads/mine, billing
  public-plans (`toPublicPlan`), learning org-overview, guard-status, http connections `kind`, voice session.
  Long-function splits: AgentDesigner, NotificationCenter, useOrgShield, Sidebar/useSidebarAccess, plus the
  non-type commits.

## Scores
| Dimension | Score | Why |
|---|---|---|
| Type honesty | 5/10 | Most types are careful, but the PR adds about 165 caught-error casts (`(e as Error)`, `(err as ApiError)`, …), about 72 net `as unknown as` and 9 non-null `!`. 51 of the shims point at modules that are now TS and hide 36 real type errors. |
| Runtime equivalence | 9/10 | Of 1310 renames, 971 compile identical. All 339 that differ are accounted for: 281 inline-style→class edits, 53 catch-recipe edits, and 36 documented runtime cases or moves with their own tests (`*.nullish/edges/lookup.test.*`). I found no difference without an explanation. |
| One home per shape | 6/10 | The core App Studio types have one home each (fixed in 0b59c787). Still duplicated: `GuardStatus` ×5 for a single endpoint, about 20 new local `Translate`/`TFn` aliases next to `TranslateFn`, the KnowledgePanel props shape, `OrgGroup` ×5. |
| Server-contract accuracy | 8/10 | 8 of the 9 shapes I sampled match the server field for field, nullability included. VoiceSessionInfo misses the `null` the server sends. Fields the shims hide (e.g. `InspectorHost.activePageId`) are only checked once the shims go. |
| Refactor safety | 8/10 | 0 rules-of-hooks violations in all TS. Hook and effect order is preserved in the splits I read, and the dependency arrays were kept verbatim. The weak spot: TS files get no hook lint at all, and 3 files with react-hooks disables were converted anyway. |
| Test coverage of behaviour changes | 7/10 | Every intended runtime change in a converted file has a dedicated test, and the fix commits carry tests. The NotificationCenter split (785 lines, no tests before or after) and the MarketplaceTab `details.detail` fallback have none. |

## Findings

### BLOCKING

**B1. The PR description claims things the diff disproves.**
`.claude/handoff/ts-conversion/state-2026-10-15/pr-description.md`, "Why it is safe", reads: "No `any`, `as any`,
`as unknown as`, `@ts-ignore` or non-null `!` were added". "Errors are read honestly … instead of `e.message` on
whatever was thrown" is also there.
- Measured against origin/main, in non-test agent-hub source:
  - caught-error casts: 54 → 219
  - `as unknown as`: 193 → 265
  - new non-null `!`: 9 (B3)
- Fix: correct the description, or land B2/B3 first. A reviewer of the PR will read that sentence as verified.

**B2. 51 stale `as unknown as` shims hide 36 real type errors.**
The shims point at modules that are TS now, so the typecheck checks the shim instead of the module.
- Removing only those shims gives 36 errors in 14 files (`r1-agenthub/tsc-stripped.txt`). The other shims are
  removable with no error at all.
- LA-r1-A treated "delete a stale shim" as a required fix, but each later round counted the older shims as base, so
  nobody re-checked them after their targets were converted.
- Shims whose target is now TS (file:line):
  - `AppStudio/editor/AppEditorShell.tsx:64,67,78-81`
  - `AppStudio/editor/EditorNodeWrapper.tsx:61,64,149` (`useRuntime() as unknown as EditorRuntime`)
  - `AppStudio/editor/EditorHeader.tsx:38`
  - `AppStudio/editor/shell/ShellPanes.tsx:14`
  - `AppStudio/bi/ConnectorsManager.tsx:73`
  - `AppStudio/bi/connectors/{ConnectorEditor.tsx:25, KindFields.tsx:20, connectorModel.ts:78}`
  - `AppStudio/bi/sync/SyncSetup.tsx:16-17`
  - `AppStudio/chat/useBuilderTurn.ts:74`
  - `AppStudio/tables/{TablesManager.tsx:52, useDataModel.ts:20}`
  - `Datatables/rowBrowser/rowBrowserModel.ts:94`
  - `monitoring/sharedTyped.ts:30`
  - `product-website/{fieldKit/jsDeps.ts:13, pageList/pageListShared.ts:38,43, panel/panelJsComponents.ts:14,24,36, sitemap/SettingsFlyout.tsx:20}`
  - `agents/AgentDesigner/DesignerPanels.tsx:9`
  - `agents/AgentDesigner/index.tsx:49,54,55,85` (`useAgentState() as unknown as DesignerState`)
  - `automation/Builder/build/jsComponents.ts:86,94,102,105,110,177,184,190,200,209,215`
  - `chat/MessageItem/index.tsx:166`
  - `chat/MessageItem/jsChildren.ts:23,30`
  - `shell/sidebar/{RecentChats.tsx:13, SidebarChrome.tsx:16, sidebarNav.tsx:23}`
- What they hide, verified in the code:
  - `build/AssistantColumn.tsx:35` types `onApplyProposal` as `() => void`, but `ProposalCard.tsx:76` calls
    `onApply(excluded)`.
  - `buildTabTypes.ts:152-153`: `onBuildLayer`/`onRefineLayer` are `Fn<never[], unknown>`, where the real
    callee wants `(text) => Promise<boolean>` (BuildCanvas.tsx:235-236).
  - `inspector/InspectorHost.tsx:23`: `activePageId: string`, but PanelInspector passes `string | null`, and
    `normalizeVirtualId` handles null.
  - `DesignerPanels.tsx:9-18` re-declares KnowledgePanel's props and passes `agentId`. KnowledgePanelProps has no
    such prop: KnowledgePanel.tsx:36-40 says it is deliberately unread.
  - `EditorNodeWrapper.tsx:91,98,288`: the `LogicMark` and `LogicSummaryMark` shapes have drifted apart.
  - `ConnectorsManager.tsx:144/150/174`: `lookup(toolName: string)` against `string | undefined`.
  - `TablesManager.tsx:214/219` and `useDataModel.ts:28`: `ModelConnector` against `Connector` (`kind` optional
    against required).
  - `AppEditorShell.tsx:148/182/242/243/281`: the context value types differ from the TS contexts'.
- Runtime is unaffected (casts only). But these are exactly the call sites the PR text says TypeScript now protects.
- Minimal fix: delete the 51 shims (each becomes the plain import), then fix the 36 errors with types only. Most fixes
  widen a caller prop type, or turn a required field into `| null` / optional where the callee already tolerates it.
  Verify with `ts-equivalence` (types only).

**B3. Forbidden constructs in new code: caught-error casts and non-null `!`.**
- Caught-error casts: about 165 net new in 88 files:
  - `(e as Error)` 98, `(err as Error)` 38
  - `(err|e as ApiError)` 10, e.g. `AppStudio/rbac/useAppRoles.ts:225-230`
  - `UploadError` 4, `TranscriptionsApiError` 4, `RuleError` 4, `ThrownError` 3, `SubmitError` 2, `FormulaThrow` 2
  - Biggest files: `support/SupportInboxPanel.tsx` (6), `support/SupportConnectionsConfig.tsx` (5),
    `automation/Builder/webhooks/useWebhooks.ts:103,142,163,180,200`, `forms/PublicFormRenderer.tsx:393,626,811,953`,
    `AgentHub/useConversationMeta.ts:161,186,215,242`, `InitSetupWizard/index.tsx:215`,
    `admin/org/orgInfo/license/useSubscriptionActions.ts:47`, `product-website/panel/useCmsSiteLoader.ts:50`
    (the last two define `errorText = (e: unknown) => (e as Error).message`).
  - They come from batches 01-12, drafted before the caughtError helpers existed. STATE.md "Rules that bit us" and
    catch-recipe.md §10 forbid them, and no later sweep picked them up.
- Non-null `!` in code split out in this branch:
  - `product-website/sitemap/sitemapGraph.ts:81,107,133,156,190,192,212` (Map.get(...)!)
  - `AppStudio/bi/connectors/connectorModel.ts:195` (`groups.get(appId)!.items.push`). The README lists
    `Map.get(k).push` as a "stays JS" construct.
  - `admin/languages/PromptEditor.tsx:151` (`d.promptIds![0]`)
- Minimal fix:
  - Casts: run the catch recipe as one separate `refactor(ts)` commit. It is token substitution: `(e as Error).message`
    becomes `errorMessage(e)`, and `(e as Error).message || 'x'` becomes `messageOf(e, 'x')`. For
    ApiError/UploadError/…, use an `instanceof` check on the real class or a local type guard. The gate will report
    those files as different, and the commit message names them.
  - `!`: for `!` on Map.get, use a `getOrInit(map, k, () => [])` helper or `const list = m.get(k); if (list) …`,
    with a test pinning sitemapGraph's layout. `sitemapGraph.test.ts` exists. For PromptEditor, capture
    `const ids = d.promptIds` before the closure.

### FOLLOW-UP

1. **TS gets no react-hooks lint.** `agent-hub/eslint.config.js:179-195` gives `.ts/.tsx` only the size rules, so each
   conversion silently removes a file from `rules-of-hooks` (error) and `exhaustive-deps`.
   - Measured on head: 0 rules-of-hooks violations across 3088 TS files. So `'react-hooks/rules-of-hooks': 'error'`
     can go into the TS block today at no cost.
   - Measured on head: 177 exhaustive-deps warnings in 97 TS files. 60 are in hook files added by the splits, nearly
     all setters or refs that come in as parameters, with the dependency arrays kept verbatim. 42 are in converted
     files.
   - Fix: add rules-of-hooks now. Add exhaustive-deps with its own budget later.
2. **Three files with a react-hooks `eslint-disable` were converted anyway**, against "stays JS". The disable comment
   was rewritten as prose:
   - `appearance/studio/look/preview/LookPreviewIframe.tsx:37-40`
   - `security/guardrails/orgShield/useOrgShield.ts:114-133`, 3 disables in base `useOrgShield.js`
   - `AppStudio/chat/useBuildCue.ts:88`, from base `BuilderChatPane.jsx:558`
   - No behaviour change, since the arrays are identical. The coverage gap is item 1.
3. **27 `as unknown as` remain over modules that are still JS**, for example:
   - `ConnectorsManager.tsx:72`
   - `AppEditorShell.tsx:63`
   - `TablesManager.tsx:48-49,62`
   - `typedViews.ts:13,26,29`. Recipe 15d says delete this one with a real signature.
   - `jsComponents.ts:84,131,139,226`
   - `monitoring/sharedTyped.ts:10,18,20`
   - plus `AppStudio/runtime/useActionRunner.ts:166` (`useRef<LiveInputs>(null as unknown as LiveInputs)`) and
     `shell/sidebar/useSidebarAccess.ts:90` (`studioNavSections(...) as unknown as StudioSection[]`, which feeds the
     Studio gate).
   - Fix: JSDoc on the JS module, or convert it. For useActionRunner use `useRef<LiveInputs | null>(null)`. For
     useSidebarAccess, widen `studioNavSections`' generic so it returns its input element type.
4. **One home per shape:**
   - `GuardStatus` is declared 5 times for GET `/api/org-privacy-shield/user/guard-status`: `api/useGuardrailsData.ts:21`,
     `orgShield/overview/types.ts:49`, `orgShield/parts/DetectionStatusPill.tsx:8`, `orgShield/useShieldEnvironment.ts:11`
     and `pages/settings/ConsumerPrivacySection.tsx:25`. Required in two, optional in three. The server always sends
     both booleans (`server/routes/orgPrivacyShield.js:642-656`).
   - Local translate-function aliases (`type Translate =`, `type TFn =`) are now 62, about 20 of them new, in place of
     `TranslateFn` (`hooks/useTranslation.tsx:47`).
   - `OrgGroup` ×5 (`api/queries/orgGroups.ts`, `PublishMenu.tsx`, `VisibilityCapsule.types.ts`,
     `summaryTemplates.types.ts`, `WebpageEditorPage.tsx`).
   - Fix: export one type and import it everywhere.
5. **The NotificationCenter split has no test.** It is 0d7efbf6: 785 lines → `NotificationCenter.tsx` plus
   `notifications/*`, covering the unread poll, read/delete, the chat hand-off and reconnect. There is no
   characterisation test (plan §3 recipe step 1), and the Sidebar tests mock it out.
   - By reading it, I found hook and effect order preserved and `deleteNotification`'s expanded-reset kept, with the
     same behaviour.
   - Fix: add one render test for poll → list, mark-read on expand, delete of the expanded row, and
     `openDirectChatWithContext` detail for a cowork result.
6. **`VoiceSessionInfo` is off on nullability** (`chat/Voice/useVoiceSession.types.ts:6-13`). It types
   `agentName?: string` and `agentId?: string`, while `server/routes/ai/voice.js:346-356` sends `agentId: …|| null`
   and `agentName: …|| null`. Make both `string | null`. The reads are already defensive.
7. **`MarketplaceTab.jsx` reads `body.details.detail` first** (a71517fe, behaviour change for the server 5XX-7 shape).
   `MarketplaceTab.test.jsx:74-80` still uses the old `{ error, detail }` body and asserts only the banner. Add a case
   with `{ error:'hub_unavailable', code:'hub_unavailable', details:{ detail:'timeout' } }` that asserts the detail
   text.
8. **Two `any` leaks through `Array.isArray`:**
   - `compliance/pages/settings/settingsFields.ts:333`: `asArray<T>(v: unknown): T[]` returns the `any[]` unchecked,
     and its comment admits it.
   - `hooks/appBuilderStream/session.ts:28`: `snap.messages` (unknown) becomes `BuilderMessage[]` through
     `filter(m => m && typeof m === 'object')`.
   - Fix: return `unknown[]` and narrow at the use site, or add a real element guard.
9. **New JS file**: `product-website/blockEditors/GroupedItemsField.jsx` (d46eeeca, a move out of `shared.jsx`). §0
   says new files are TS, and ts-ratchet passes only on slack. Convert it, or record why it stays JS.
10. **The inline-style sweep has no review record.** 9313 → 5647 `style={{` in agent-hub; it is the bulk of the 281
    style differences. It sits behind the shallow root, and no file under `.claude/handoff/` mentions it.
    - My scan of all added `className`s (4857 with a `-[var(` utility) found no element that gets a named and an
      arbitrary utility for the same property. So inline-beats-class precedence did not flip anywhere I could see.
    - Still worth one visual pass, or a line in the PR description, since it is a visible change riding in a
      "types only" PR.
11. **Tooling:** `scripts/ts-equivalence.mjs` calls `git diff` without a rename limit. On this range it silently
    checks 28 of 1310 renames, and the only signal is a warning on stderr.
    - Fix: pass `-c diff.renameLimit=0` (or 6000) in its `git()` helper, so the final gate on the PR range is
      meaningful.

## Checked and found sound (no finding)
- caughtError.ts helpers and their test, and the catch-recipe files: 53 DIFFERENT files, every diff a token
  substitution. One `TODO(err-unknown)` remains in useTranscription.ts:11, and it is acknowledged.
- The 36 runtime-different files outside style and catch were each checked:
  - Proven equivalent: `Date#getTime`, `x == null ? void 0 : map[x]`, `typeof … === 'number'` before
    `Number.isFinite`, the `PasteImportPanel` `retryAfterOf` (`retryAfter` is `number|null`, recordsApi.ts:48).
  - Documented in the code: `CadThumb.tsx:105-108` (`// behaviour:`).
  - A move: GeneratedMedia → `openLibraryDocument`, `transcriptionsApi` → `jsonOrThrow`, kindColors → `kindKeys`.
  - Or covered by new `*.nullish/edges/lookup.test.*`.
- Hook and effect order and the deps arrays are unchanged in AgentDesigner (`useDesignerEffects`), NotificationCenter
  (`useNotifications`), useOrgShield (useShieldEnvironment/useShieldFields) and the Sidebar (`useSidebarAccess`).
- ba8ba338: `HttpConnection.kind` is required, and that is right. The DB and `sanitizeHttpSecret` guarantee it, and
  `HttpAuthPicker` passes it to `httpKindName(string)`.
- With the shims left in place, the rest of the tree typechecks clean: the scratch run's only errors were in the 14
  files whose shims I removed.
