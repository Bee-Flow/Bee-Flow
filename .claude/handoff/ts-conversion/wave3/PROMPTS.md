# Agent prompts used in wave 3 (and the rules learned from it)

Replace N with the chunk number; files come from `chunk.mjs N /tmp/wave3 /tmp/tsc.txt`.
Fix agents: model sonnet, effort low, as the MINIMUM (Haiku at effort low gave up on nearly every
cross-file error; do not use it for this). Reviewers: model sonnet.

## How to run a round (what wave 3 got wrong, see LESSONS.md)

- **Ownership by directory, not by error list.** One agent owns a directory tree and every file in
  it; the two sides of a prop/arg mismatch then sit with one agent. Shared types (`hooks/`, `api/`,
  `lib/`, `components/shared/`, `*.types.ts`) have ONE owner; everybody else imports them and asks
  that owner for a change (in the final answer, not by editing).
- **The integration round sees the whole error list**, not a chunk: errors between directories and in
  the ~200 importers are its job.
- **Carry the restored-spots list between rounds.** Every reviewer round ends with
  `node scripts/ts-behaviour-diff.mjs --base <BASE> --report /tmp/round-N.json` (ALL changed files,
  converted or not). The next round gets `--baseline /tmp/round-N.json`: a `NEW` line is a code
  change nobody reviewed, a guard that came back included. The fix prompt lists the file:lines a
  reviewer restored, with "do not touch".
- A fresh worktree needs `cd server && npm ci` before eqcheck / ts-behaviour-diff / the gate: they
  compile with the esbuild server/ locks (the error message says so).
- Before the agents start, run the tooling to the end (`scripts/ts-convert-codefix.mjs`): props a
  caller passes but the component does not destructure, `T | null` from a null-passing caller,
  optional props from a guard in the body, `T[]` for `const xs = []`, and `type` aliases for
  options objects are the tool's job now, not the agents'.

## Rules the agents broke (now in the prompts below)

1. **No `?.`, `??`, `||` or early return on a value the old code dereferenced without a guard.**
   That turns a crash into a silent wrong path (reviews restored ~40 of these). A type that says
   `T | null` where the code uses `T` is fixed by a narrowing assertion (`as T`) at the use, or by
   correcting the type at its source when a caller never passes null. A guard is only allowed
   where the old code already guarded (`if (x)`, `x && ...`, `x?.`) and the type just did not say so.
2. **Never remove a JSX prop, an argument, an object key or a call because the receiver does not
   declare it.** Widen the receiver: add the prop to its props type (optional if some caller omits
   it), the parameter to its signature, the key to its type. Removing it is a behaviour change
   (the receiver may read it through `...rest` or `props.x`).
3. **Reuse an exported type before inventing one.** Search (`git grep -n "interface <Name>\|type
   <Name> ="`) for the domain type (`ToolRow`, `OrgGroup`, `WebpageRow`): a second local `UsageRow`
   is a defect, even when it typechecks.
4. **Widen a literal type at its source** (`nodesep: number`, not `64`; `count: number | string`
   when a caller passes `'!'`), never by casting the caller.
5. Only files in your list; a change another file needs goes in the final answer as a request.

## Fix

You are finishing a JavaScript -> TypeScript conversion in the Bee Flow monorepo (frontend: agent-hub/,
React 19, strict TypeScript). A tool already renamed every file and added most types. Your job: make
YOUR files typecheck.

Your files and their current errors: /tmp/wave3/c3-N.json (`file` = old JS path, `target` = the
.ts/.tsx path in the working tree, `errors` = typecheck errors in that file, `importerErrors` = errors
in OTHER files caused by a type in this file: fix those by correcting the type here). Plain list:
/tmp/wave3/c3-N.files. Paths are relative to agent-hub. The old JavaScript is in commit 4c5dba38.

ORDER OF PREFERENCE
1. Types only (best): annotations, interface/type declarations in the same file, `import type` of
   existing types (layer direction: api/ and hooks/ never import from components/ or pages/;
   components/ never from pages/), type arguments, `declare field: T;` in classes, members on an
   interface declared in your file, assertions that NARROW to the real type. Prefer an existing
   exported domain type over an invented shape.
2. Only when types cannot do it, a MINIMAL code change of one of these kinds, nothing else: an
   explicit conversion JavaScript already did implicitly (`String(n)`, `Number(s)`); Date
   arithmetic via `.getTime()`; a clearly wrong prop or name that TypeScript proves wrong. A
   null/undefined guard (`?.`, `??`, `||`, an early `if (!x) return;`) ONLY where the old code already
   guarded that value and the type merely did not say so; on a value the old code dereferenced
   unguarded, use a narrowing assertion (`x as T`) or fix the type at its source instead (a guard
   there turns a crash into a silent wrong path). Never: refactors, rewritten loops, new helper
   variables, renames, reformatting, moved or removed code, changed conditions or logic, changed
   or dropped call arguments, reading other variables, new fallback values, changed defaults,
   extra or removed props or keys (widen the receiver's type instead), skipping items with a
   missing field. If the only way is one of those, leave the error.
   Spots a reviewer already restored (listed below under RESTORED, from the previous round's
   `ts-behaviour-diff` report) are not to be touched again.
3. Forbidden always: any, as any, as unknown as, any assertion containing never, Function,
   @ts-ignore, @ts-expect-error, @ts-nocheck, the non-null `!`, eslint-disable, assertions that only
   silence a real mismatch, editing files not in your list, git commands that change anything.

RESTORED (do not touch): <file:line list from the previous round's reviewers, or "none">

CHECKS
- Typecheck: .claude/handoff/ts-conversion/wave3/tsc-locked.sh /tmp/wave3/c3-N.files
- Compiled-JavaScript diff: node .claude/handoff/ts-conversion/wave3/eqcheck.mjs /tmp/wave3/c3-N.json
  "DIFFERENT" is allowed, but every difference must be a code change under point 2. Undo anything else.
  (Needs server/node_modules: `cd server && npm ci` once in a fresh worktree.)

Final answer (short, no diffs): files clean / total; every code change (file: what and why); files
not fixed (one line each); types another owner must change (file, type, what); real bugs noticed.

## Review

You are the reviewer. Same rules as above. For every file whose compiled JavaScript changed
(eqcheck.mjs on /tmp/wave3/c3-N.json), compare old (`git show 4c5dba38:agent-hub/<file>`) and new and
judge every code change: OK (allowed kind, behaviour-preserving for every input the old code handled
without crashing); FIX (outside the rules or changes behaviour: restore the original code, keep the
types, prefer a narrowing assertion over a code change; if neither is possible leave the original
code, the gate then sends the file back); BUG-FIX (fixes a real bug, small and certain: keep, state it).
A guard (`?.`, `??`, `||`, early return) on a value the old code dereferenced unguarded is FIX, not
OK, even when it typechecks. A removed JSX prop, argument or key is FIX: widen the receiver's type.
Flag and correct types that lie. Same forbidden list; only files in the list; after edits run
tsc-locked.sh and eqcheck.mjs. Final answer: per changed file OK / FIXED / BUG-FIX, then totals, then
RESTORED: every file:line you put back (the next round's fix prompt carries this list), and the
behaviour-diff report of the round: `node scripts/ts-behaviour-diff.mjs --base <BASE> --report
/tmp/round-N.json` (the next round runs it with `--baseline /tmp/round-N.json`).
