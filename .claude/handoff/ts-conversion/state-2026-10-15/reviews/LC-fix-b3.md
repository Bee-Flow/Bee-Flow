# Review: ts-laptop/fix-b3 @ 48d6ebb2 (base 060da5ca), final-review B3

Verdict: **APPROVE WITH FIXES.** All 136 changed agent-hub files are correct substitutions. But B3 is
not complete: the drafter's grep missed 15 caught-error casts that the branch added (11 files). The
fixes are in `LC-fix-b3-fixes.diff` (12 files, against 48d6ebb2, verified).

## Method
I compiled base and head of every changed `agent-hub/src` file with `compile()` from
scripts/ts-equivalence.mjs and diffed the JS (1852 lines). 10 files compile to identical JS (only
types changed). I read every hunk of the other 126. I read the type-only changes in the TS diff.

## Site-by-site results (all OK)
- Mapping rows are right throughout:
  - `messageOf` is only used with a string literal, a `t()` call, or a ternary of `t()` calls (useSheetActions).
  - `describeError` is only used for `String(x?.message || x)` / `x?.message || String(x)` shapes.
  - `errorMessage(e) || String(e)` keeps the non-literal fallback, as the recipe says.
  - `errorStatus`, `errorCode`, `errorBodyRecord`, `errorName` and `isAbortError` are each used only where the original read that field.
- 1 MermaidRenderer `isStaleChunkError`: equivalent for every Error. `(err?.message || err || '').toString()` reaches `err.toString()` only when the message is empty or missing. Then `String(err)` calls the same `toString` ("Error"). For a string, null or undefined the result is identical. Only `{message: <non-string>}` differs, and that cannot match the substring tests. No change needed.
- 2 useAppRoles 409: same values. `Number.isInteger` is false for anything that is not a number. A string body gives undefined before and after.
- 3 `Boolean(x) && <jsx>`: the same in boolean context. The only rendered difference is a caught value of `0`/`''` (React rendered "0"). Every value read is through the helpers. UpcomingMeetings `if (err?.code)` → `if (errorCode(err))`: a numeric code (DOMException) no longer counts. This is the documented helper difference, and these APIs throw TranscriptionsApiError with string codes.
- 4 MeetingLibrary.jsx: the import is right, and it renders under `error &&`, so the value is the same.
- 5 PublicFormRenderer `'fields' in err`: `in` walks the prototype, so this equals `err?.fields` for objects. Primitives give undefined in both. The `hasServerMessage`/`hasRetryAfter`/`isFormulaThrow` guards accept any object, so the read is equal. `Number(undefined)` is NaN, as before. Editor bundles are up to date.
- 6 useDocumentAutosave: `details || {}` → an object guard. A truthy primitive `details` gave `undefined` for both reads before and gives `{}` → null now. The result is the same, `?? null`.
- 7 Widened `string | undefined` (Toast, SubMessage, BulkResult, onError props, VersionParts, usePageGuards) is honest, and typecheck is green.
- 8 session.ts: `messages?: BuilderMessage[]` is a declared wire type like its neighbours, and the compiled JS is identical. Acceptable.
- 9 Blank-line removals: 15 files lose a blank line (the commit says 7). Only whitespace changed: no comment lines were removed and the JS diffs show only substitutions.
- No forbidden constructs added. `currentVersion as number` (useAppRoles) carries over from the base (minor: `typeof x === 'number' &&` would drop it). No node_modules committed.
- Open (not done, as the drafter says): `settingsFields.ts:333` asArray `any[]` leak.

## Findings: missed caught-error casts (branch-introduced), fixed in the diff
1. `useMeetingCommands.ts:115`: `e as ApiError` → `errorCode(e)` / `errorMessage(e)`.
2. `UpcomingMeetings.tsx:249/254/259`: `SourceState.error` → `unknown`, render via `Boolean()` and `errorMessage`.
3. `RulesPanel.tsx:416/435`: `RulesState`/`RunsState.error` → `unknown`, line 605 → `errorMessage(rules.error)`.
4. `PublicAppPage.tsx:149`: `PageState.error` and the `NotAvailable` prop → `unknown`, with `errorStatus`/`errorMessage`.
5. `SettingsFlyout.tsx:105`: `error as Error | null` dropped, line 233 → `errorMessage(error)`.
6. `usePageGuards.ts:28` and `usePreviewToken.ts:60`: `isAbortError` + `errorMessage`.
7. `EncryptionSetup.tsx:52/101`: `errorMessage(opaqueErr)`. One blank line removed for the file budget.
8. `useDataModel.ts:90`: `errorStatus` + `messageOf`.
9. `useRowWrites.ts:86`: `errorCode` + `errorBodyRecord(e)?.limit`.

## Residual-grep classification
The B3 grep has 13 matches, none of them caught errors:
- 11 `CustomEvent` casts (the commit says 13).
- `aiAutoMap.ts:120`: an enum param.
- `useAiFill.ts:71`: a parsed body.

These caught-error casts are on origin/main already, so they are out of scope for B3. I list them for a later sweep:
- `securityKeys.ts:126`
- `useImportFile.ts:109`
- `aiAutoMap.ts:345`
- `useStepPatchSave.ts:55`
- `AtomRenderer.tsx:51`
- `DocumentEditor.tsx:88`
- `NotebookDetail.tsx:35`
- `Microsoft365Integration.tsx:127`
- `useSheet.ts:193`

## Verification (scratch worktree at 48d6ebb2 + fixes)
- typecheck: clean.
- eslint, 148 files: 0 errors. The fixed files went from 15 to 14 warnings.
- lint:budget: 4585 warnings, under the budget of 6674.
- vitest over the 83 touched dirs (maxWorkers 4): 1170 files and 13363 tests passed.
- check:fast: 39/39.
- duplication-ratchet: production 15166 (budget 15290), test 26188 (budget 26228).
- lint:editor-bundles: up to date.
- file-budget agent-hub: OK.
