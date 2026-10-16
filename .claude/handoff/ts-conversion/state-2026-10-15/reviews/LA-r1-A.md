# Opus review LA-r1-A (la-r1-core ac6a9f7f/43f1cfb2, la-r1-insp 8c6593ee/1206356c, la-r1-tables 6c458b8b/f633a9c7; base 0ae29a17, tip fd9f2a8a): CHANGES REQUIRED

## Gate
- Types-only commits:
  - core ac6a9f7f: 5 identical / 0 different.
  - insp 8c6593ee: 4 identical / 0 different.
  - tables 6c458b8b: 1 identical / 0 different.
- The gate only sees renamed files. The already-TS edits were checked by reading:
  - builderPaneModel.ts: comment only.
  - tablesManagerModel.ts, recordsApi.ts, spreadsheetPaste.ts: type declarations only.
  - useEventWiring.ts: removed the `builderHref = automationHref as (...)` alias and calls `automationHref` directly. Compiled output differs, but the alias was the same function object, so runtime is equivalent (recipe 15d: delete the shim in the same commit). `openRunInBuilder(href: string | null)` already took the new `string | null` return.
- No D/A pairs: `git diff --name-status -M40%` shows only R entries for all six commits.
- Catch-recipe commits: every DIFFERENT hunk is checked below.

| Commit / file | Hunk | Verdict |
|---|---|---|
| 43f1cfb2 index.tsx | `err?.status === 404` → `errorStatus(err)`; `err?.message \|\| t(..)` → `messageOf(err, t(..))` | Recipe substitution |
| 43f1cfb2 studioAppsApi.ts | `err.status` → `errorStatus(err)` ×4; `...(err.body \|\| {})` → `...(errorBodyRecord(err) ?? {})` ×4; `err.message` → `errorMessage(err)` | Recipe substitution |
| 43f1cfb2 studioAppsApi.ts managedResult | `err?.managed ? {managed: err.managed}` → `const managed = managedRefusalOf(err); managed ? {managed}` (`// behaviour:` note) | EQUIVALENT for the inputs that occur. See below |
| 1206356c useExpressionEditing.ts | `e?.message \|\| 'Invalid expression'` → `messageOf(e, 'Invalid expression')` | Recipe substitution. The note (a non-string truthy message now shows the fallback) is honest and invisible for Error values |
| f633a9c7 PasteImportPanel.tsx | `err?.status === 429` → `errorStatus(err)`; `err?.message \|\| t(..)` → `messageOf(err, t(..))` | Recipe substitution |
| f633a9c7 PasteImportPanel.tsx | `err.retryAfter \|\| 60` → `retryAfterOf(err) \|\| 60` (`// behaviour:` note) | EQUIVALENT for the inputs that occur. See below |

managedResult in detail:
- `err.managed` is truthy only when `decorate` set it to `fromError(body)`. That value has a managed code, so `managedRefusalOf` takes its first branch and returns the same object.
- When `err.managed` is absent, the new code also calls `fromError(err)`:
  - With a record `.body`, it parses that same body (which already gave null in `decorate`).
  - With a null body, it reads `err.code`, which `once()` derives from that same body: null.
- `null`/`undefined` err: null both before and after.
- Inside the try there is only `request()`; a `JSON.stringify` TypeError has no managed code.
- `studioAppsApi.managed.test.ts` passes.
- `managedRefusalOf` (with its own `as unknown as`) was already at base. It is not new.

retryAfterOf in detail:
- The branch is reached only when `errorStatus(err) === 429`, so err is an object.
- recordsApi's `decorate` (recordsApi.ts:45-49) sets `retryAfter` to a positive finite number or null, never anything else. So the old `err.retryAfter || 60` and the new `retryAfterOf(err) || 60` agree for every error the code can see (0 and NaN cannot occur, and would give 60 in both).
- A string retryAfter would differ, but no producer sends one. The note is honest. Accepted.

## Forbidden constructs
- None in the six commits: no `any`, `as any`, `as unknown as`, ts-ignore/expect-error, `!`, new eslint-disable, .d.ts shims, or two statements on one line.
- The one-line `parse` in appToolCallDisplay.ts is unchanged from base.
- Fix 1 replaces one bivariance hack.
- Fix 2 deletes four now-stale `as unknown as` shims that point at modules this round converted.

## Fixes (numbered; file:line on fd9f2a8a; all types-only or a shim deletion per recipe 15d)
1. **studioAppsApi.ts:28: bivariance hack.**
   - Replace
     ```ts
     const enc: { bivarianceHack(part: string | number | boolean | undefined): string }['bivarianceHack'] = encodeURIComponent;
     ```
     with the cast form wave1 already accepted (rbac/useAppRoles.ts:112):
     ```ts
     const enc = encodeURIComponent as (part: string | number | boolean | undefined) => string;
     ```
   - It compiles to the same `const enc = encodeURIComponent;`.
   - The widening is runtime-true: encodeURIComponent does ToString, so `undefined` becomes "undefined", as the comment says.
