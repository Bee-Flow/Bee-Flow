# Drafter brief: convert ONE agent-hub batch JS → TS (types only)

Worktree: $WT/b<NN>, branch ts-local/batch-<NN>, already checked out at its base (see the prompt; batches 01-12: 44072b7db; batches 13+: fe97b2c68 = base + shared blockers + caughtError helpers). Work ONLY there. Do NOT create worktrees, switch/touch other branches, stash, or push.
Prefix every typecheck / vitest / jest with `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh` (shared memory slots).
Contract: `.claude/handoff/ts-conversion/README.md`. Scope: the paths in `.claude/handoff/ts-conversion/batches/<NN>.txt` (relative to agent-hub/) and their importers/test paths. NEVER touch server/ (except a server test that reads a converted agent-hub file by path) and never convert files outside the list.

## RULES (contract)
Add TYPES ONLY (strict, noImplicitAny, React 19 / Vite, ES modules).
- Keep every expression, statement, default, JSX element and prop. Compiled JS must be byte-identical: no new temporaries, guards, `?.`, `??`, `.getTime()`, no `.filter(Boolean)` rewrites, no removed lines, imports/exports unchanged.
- Add: a Props interface per component on the destructured param; types on EVERY callback param (React events, array callbacks); return types where not inferred; generics for useState/useRef; types for module constants; `import type` for type-only imports. Prefer concrete shapes over `Record<string, unknown>`; reuse exported types nearby.
- Direct assertions on a value are fine (`e.target as HTMLInputElement`). A null-removing `as` (e.g. `x as Foo` where x is `Foo | null`) ONLY with a runtime guard at that site; a closure running later than the guard does not count unless the value cannot change in between. Never assert a value to a type it does not have.
- `TranslateFn` accepts `key: string | undefined`.
- FORBIDDEN: `any`, `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, non-null `!`, new `eslint-disable`, `.d.ts` shims, two statements on one line. Already-TS files: do not loosen their types.
- Files containing a react-hooks `eslint-disable` comment STAY JavaScript (eslint has no react-hooks rules for .ts/.tsx).
- Delete JSDoc @param/@typedef that only repeat the added types; keep every other comment. New types go ABOVE a function's JSDoc block, never between JSDoc and function.
- If a construct cannot be typed without changing runtime code (Date arithmetic, `Map.get(k).push`, nullable ref deref, `parseInt(nullable)`, `window[string]`), leave that file JavaScript, byte-identical to base.
- Extension: `.jsx` → `.tsx`; `.js` with JSX → `.tsx`, else `.ts`. Use `git mv`, then write the new content.

## Steps
1. Convert each listed file.
2. Fix importers naming a converted file WITH extension (`git grep -n "<basename>.jsx'"` / `.js'`), and `readFileSync` / `vi.mock` / source-reading paths in agent-hub, mobile and server tests.
3. `cd agent-hub && heavy.sh npm run typecheck` (project tsconfig, never isolated tsc). Fix every error with real types.
4. `git add -A && git commit -m "feat(ts): convert batch <NN> (<areas>) to TypeScript"` (end the message with the two trailer lines below). From the worktree root: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff`. Also check delete+add pairs the gate misses: `git diff --name-status -M40% <BASE>..HEAD -- agent-hub/src`, and for every D/A pair with the same stem run `node .claude/handoff/ts-conversion/state-2026-10-15/tools/pair-check.mjs agent-hub/src/<full stem without extension>`. For each DIFFERENT file: restore the logic and type only, or revert it to JS byte-identical (git mv back + `git checkout <BASE> -- <old path>`, undo importer edits). Amend; repeat until 0 different.
5. `cd agent-hub && npx eslint <changed files>` → 0 errors without eslint-disable. `node scripts/file-budget.mjs agent-hub` from the worktree root: a file past its ceiling moves its types to `<Name>.types.ts`. Targeted vitest for the tests that import the changed files: `cd agent-hub && heavy.sh npx vitest run <paths>`. If mobile/server tests read a converted file by path, run those (`cd mobile && heavy.sh ./node_modules/.bin/jest <files>`; `cd server && node --test <files>`).
5b. `node scripts/duplication-ratchet.mjs` from the worktree root must stay ✅: do not copy the same interface/prop type into several files — import it from the file that owns the shape or a nearby `*.types.ts`.
6. Do NOT update ts-ratchet, do NOT run full suites, do NOT push. Amend the single commit.

Commit trailers:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LJACbq3gq2PKUfmNJ13uXr

## Report (≤ 250 words)
Converted count (.ts/.tsx); files kept JS + exact reason each (label: "blocker <file>" or "runtime: <construct>" or "react-hooks disable"); typecheck result; gate final line verbatim + D/A result; eslint/budget/vitest results; files where a type is uncertain (for the reviewer); confirm no forbidden constructs; final commit hash.

## Caught errors (from batch 13 on; requires the branch to contain agent-hub/src/utils/caughtError.ts)
A file kept JS ONLY because a `catch` variable is read (`e.message`, `e?.status`, `e.body?.x`, `e.name === 'AbortError'`, stored in state, …) may be converted with .claude/handoff/ts-conversion/state-2026-10-15/catch-recipe.md: TOKEN SUBSTITUTION ONLY, exactly as the recipe lists. Put those files in a SECOND commit `refactor(ts): read caught errors through the caughtError helpers` (first commit = pure type conversion, gate 0 different). The gate will report the second commit's files as DIFFERENT; that is expected — list them in the report with, per file, the substitutions made, and any `// behaviour:` note. Anything outside the recipe's substitutions → keep the file JS.

## Mobile lockstep ports (duplication ratchet)
If a converted web file becomes text-identical (or nearly) to its mobile port (`mobile/src/**`, often a `*.lockstep.test.ts` compares them), do NOT copy types into the port. Report it in a "mirror candidates" list (web path, mobile path, real phone-only differences). Mirroring via scripts/shared-mirror.manifest.json is done in a separate integrator step.
