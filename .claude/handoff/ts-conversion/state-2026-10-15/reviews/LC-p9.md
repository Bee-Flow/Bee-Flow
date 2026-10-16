# Opus review L-C p9 (retry: appCatalog, LibraryFilters, MeetingVisibility, useAppsCatalog): APPROVE, no fixes required; merges cleanly onto 1c72d170 and every check is green
Base e61d29d8. Branch lc/p9: 779da4b0 (types), 14a85b0d (caughtError), 9bee6956 (useAppsCatalog local aliases).

## Gate
- `ts-equivalence e61d29d8 779da4b0 --diff`: **2 identical, 0 different of 2 converted files**.
- `ts-equivalence e61d29d8 HEAD --diff`: **2 identical, 1 different of 3**. The only difference is MeetingVisibility.tsx: `${e.message}` → `${errorMessage(e)}` plus its import. That is exactly the recipe row for a template literal (it still prints "undefined" as before). Nothing else changed.
- pair-check (PAIR_BASE=e61d29d8): appCatalog IDENTICAL, LibraryFilters IDENTICAL, MeetingVisibility DIFFERENT (the same substitution). The "fatal: path … .js/.ts does not exist" lines are the tool probing other extensions; they are harmless.
- **useAppsCatalog.ts (already TS, so the gate does not cover it), checked independently** with the gate's own `compile()` (esbuild + normalise) on `git show <rev>:agent-hub/src/hooks/useAppsCatalog.ts`:
  - 779da4b0 is DIFFERENT from base. It removed the `const buildCatalog = …` / `filterApps` aliases, so the call sites changed names.
  - HEAD (9bee6956) is IDENTICAL to base. The aliases are now plain assignments, and the `import type` line and the dropped `type ReactNode` / `type IntegrationStatus` specifiers compile away.
  - The fix commit is correct.
- `git diff --name-status -M40%`: 3 renames (R083/R086/R088) + 1 M. No unpaired D/A.

## Merge test (scratch worktree from 1c72d170 + `merge --no-ff lc/p9`, since removed)
- Clean merge, no conflicts.
- agent-hub `npm run typecheck` (heavy.sh, 4 slots): exit 0.
- `node scripts/duplication-ratchet.mjs`: ✅ production 15172 ≤ 15290; test at budget.
- `npm run check:fast`: 39 passed, 0 failed.
- Targeted vitest (`--maxWorkers=4`): **55 files, 992 tests passed**. Covered: components/apps, components/cowork (includes useCoworkApps, CoworkComposer), InputArea composer/coworkMode/footer/kbPill, pages/meeting-notes/library + detail (includes MeetingVisibility.test, LibraryFilters.counts.test, MeetingLibrary.error.test, MeetingDetail.*), useIntegrationStatus, EmptyChatState, MeetingsTab, FilterPills.
- eslint on the 4 files: 0 errors. The 2 warnings (complexity in filterAvailableApps, max-lines in LibraryFilters) already exist at base. The base also had 2 `import/order` warnings, now gone.

## Checked, OK
- **Forbidden constructs**: none in the diff (any, as any, as unknown as, @ts-*, `!`, new eslint-disable, .d.ts). The diff adds no `as` at all: the two `as` view casts in useAppsCatalog are removed. The existing `integrationStatus.enabledApps as string[]` and `orgEnabledIntegrations as string[] | null` are unchanged base lines.
- **No react-hooks eslint-disable** in any converted file.
- **Types vs JSDoc placement**:
  - MeetingVisibilityProps sits above the component's JSDoc block.
  - appCatalog's interfaces sit after the module header and before the TW_SIZE_TO_PX comment.
  - LibraryFilters' TagCount/LibraryFiltersProps sit after SORT_IDS. The rail JSDoc is a module-level block above VISIBLE_TAGS, not attached to the function.
  - SortMenuProps follows `export { FilterChip };`, whose JSDoc documents the re-export.
  - Nothing sits between a JSDoc block and its function.
