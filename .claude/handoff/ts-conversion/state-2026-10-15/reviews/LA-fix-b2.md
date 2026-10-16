# Opus review LA-fix-b2 (ts-laptop/fix-b2: 2d8c732b B2 shims, 7b5985fb B3 `!`; base 060da5ca): APPROVE WITH FIXES
Gate (emit): `ts-equivalence 060da5ca 7b5985fb --diff`: 0 converted files (no renames, no deletions; nothing to compare). `emitcmp 060da5ca` over all 53 modified .ts/.tsx: 53 identical / 0 different. With the fixes below: 55/55 identical against base, 13/13 against the tip.
Gate (constructs): added lines contain no `any`, `as unknown as`, ts-ignore/expect-error, `!` or eslint-disable. `git grep -c "as unknown as" -- agent-hub/src`: 486 → 437 (−49, as claimed); 436 with Fix 1. `!` from B3: 9 → 3 (sitemapGraph.ts:156, :212, PromptEditor.tsx:151).

## Fixes (file:line on 7b5985fb; tested diff: LA-fix-b2-fixes.diff, `git apply` from the repo root)
1. **The MessageBubble shim has a types-only fix** (jsComponents.ts:145-149). Removing the shim gives 2 errors at AssistantColumn.tsx:93-94. Both are real drift, not a runtime problem:
   - `buildTabTypes.ts:18-24` declares a second `BuilderMessage` (`role?: string`, `content?: string | unknown[] | null`). But `state.messages` IS the stream hook's `AutomationBuilderState.messages: builderStream.BuilderMessage[]` (hooks/automationBuilder/types.ts:39). This breaks the one-home-per-shape rule. The only thing the stream shape lacks is `toolCalls`, which the reducer sets (useAutomationBuilderStream.ts:174) and `isWaitingForFirstToken` reads. Replace :18-24 with:
     ```
     /** One message of the builder chat: the stream hook's shape, plus the tool calls this builder adds to it. */
     export type BuilderMessage = StreamMessage & { toolCalls?: unknown[] | null };
     ```
     and change :7 to `import type { BuilderMessage as StreamMessage, DryRun } from '../../../../hooks/builderStream';`
   - `onFocusStep`: MessageBubble.tsx:17 and BuilderActivity.tsx:15,30 take `(id: string | number)`. Every handler (useBuildTabModel.ts:57 `stepId: string`, BuildTab.tsx:72 → openNdv, `DiagramHandle.focusStep(stepId: string)`) takes a string. Step ids are strings: `FlowStep.id: string`, and server builderTools.js:262 compares `added.id` with the string `edge.to`. Narrow all three to `onFocusStep?: ((id: string) => void) | null;`. At BuilderActivity.tsx:209, `as string | number` becomes `as string`: still the same unvalidated read of a tool result, now matching its consumer.
   - jsComponents.ts:145-149 → `export const MessageBubble = MessageBubbleJs;`
2. **Comments made false by B2** (comment-only, emit identical). Each one sits on a line whose shim was removed and now describes a .js module or a mismatch that is gone:
   - useBuilderTurn.ts:73 → `// revealQueue.ts is TypeScript now; the alias keeps the compiled text.`
   - AppEditorShell.tsx:69 → `// The context modules are TypeScript now; the aliases keep the compiled text.`
   - EditorHeader.tsx:36-38 ("three .jsx siblings"; SaveStatusPill is .tsx). Move the alias above the remaining comment and give it its own comment: `// SaveStatusPill is TypeScript now; the alias keeps the compiled text.` Then `// Typed views of .jsx siblings, …` above LogicaTab.
   - useDataModel.ts:18-19 → `// ConnectorsManager.tsx is TypeScript now; the alias keeps the compiled text.`
   - rowBrowserModel.ts:79-83 → `/** The datatables API calls the browser makes (datatablesApi.ts types them). */`
   - pageListShared.ts:35-36 → `// cmsPublicRouting and ModalShell are TypeScript now; the aliases keep the compiled text.`
   - SettingsFlyout.tsx:13 → `// cmsPublicRouting is TypeScript now; the alias keeps the compiled text.`
   - RecentChats.tsx:12 → `// ConvRow is TypeScript now; the alias keeps the compiled text.`
   - EditorNodeWrapper.tsx:60 (the kept shim gives the wrong reason; both siblings are TS) →
     ```
     // nodeLogicSummary calls titleFor with an action's optional automationId, and
     // useLogicMarks' titleFor indexes automationTitles with it. Typing that honestly
     // needs a runtime guard (follow-up), so this view still narrows it to string.
     ```
   - Nits, not in the diff: these header comments are now only partly true. panelJsComponents.ts:7-10, jsComponents.ts:136-139, KindFields.tsx:19, sharedTyped.ts:6-8 (MarkdownRenderer is .tsx). Fix them in the same commit if convenient.

