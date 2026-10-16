# PR description (draft, kept current by the integrator; used when the PR is opened)

## Why TypeScript

agent-hub (the React frontend) moves from JavaScript to TypeScript. The server stays JavaScript by design.

**What it buys us**
- **Mistakes surface at build time, not in production.** A wrong prop name, a missing field or a value that can be
  `null` is a compile error instead of a blank screen or a silent wrong answer for a customer. The conversion itself
  proved the point: once `resolveBinding` was typed, 16 App Studio call sites turned out to pass values the resolver
  did not expect, and a record-detail field formatter was narrower than the data it really receives.
- **The contract with the server is written down.** Response shapes (support inbox, probes, approvals, datatables, …)
  are now types that the Opus reviews checked field by field against the server routes; fields the server can leave
  empty are `| null` or optional, so the UI must handle them.
- **Refactors become safe.** Renaming a field, splitting a 600-line component or changing a hook's return shape now
  shows every place that breaks. The long-function splits in this branch relied on that.
- **Errors are read honestly.** A caught error is `unknown` in TypeScript; `agent-hub/src/utils/caughtError.ts` reads
  `message`/`status`/`code` without throwing on odd values, instead of `e.message` on whatever was thrown.
- **Web and phone share one implementation where they should.** Typing exposed web↔mobile copies that had drifted into
  hand-maintained twins; several are now generated mirrors (`scripts/shared-mirror.manifest.json`), so a fix lands on
  both platforms at once.
- **Faster onboarding and better tooling.** Editors autocomplete props and API fields, and new contributors read the
  shape of the data from the types instead of from the call sites.

**Why it is safe**
- Every type-only conversion is checked by `scripts/ts-equivalence.mjs`: the old `.jsx` and the new `.tsx` are compiled
  to JavaScript and must be identical. For those files the shipped code did not change, only its description.
- Code changes that typing needed are separate commits: caught-error token substitutions (reviewed as such), a small
  number of runtime-equivalent rewrites (each with an equivalence argument and a test that passes before and after),
  and bug fixes with their own tests.
- No `any`, `as any`, `as unknown as`, `@ts-ignore` or non-null `!` were added; a file that could not be typed honestly
  stayed JavaScript, byte-identical.

**Why the server stays JavaScript**
The server is CommonJS (~3,400 files). It already gets most of the benefit through `// @typecheck` + JSDoc
(`cd server && npm run typecheck`), without a rewrite that would touch every `require`/`module.exports`. Its structural
work in this branch (5xx handling, import cycles, long functions) is in JavaScript.

**Where we end up**
agent-hub non-test source: 63% TypeScript at the start of this round, ~83% now; the rest is either a file with a
react-hooks eslint exception (stays JS by rule) or listed as follow-up because it needs a small runtime change first.
