APPROVED. All four splits preserve behaviour, every gate passes and the merge with HEAD 202bda88 is clean. Four non-blocking notes below.

# Opus review S3 LF-A7 (s3/lfa7 = b68661cb, b8915d1b, 8d729c68, 2884fe54 on 15277b17)

Reviewer: Opus, read-only. Method:
- read each base file next to the new files;
- compared the multisets of className, t(key, fallback), data-testid, aria-*, title and style={{}} per commit, base against head;
- compared the multisets of stripped source lines, to surface every line that was not moved verbatim;
- ran four mutation probes on the originals.

## Non-blocking

1. **OnboardingTour.test.tsx:399 uses the forbidden `as unknown as`:** `predicate: (detail) => (detail as unknown as { good?: boolean })?.good === true`.
   - Cause: `lessons.types.ts:26` types `predicate?: (event: Event) => boolean`, but useTourStepInteraction.ts:39 (and base) call it with `e.detail`. The type was wrong before this branch.
   - Fix (test only): `predicate: (detail) => 'good' in detail && detail.good === true`. That narrows without a cast.
   - Optional: correct the type to `(detail: unknown) => boolean` in a separate commit.
2. **GitHubSyncActions.tsx:31 has an undeclared guard rewrite.** Base read `status.overview?.pending > 0`; this branch reads `overview && overview.pending > 0`.
   - The rendered output is identical: base yields `false`, the new code yields `null` or `undefined`, and React renders nothing for any of them.
   - TypeScript strict mode rejects the base form, so I accept the rewrite.
   - Add one `// behaviour: none (TS needs the guard)` line to 8d729c68's message.
3. **Moving useGitHubSync.ts from .jsx to .ts takes it out of react-hooks lint.** eslint applies react-hooks only to JS (same issue as S3-lf-a6 #2).
   - Base had no react-hooks `eslint-disable`, and the dependency arrays are byte-identical, so nothing is wrong today.
   - The other three files were already TS.
4. **Test gaps that mutation probes on the originals revealed.** The 4 new tests pass on the originals: 107/107. I then ran 4 mutation probes. Two were caught: dropping `selectedId` from the SSE deps, and disconnect not clearing `repoOwner`. Two survived:
   - TranscriptionSection.test.tsx:239: `setHasWhisperxToken(true)` made unconditional goes unnoticed. Fix: add a successful URL-only save that asserts the token placeholder is still 'Leave empty…'.
   - OnboardingTour.test.tsx:141: the focus effect with deps cut to `[active]` goes unnoticed. Fix: step to step 2 and assert that the card has focus again after the 60 ms delay.

## Checked and OK
- **Hook and effect order** (base vs new):
  - Support: effects run fetchThreads → fetchMailbox → selection → activity → SSE → canned, in base and new alike. All useMemo/useCallback/useEffect deps are identical. Only useState slots moved between hooks, which is harmless.
  - GitHub: useTranslation, then 12×useState, useConfirm, useCallback, then 2 effects, in the same order.
  - Onboarding: autostart → replay → per-step rAF → reposition → advance → keyboard → focus, then the useMemo. Deps are identical, and every cleanup (cancelAnimationFrame, removeEventListener, clearTimeout) is unchanged.
  - Transcription has no hooks besides `t`.
- **SSE stream:** the open, listeners, `onerror` no-op and close-on-cleanup are verbatim, and the deps still include `selectedId`, so refreshOpen sees no stale closure.
- **API files:** every authFetch has the same URL, method, headers and body. The source changed from utils/helpers to api/mutate, which re-exports the same function, and response handling is unchanged.
  - supportInboxApi's shared `JSON_HEADERS` is harmless, because authFetch copies the headers.
  - Credentials (Azure, WhisperX, Scaleway and pyannote keys) are only serialised into the request body, as before. Nothing new is stored or logged. `{...props}` goes only to the card components, never to the DOM.
- **errorMessage(e):** it replaced `(e as Error).message` (TS) and `err.message` (GitHub JS). The two differ only for a null rejection, and no user-visible text changed.
- **GitHubRepoCard `config` required:** accepted. Base read `status.config.repoOwner` unguarded in the same branch, and the caller is JSX.
- **Forbidden constructs:** none in production code. Types are not loosened.

## Gates
- **Branch worktree:**
  - typecheck rc 0
  - eslint on changed files: 0 errors, 14 warnings (size and complexity)
  - vitest (support, onboarding, integrations/github, IntegrationsAdminPanel, and the OrgSettings and OrganisationSection tests): 22 files, 331 tests pass
  - knip clean
  - check:fast 39/39
  - long-function 253
  - duplication: production 15100 (= base), test 26228 (at budget)
  - lint:budget: agent-hub 4784/6674. There is 1 server error, which is pre-existing on base: `catalog.sections.test.js:18` has an unused `path`, fixed on HEAD.
  - file-budget OK
  - No mobile or server test reads the moved files by path.
- **Merge onto 202bda88:** no conflicts.
  - typecheck rc 0
  - long-function 251
  - duplication production 15152 (= HEAD)
  - check:fast 39/39
  - vitest (support, onboarding, all of integrations, the 2 pages): 28 files, 367 tests pass
  - knip clean

Scratch worktrees removed.