2. **Stale shims for modules this round made TS.** Delete each shim and import the module directly. These are the same kind of change as the builderHref removal the insp branch already made.
   - a. **chat/BuilderTranscript.tsx:**
     - :11 → `import AppBuilderActivity from './AppBuilderActivity';`
     - Delete :23-24 (the comment and `const AppBuilderActivity = AppBuilderActivityJs as unknown as ComponentType<…>`).
     - :10 → `import type { ReactNode } from 'react';`
     - Delete :19 `import type { TranslateFn } …` (now unused).
     - `BuilderMessage.toolCalls` is `unknown` (index signature), so AppBuilderActivity must take what it reads defensively. In **chat/AppBuilderActivity.tsx:27-28**:
       ```ts
       export default function AppBuilderActivity({ toolCalls, running = false, t = null }: { toolCalls: unknown; running?: boolean; t?: TranslateFn | null }) {
           const calls = Array.isArray(toolCalls) ? (toolCalls as AppToolCall[]) : [];
       ```
       The cast is guarded by `Array.isArray` at the site, and the elements are stream JSON, as `AppToolCall` already documents. Gate-identical.
   - b. **chat/BuilderComposer.tsx:**
     - :9 → `… imageFilesFrom, prepareComposerImages } from './composerImages';`
     - Delete :18-21 (the comment and the `prepareComposerImagesJs as unknown as (…)` block).
     - Delete :14 `import type { TranslateFn } …` (now unused).
     - `FileList | File[]` fits `ArrayLike<File> | Iterable<File>`, and `PreparedImage` extends `StagedImage`.
   - c. **tables/TableDetail.tsx:**
     - :3 → `import TableDesigner from './TableDesigner';`
     - Delete :8-15 (the comment and the `TableDesignerJs as unknown as ComponentType<{…}>` block).
     - Delete :2 `import type { ComponentType } from 'react';`.
   - d. **editor/AppEditorShell.tsx:**
     - :28 → `import { AppEditorProvider } from '../state/AppEditorContext';`
     - Delete :81.
     - :79-80 → `// The contexts are created in .js modules with a \`null\` default.`
     - This needs the one-home change in **state/AppEditorContext.tsx:42-48**. AppEditorSeed duplicates HeaderApp's fields and says `version?: number | string`, but HeaderApp (and the server row) carry `null`, which `initialState` handles with `??`. Replace the interface with:
       ```ts
       export type AppEditorSeed = Partial<Pick<HeaderApp, 'id' | 'definition' | 'version' | 'definitionVersion'>>;
       ```
       and add `import type { HeaderApp } from '../editor/header/headerModel';` after the `./definitionOps` import. It is a type import, so scc is unaffected.
3. **index.tsx:18-24 + :104: AppUpdate duplicates chat/useBuilderTurn.ts `AppMetaUpdate`.** The two producers send a HeaderApp (the editor) and an AppMetaUpdate (the builder pane).
   - Delete the `AppUpdate` interface and its comment.
   - Add `import type { AppMetaUpdate } from './chat/useBuilderTurn';` after the BuilderChatPane import.
   - :104 → `const handleAppUpdated = useCallback((app: HeaderApp | AppMetaUpdate | null | undefined) => {`
4. Nit. In inspector/AutomationTile.tsx, the comment at :178 (`// Past the \`!automationId\` return above, automationHref cannot answer null.`) justifies the `as string` at :222. Move it next to the cast: delete :178 and insert `{/* Past the \`!automationId\` return above, automationHref cannot answer null. */}` as the line above the `<a` at :221. The guard itself is fine: `automationId` is a destructured prop, and the early return is in the same render.

All of 1-4 were checked together in the probe worktree:
- typecheck: 0 errors
- eslint: 0 errors
- vitest: the chat, tables, editor and state dirs plus index.test pass (60 files, 713 tests)
- Diff: /tmp/claude-1000/-home-tom-Projects-Bee-Flow/ea43414a-061f-49c2-9608-e64f103495c6/scratchpad/LA-r1-A-fixes.diff

## Accepted as is
- `(encodeURIComponent as (value: string | null | undefined) => string)(appId)` inline ×5:
  - Locations: useAppTables:36, useConnectors:33, useDatasets:86/94, AutomationTile:100.
  - Runtime-true widening, the same as wave1's useAppRoles. It has to stay inline: hoisting to a module `enc` would change the compiled text.
- studioAppsApi return types are `Promise<any>` through `JsonResourceRequest<T = any>`:
  - Pre-existing and documented in client.ts ("a TS caller names its type").
  - The importers saw the same `any` from the JS module before.
  - Naming T would be an unchecked assertion on a network body. Follow-up, not a blocker (see below).
