APPROVED. Both splits preserve behaviour. The JSX moved verbatim, hook and effect order and deps are unchanged, and the catch swap is an exact recipe substitution. All gates pass, and the merge with sb2 and sb4 is clean. Three non-blocking notes below.

# Opus review S3 LF-A8 (s3/lfa8 = 1ff834fe, ca987e28 on 15277b17)

## Non-blocking
1. **The test fixture uses JSON.parse** (NewDatatableDialog.flows.test.tsx:21).
   - I confirmed the cause with a tsc probe: `scope = null` in the JS component infers the prop as `null | undefined`.
   - JSON.parse makes ORG_SCOPE `any`. That is the forbidden `any` under another name, though here it is honest at runtime and limited to the test. The comment explains it, so I accept it.
   - A typed wrapper (`NewDatatableDialog as ComponentType<…>`) would be worse: it asserts a type the value does not have (the S3-lf-a2 #3 ruling).
   - A cleaner fix, if wanted: add a comment-only JSDoc above the component in NewDatatableDialog.jsx:103, `/** @param {{ scope?: { kind: string, id?: string, label?: string } | null, onClose: () => void, onCreated: (t: unknown) => void, user?: object | null }} props */`. The test can then use a plain typed literal. Leave it as is if the .jsx must stay unchanged apart from the split.
2. **accessScreenTypes.ts repeats shapes accessApply.ts already exports.**
   - ScreenPlan restates AccessPlan.
   - AccessControlsCard.tsx:24 `members: { userId; roleKey }[]` is AccessMember.
   - Optional tidy: `type ScreenPlan = AccessPlan & Required<Pick<AccessPlan, 'roles' | 'byGroup' | 'members'>> & { unresolved?: …; note?: string }` and `members: AccessMember[]`. The duplication ratchet does not flag it (production 15100 = base).
3. **`ncWords={ncMenuWords(ncResult, t)}` (AccessStage.jsx:225) is now evaluated on every render.** Base called it only when `ncResult && !applyError`. It is pure, returns null for null, and `t` has no side effects, so nothing changes in practice.

## Checked and OK
- **AccessStage.**
  - A whitespace-normalised diff of base :192-543 against the four card `<section>`s finds only the 3 intended prop swaps:
    - `discard` = the same 3 setters
    - `planEmpty` = `plan.empty`
    - `ncWords` = `ncMenuWords(ncResult, t)`
  - The gate card is rendered unconditionally, as in base.
  - The hooks, setPlan closures and the rule, role and plan code all stayed in the .jsx. Only `AUDIENCES` moved (now `as const`).
  - The i18n key, testid, aria, className and style multisets are identical to base.
- **NewDatatableDialog.**
  - State slot order: linkable now comes after picking and linked. No effect, memo or callback depends on slot position. The two effects keep their relative order and their deps (`[offerNextcloud, canChoose]`, `[canChoose]`).
  - The catch swap `e?.code` → `errorCode(e)` is an exact recipe substitution.
  - `submitDraft` is called fresh on every render with the current values, the same capture as base's closure. No value goes stale.
  - `applyDraft` and `orgScopeChoice` are verbatim, with the same call order (mayCreateOrgTable before canLinkNextcloud).
  - `reasonText`, both modals, the footer, the fields and the audience card: the key, class and style multisets are identical to base.
  - FirstColumns is passed as an element and mounted only under the same `!managed && !linking` condition.
- **useLinkSources.ts react-hooks lint.** I linted the new TS files with the react-hooks rules switched on: 0 findings beyond size.
- **Tests.** Both flow tests use userEvent, with no fireEvent. They add 0 test duplication (26228 = base). Run against the ORIGINAL .jsx files at 15277b17, they pass 20/20.

## Gates (in the lfa8 worktree)
- agent-hub typecheck: 0 errors ✅
- eslint on 17 files: 0 errors, 9 warnings (base AccessStage alone had 16) ✅
- vitest Playbooks + Datatables: 42 files, 491 tests ✅
- lint:dead ✅
- check:fast 39/39 ✅
- long-function **255** ✅
- big-file 189/190 ✅
- duplication: production 15100 (Δ0), test 26228 ✅
- ts-ratchet 1955, at budget ✅

## Merge test (593cfcd4 + lfa8 + sb2 + sb4)
- All three merge with no conflicts; sb2's accessView.js → .ts sits beside the new cards.
- Merged tree: typecheck 0 errors ✅, long-function 255 ✅, duplication production 15126 and test 26228 ✅, ts-ratchet 1946 ✅

## Resolution (integrator S3)
- APPROVED, merged as is. 1 (JSON.parse test fixture for a JS `scope = null` prop), 2 (accessScreenTypes.ts restates AccessPlan/AccessMember from accessApply.ts) and 3 (ncMenuWords on every render, pure) are listed as optional tidy-ups in split/S3-report.md.
