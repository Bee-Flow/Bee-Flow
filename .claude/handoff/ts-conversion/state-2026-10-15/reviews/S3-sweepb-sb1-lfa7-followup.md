s3/sb1 APPROVED (f37cf9d4) · s3/lfa7 follow-up 49ad7cd8 APPROVED · merge f1495297 + sb1 + lfa7: clean, all gates green

# Opus review: SWEEP-B SB1 (Studio Datatables + Approvals) and the LF-A7 follow-up, base 15277b17

Reviewer: Opus, read-only. Scratch worktrees under scratchpad/rev-sb1/ (removed).

## A. SB1

### Gate
| Check | Result |
|---|---|
| 73df7a89 `ts-equivalence 15277b17 73df7a89 --diff` | 1 identical, 0 different (NamesStep.tsx) |
| D/A pairs (`-M40%`), both commits | none (every rename is R084–R093) |
| f37cf9d4 `ts-equivalence 73df7a89 f37cf9d4 --diff` | 2 different (AiTablePanel, RetentionPanel); every difference is a recipe token plus the helper import (see 2) |
| Forbidden constructs in added lines (`any`, `as any`, `as unknown as`, `@ts-*`, `!`, eslint-disable, `as Error`, `.d.ts`) | none |

### Findings (none blocking)
1. **NamesStep.tsx:8-14, Props: ACCEPT.**
   - Every prop reuses an existing type. `SheetSelection` comes from wizardState.ts:75. `selection` is a Map, `marks` is a `Map<string,string>` (LinkSpreadsheetDialog.jsx:55, "fileKey | sheetKey → sentence"), and `keyDup` is `string[]` (l.162-166).
   - `onChange` matches `setSel(sheetKey, patch)` (l.82).
   - The only importer is LinkSpreadsheetDialog.jsx:272. The `NamesStep` in LinkNextcloudTablesDialog.jsx:315 is a different, local component.
2. **Catch commit: every difference is a recipe substitution.**
   - AiTablePanel.tsx:75-82:
     - `err?.code` → `errorCode(err)`
     - `err?.status === 429` → `errorStatus(err) === 429`
     - `err?.message || t()` → `errorMessage(err) || t()`
   - RetentionPanel.tsx:115-117:
     - `e.code ===` → `errorCode(e) ===`
     - `e.message || t()` → `errorMessage(e) || t()`
   - **`errorMessage(x) || t(...)` instead of the recipe's `messageOf(x, t(...))`: ACCEPT.**
     - `messageOf` is literally `return errorMessage(e) || fallback` (caughtError.ts:49-51), so the semantics are identical.
     - The only difference is that `t()` is evaluated lazily instead of eagerly, and `t` is pure.
     - Optional: switch to `messageOf` for grep-uniformity with the recipe table. It is not required.
   - **`errorText(t, err: unknown)` follows recipe 15c.** Its only caller is AiTablePanel.tsx:127 (`setError(errorText(t, err))`, within the same file). It returns `string`, so `useState<string | null>` is honest.
   - The commit body states the null/undefined and non-string-message differences, as caughtError.ts does. No other catch reads in either file: ExpiringSoon's `.catch(() => …)` reads nothing.
3. **New types in AiTablePanel / RetentionPanel are honest, with nothing required where the code is defensive.**
   - `AiTablePanelProps`: `mode`, `current`, `compact` and `testId` are optional, matching their defaults.
   - `AiTableCurrent`/`AiTableDraft` are all-optional, plus an index signature (the server draft also carries `key`).
   - `RetentionTable`: only `id` is required. It is read unguarded (`table.id`), and the rest is optional.
   - `columns?: DtColumn[]` reuses rowBrowserModel.ts:11. `RetentionChoice = 'off' | 'custom' | number` matches the SegmentedControl options.
   - `CSSProperties` on CARD/CONTROL.
   - Nits (optional, not blocking):
     - AiTablePanel.tsx:10/18/28 export three interfaces that nothing imports. The callers ColumnDesigner and NewDatatableDialog are JS. Drop `export` or keep it for a later caller; knip runs with `--include files`, so it does not care.
     - `AiTableCurrent.description?: string`: ColumnDesigner.jsx:247 passes `table.description`, which may be null. Widen it to `string | null` when ColumnDesigner converts.