## Kept shim / `!`: verified as needing a runtime change
- EditorNodeWrapper.tsx nodeLogicSummary: without the shim, `EditorNodeWrapper.tsx(84,75) TS2538: Type 'undefined' cannot be used as an index type`. `nodeLogicSummary.ts:146` really calls `titleFor(action.automationId)` with an optional id, and `automationTitles[id]` then reads the key "undefined". A types-only fix would need a lying cast (`id as string`) or a narrower `TitleFor`, and the narrower `TitleFor` breaks :146. Needs `id ? … : null` plus a test (follow-up).
- sitemapGraph.ts:156 `rank.get(id)!`: holds by a loop invariant (every queued id was ranked before it was pushed), not by a guard at the site. A cast would rely on a non-local guard (rejected rule). Needs a runtime change.
- sitemapGraph.ts:212 `byRank.get(r)!`: `r` comes from `byRank.keys()` 16 lines up. Same reason: non-local. Needs a runtime change.
- PromptEditor.tsx:151 `d.promptIds![0]`: read inside the setState updater, which runs later. TS keeps no narrowing of a property path into a closure, and capturing `const ids` changes the emit. Needs a runtime change.

## Accepted as is
- 6 guarded casts (B3): sitemapGraph.ts:81, :107, :133, :192 and connectorModel.ts:197 each sit on the line right after `if (!m.has(k)) m.set(k, [])` on the same local Map and key, with nothing in between. sitemapGraph.ts:190 sits inside `if (rank.has(p.id))` directly above. No closure runs later, and no outer-scope guard is involved.
- Optional fields, all read defensively:
  - `Connector.kind?`: ConnectorList passes it to `labelForKind(string | undefined)`, which returns `?.tag || kind`.
  - `SyncBlock.tableId?`: connectorModel.ts:167 uses `?.tableId`; ConnectorSyncPanel.tsx:52/62 use `find`/fallback.
  - `DesignInspector.design?`: DesignEditor.jsx:77 has `design || FALLBACK_DESIGN`.
  - `InspectorHost.activePageId: string | null`: normalizeVirtualId handles null.
  - `SyncSettings.tableName: string | undefined`.
  - `onSave … | null` (saveGate).
  - `FlowletsPanel onBuildLayer/onRefineLayer | null`.
  - `RunStepRow.status?`: read at useBuildTabModel.ts:158 as `row?.status ===`.
  - `BuildCueCall.detail | null`.
- Required-ness: `onApplyProposal: (excluded: Set<string>) => void` is required in BuildTabProps and AssistantColumnProps. It matches ProposalCard's required `onApply`, which is called unguarded (ProposalCard.tsx:76). The one caller, BuilderShell.jsx:345, always passes `applyProposal(excluded)`. `onDiscardProposal?: () => void` (no null): the only caller is BuilderShellView.tsx:63, which passes a function.
- `KnowledgePanelProps.agentId?: string` with "Accepted, never read: see the note below": the note at KnowledgePanel.tsx:38-42 explains why it is unread and pinned by a test. Declaring it is more honest than letting DesignerPanels re-declare the props. Acceptable as written.
- One home per shape: these are now aliases of the single source, with no copies left:
  - `LogicMark = LogicSummaryMark`
  - `ModelConnector = Connector`
  - `BuildCue = BuildCueValue`
  - `SyncTable` → `ModelTable` (deleted)
  - `DesignerState` and `DesignerApi` as `ReturnType<typeof hook>`
  - `ConvRowHandlers` as a `Pick` of ConvRowProps
  - `SlugIssue` (SettingsFlyout copy deleted)
  - `EditorRuntime` deleted

  BuilderMessage was the remaining duplicate (Fix 1).
- `DeleteResult` (sync or async, `false` = still there): it matches DeleteConversationDialog.tsx:27-28 (`await onDelete(); if (ok === false) return`).
- `useIntegrationCatalog` `Map<string | undefined, …>` plus `lookup(toolName: string | undefined)`: an honest widening, because `Map.get(undefined)` misses.
- `(ToolOutput)({ msg })` at MessageItem/index.tsx:167: redundant parens left by the removed cast. Same emit. Nit.

## Checks (tip + fixes, probe worktree)
- agent-hub typecheck (heavy.sh, HEAVY_SLOTS=2): exit 0, both on the tip and with the fixes. Without either kept shim, 1 error (nodeLogicSummary) and 2 errors (MessageBubble, fixed by Fix 1).
- eslint on the 55 changed files: 0 errors, 30 warnings, identical to base (30).
- `vitest related --run`: 225 files, 2938 passed.
- duplication-ratchet: production 15165/15290, test 26188/26228.
- file-budget agent-hub: OK, none past its ceiling.
- `npm run check:fast`: 39 passed, 0 failed.