- Param types checked against server/routes/studioApps/schemas.js:
  - `NewAppBody` matches CreateAppBody.
  - `publish` body matches PublishBody.
  - `checkApp` opts match CheckBody.
  - `saveDefinition(id: string | undefined, definition: AppDefinition | null, …)`: runtime-true for useEditorSave and VersionHistoryModal, as the note says.
- bi hooks against the server projections:
  - `AppTable` matches appDataContext.publicTable: id, key, name and fields with key/type always set.
  - `ConnectorSummary` matches connectors/shared.publicConnector. `integrationId` and `runAs` are not declared; no TS reader needs them yet.
  - `Array.isArray(body?.tables) ? body.tables : []` gives `any[]` from `res.json()`, the usual unchecked JSON. It is the same in the three hooks.
- Guarded casts at the site:
  - appToolCallDisplay `(tc as { added: AddedItem[] })` (ternary on `Array.isArray(tc && tc.added)`)
  - composerImages `(arrayLike as ArrayLike<T>)[i]` (the loop bound is 0 when nullish)
  - `.filter(Boolean) as File[]`
  - `result.image as PreparedImage` (else-branch of `if (result.error)`)
  - AppEditorContext `(d as number)` after `Number.isFinite(d)`
  - variableUsage `(map.get(name) as UsageSite[])` after `if (!map.has(name)) map.set(...)` on the line above (local Map)
  - TableDesigner `(option as ChoiceObject)` after `typeof option === 'object'`
- AppEditorContext's local `AppEditorState` widens `screenId` to `undefined` with a reason. It is honest inside the module. See follow-up 2 for the pre-existing cast that hides it outside.
- `UsageSite.kind: unknown`: `step.kind` comes from `walkSteps` over unknown records. Honest.
- AutomationTileRow vs useEventWiring's WiredAutomation: these are different sources. The tile's row comes from automationTitles' `AutomationRow` map (ActionsSection.jsx:309) and correctly `extends AutomationRow`. WiredAutomation is the event-wiring list. Keep both.
- AppTable (bi, viewer projection) vs ModelTable (owner schema) vs ImportTable (paste target, all optional) are three endpoints, three shapes. Keep them. Name clash only: the `AppTable` type vs the runtime `AppTable.jsx` component. Optional rename to `ViewerTable` later.
- ModelField additions (id, name, required, unique, default, options, relation, computed) are all optional, which is honest. RowRecord `id: string` is the record endpoints' primary key.
- Kept JS: all 21 files are byte-identical to 0ae29a17 at both the branch tips and fd9f2a8a. Spot-checked reasons:
  - testPayload.js:127 `formValues[mapping.name]` with an optional name: a real blocker (a cast would lie: `hasOwnProperty(…, undefined)` reads key "undefined").
  - generators.js: the nullable `makeNode` deref is real.
  - **relationOps.js** (no reason given): the only obstacle is `tables.map` at :88 after `(tables || [])` finds above. Typeable with a `tables: ModelTable[]` param if callers always pass an array. Follow-up candidate.
  - **useAppAutosave.js** (no reason given; 1 catch, no eslint-disable): a catch-recipe candidate. Follow-up candidate.

## Follow-ups (not blocking)
1. Name `T` on the studioAppsApi calls that have a real home type (getApp → `{ app: HeaderApp; readOnly?: boolean; managed?: unknown }`, listTemplates → `StudioTemplate[]`). Do it in a separate commit, since it is an assertion on JSON.
2. appEditorState.ts:49 `useAppEditor() as AppEditorValue` (pre-existing) now narrows `screenId: string | null | undefined` to `string | null`. Widening `AppEditorValue.screenId` surfaces 3 real consumers: BuilderChatPane.tsx:110, AppEditorShell.tsx:163, EditorHeader.tsx:270 (TS2322; measured in the probe). Fix those, then drop the cast.
3. relationOps.js and useAppAutosave.js: candidates for the next sweep.

## Checks run (on fd9f2a8a in /home/tom/Projects/bee-flow-la-wt/review-r1-A)
- agent-hub typecheck (heavy.sh, HEAVY_SLOTS=2): 0 errors (7m36s); with Fixes 1-4: 0 errors.
- eslint on the 19 changed files: 0 errors, 19 warnings (complexity/length, pre-existing functions).
- vitest (AppStudio index/studioAppsApi.managed/AppList + state, chat, bi, tables, inspector, editor): 113 files, 1289 tests pass.
- mobile jest csvImport.lockstep.test.ts (reads spreadsheetPaste.ts): 1 suite, 7 tests pass. No other mobile or server test reads a changed path; no importer names a converted file with an extension.
- duplication-ratchet: ✅ production 15088 / budget 15290; test 26228 at budget.
- file-budget agent-hub: ✅ none past its ceiling.

## Merge order
Apply Fixes 1-4 as one `fix(ts)` commit on sweep-a, or amend 43f1cfb2 (1, 3, 2d), ac6a9f7f (2a, 2b, 2d's AppEditorSeed) and 6c458b8b (2c). Then re-run the typecheck and the chat, tables and editor vitest dirs.