4. **Path edits are complete.**
   - mobile retention.lockstep.test.ts:2/26 and retention.ts:3 now name RetentionPanel.tsx. The lockstep test still runs (4 passed, not skipped).
   - `git grep` finds no other stale `.jsx` names (except batches/07.txt and 08.txt, which are historical lists) and no ci.yml or .file-budget keys.
   - file-budget: none past its ceiling.
5. **The 73df7a89 message gives no per-file kept-JS reasons** (the drafter's report was lost). The full table follows, reconstructed by trial conversion.

### SB1 kept-JS table (22 files)
Method:
- `git mv` all 22 files to .ts/.tsx, then a full typecheck. Errors other than implicit-any were read per file.
- A second trial converted only the 11 smallest candidates.
- SheetsStep was typed in full: its single remaining error is the blocker named below.

| File | Label |
|---|---|
| Approvals/ApprovalDecisionControls.jsx | runtime: `o.value ?? o` on string-or-object select options (`key=`, `value=`), and `value ?? ''` on an answer that may be `true` (checkbox) fed to `<input value>` |
| Approvals/ApprovalDetail.jsx | blocked by hooks/useAutomationApi.ts (`getApproval`/`decideApproval`/`withdrawApproval` return `Promise<unknown>`; `res.…` and `{...res}` need a guard) |
| Approvals/ApprovalsStudio.jsx | blocked by useApprovals.js (inferred `{status=null,q=null}` params reject strings, l.32) and ApprovalDetail.jsx |
| Approvals/useApprovals.js | blocked by hooks/useAutomationApi.ts (`listApprovals`/`approvalFacets` return `Promise<unknown>`; `list.rows`, `f.facets`) |
| Datatables/ColumnDesigner.jsx | runtime: catch reads `e.managed` / `e.managed.message` (recipe "do not rewrite" item 2). Also blocked by NewDatatableDialog.jsx (TypeSelect) |
| Datatables/DatatableDetail.jsx | runtime: `mirror.source` on the nullable `useSourceMirror` result (l.541), `onDuplicate()` with a `null` default inside a later closure (l.449). Also blocked by shared/StudioSectionHeader.jsx, DangerZone.jsx, Forms/answers/AnswersDashboard.jsx |
| Datatables/DatatableSharing.jsx | runtime: `confirm.descriptor` in the `onConfirm` closure (nullable state, l.322). Also blocked by datatableDisplay.js (`describeAccess(…, t = null)` rejects a TranslateFn, l.105) |
| Datatables/DatatablesStudio.jsx | blocked by shared/StudioSectionHeader.jsx (required inferred props, l.120), DatatableDetail.jsx, NewDatatableDialog.jsx |
| Datatables/ImportPanel.jsx | runtime: `res?.errors` / `res?.inserted` on `onImport`'s result. RowBrowser.tsx:121 passes `rowsApi.bulkImport`, which returns `Promise<unknown>` (rowBrowserModel.ts:101) |
| Datatables/LinkNextcloudTablesDialog.jsx | blocked by NewDatatableDialog.jsx (`TitleRow({ icon = null })` rejects a LucideIcon, l.189) |
| Datatables/LinkSpreadsheetDialog.jsx | blocked by NewDatatableDialog.jsx (TitleRow, l.228), plus FileBrowser.jsx and SheetsStep.jsx |
| Datatables/RelationsCard.jsx | runtime: `mirror.setRelations()` after `mirror?.source` (mirror read as nullable) |
| Datatables/RowFilterBuilder.jsx | runtime: `<input value={row.value ?? ''}>` with `RowFilter.value: unknown` (rowBrowserModel.ts:57, the TS type RowBrowser.tsx passes) |
| Datatables/SourceMirrorPanel.jsx | runtime: `mirror.refreshNow()` after `mirror?.source`. Also blocked by RelationsCard.jsx and SpreadsheetSourceCards.jsx |
| Datatables/SpreadsheetSourceCards.jsx | runtime: `mirror.relink()` after `mirror?.source` |
| Datatables/datatableDisplay.js | runtime: `before.get(k).type` (Map.get deref after `has`, l.249-250). Already listed in S3-report |
| Datatables/linkWizardShared.jsx | runtime: correlated guard, `draftRel && … fromSel.name / toSel.key` and `onAdd(draftRel)` with `draftRel` nullable |
| Datatables/sourceMirrors.js | runtime: `const body = err?.body \|\| {}` then `body.ref?.provider`. The recipe gives `Record<string, unknown>`, so `.ref` is `unknown` and needs a guard |
| Datatables/spreadsheet/FileBrowser.jsx | runtime: `more()` passes `provider` (`string \| null` state, no guard in that closure) to `browseSpreadsheets({provider: string})` |
| Datatables/spreadsheet/SheetSection.jsx | blocked by NewDatatableDialog.jsx (`TypeSelect({ types = COLUMN_TYPES })` infers a mutable array; `INFERABLE_TYPES` is readonly, l.93) |
| Datatables/spreadsheet/SheetsStep.jsx | blocked by sourceMirrors.js (`writeCaveatText(t, mode, reason = null)` rejects `string`, l.123). Fully typed in the trial with wizardState types; this is the only error left |
| Datatables/useSourceMirror.js | runtime: `api.update/setRelations/relink` on `api = API[kind] \|| null` (nullable deref) |

Missed: none. No file in the folder converts with types only or the catch recipe alone.

Follow-up leverage: converting NewDatatableDialog.jsx (TitleRow `icon`, TypeSelect `readonly types`) and sourceMirrors.js unblocks SheetSection, SheetsStep, LinkNextcloudTablesDialog and LinkSpreadsheetDialog. Note that sourceMirrors.js needs the body guard first.

### Gates (sb1 head f37cf9d4)
- typecheck: rc 0
- eslint on the 3 changed files: 0 errors, 4 warnings (size and complexity of the two panels; the same functions as in JS)
- vitest on Datatables + Approvals: 25 files, 349 pass
- mobile jest, retention.lockstep: 4 pass
- check:fast: 39/39
- duplication: production 15100, test 26228 (at budget, not over)
- ts-ratchet: 1952 (budget 1955)
- file-budget: OK

## B. LF-A7 follow-up 49ad7cd8 (findings 1, 2 and 4 of S3-lf-a7.md)
1. **Finding 1: done.** OnboardingTour.test.tsx:410 is now `predicate: (event) => 'good' in event && event.good === true`, with no cast. No `as unknown as` was added anywhere on the branch (`git diff 15277b17..HEAD | grep '^+.*as unknown as'` is empty). The two other hits in onboarding/ are pre-existing.
2. **Finding 2: done.** The 49ad7cd8 body declares `behaviour: none — GitHubSyncActions.tsx:31 …`. It sits in the follow-up commit rather than amending 8d729c68, which is fine for a non-squashed branch.
3. **Finding 4: done.**
   - Both new tests (TranscriptionSection.test.tsx:250, OnboardingTour.test.tsx:147) pass on the ORIGINAL files at 15277b17: 2 files, 56/56.
   - Mutation probes on the originals:
     - TranscriptionSection.tsx:357 with `setHasWhisperxToken(true)` made unconditional: caught ("does not mark a token as saved…" fails).
     - OnboardingTour.tsx:339 with the focus deps cut to `[active]`: caught ("moves focus back to the card on every step" fails).

Gates (49ad7cd8):
- the 4 LF-A7 test files: 109 pass
- typecheck: rc 0
- check:fast: 39/39
- duplication: 15100 / 26228
- eslint on both tests: clean

## C. Merge test: f1495297 + s3/sb1 + s3/lfa7
- Conflicts: none.
- typecheck: rc 0
- check:fast: 39/39
- duplication: production 15152, test 26228 (at budget)
- long-function agent-hub: 251 (budget 257)
- ts-ratchet: 1934 (budget 1955)
- vitest on Studio (excl. AppStudio) + support + integrations + onboarding: 193 files, 2692 pass
- mobile jest `src/features/datatables`: 13 suites, 110 pass