- **Honest types**:
  - `McpServerSource.toolCount?`: correct. The server payload may omit it; the hook filters `(s.toolCount ?? 0) > 0`, and the description template prints it as the JS did.
  - `ExposedStepSource` (new): `title`/`description`/`category` are optional and every one has a JS fallback (`|| 'Step'`, `|| 'Reusable Step'`, `(s.category && s.category.trim()) || 'Steps'`). `icon?: string | null` is accepted by StepIcon (typecheck 0).
  - `useState<ExposedStepSource[]>` replaces `unknown[]`. This is a tightening of an already-TS file, not a loosening.
  - `AppAvailabilityGates.integrationStatus?: IntegrationStatus`: the import from api/queries/integrationStatus is the same type that hooks/useIntegrationStatus re-exports (`Record<string, unknown>`), so `= {}` is valid.
  - LibraryFilters `sort: string` is honest: sortLabels is `Record<string, string>` and the caller holds `useState('recent')`.
  - LibraryFilters owner `'all' | 'mine' | 'shared'` is honest. The only producer is LibraryFilters itself: the three FilterChips call `onOwnerChange('all' | 'mine' | 'shared')` with literals. The caller (MeetingLibrary.jsx, still JS) only stores the value via `useState('all')` and compares it to `'mine'` and `'shared'`. When MeetingLibrary becomes TS it needs `useState<'all' | 'mine' | 'shared'>('all')`, which is the correct contract. The asymmetry with `sort: string` is acceptable; a `SortId` union would also be honest but is not needed.
  - MeetingVisibility: `meeting?: MeetingNote | null` reuses meetingDetailTypes, and `OrgGroup` reuses VisibilityCapsule.types. The `onChange` payload matches what MeetingDetail.jsx destructures (`{ isPublished, sharedGroups }`). `meeting?.projectId` reads through MeetingNote's index signature and is only tested for truthiness.
- **CatalogApp export change** (an interface with `[key: string]: unknown` became `type CatalogApp = AppDef`):
  - The only TS consumer is components/cowork/useCoworkApps.ts (`import type { CatalogApp }`, `EMPTY_APPS: CatalogApp[]`). InputArea/index.jsx is JS.
  - Dropping the index signature broke nothing (typecheck 0).
  - The other `CatalogApp` names in automation/Builder and App Studio are unrelated local interfaces with the same name.
- **Importers with extension / source-reading tests**: none in agent-hub, mobile or server reference `appCatalog.jsx`, `LibraryFilters.jsx` or `MeetingVisibility.jsx` by path.
- **node_modules**: nothing tracked (`git ls-files | grep node_modules` = 0). The worktree is clean.
- **Scope**: types-only + one recipe substitution, in a separate commit. No runtime rewrites. 9bee6956 restores byte-equivalence rather than accepting a rename.

## Follow-ups (not blockers)
1. **Duplicate shape: AppsPicker.tsx:24 `export interface AppDef`.** It is a narrower copy of appCatalog's AppDef (id/label/description/iconSvg/isStep), and its doc line still says "as appCatalog.jsx builds it". In a later pass, replace it with `import type { AppDef } from './appCatalog'` (or `Pick<AppDef, …>`) and fix the comment.
2. **Duplicate shape: LibraryFilters `TagCount { tag; count? }`** vs useMeetingTags.ts:11 `TagCount { tag; count: number }`. The hook's type is not exported. The optional count on the props side is a deliberately wider input (the component guards `b.count || 0` and `typeof r.tag === 'string'`), so leave it. If it is unified later, export the hook's type and use `Partial<Pick<…,'count'>>`.
3. **useAppsCatalog's `buildCatalog` / `filterApps` aliases**: their comment explains they are only kept for byte-equivalence. They can be inlined in a runtime-change PR outside this conversion's scope rule.
4. **Stale `.jsx` mentions in comments**: AppsPicker.tsx:23, mobile/src/features/recording/components/LibraryFilters.tsx:3, mobile/src/features/recording/model/library.ts:4, and the handoff curriculum facts. They are cosmetic; fix them during the next comment sweep.

## Fixes
None. No fix diff (LC-p9-fixes.diff not written).
