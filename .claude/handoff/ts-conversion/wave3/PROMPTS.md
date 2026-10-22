# Agent prompts used in wave 3

Replace N with the chunk number; files come from `chunk.mjs N /tmp/wave3 /tmp/tsc.txt`.
Fix agents: model sonnet, effort low. Reviewers: model sonnet.

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
2. Only when types cannot do it, a MINIMAL code change of one of these kinds, nothing else: a
   null/undefined guard (`?.` or an early `if (!x) return;` that leaves the non-null path exactly as it
   was); an explicit conversion JavaScript already did implicitly (`String(n)`, `Number(s)`); Date
   arithmetic via `.getTime()`; a clearly wrong prop or name that TypeScript proves wrong. Never:
   refactors, rewritten loops, new helper variables, renames, reformatting, moved or removed code,
   changed conditions or logic, changed or dropped call arguments, reading other variables, new
   fallback values, changed defaults, extra or removed props or keys, skipping items with a missing
   field. If the only way is one of those, leave the error.
3. Forbidden always: any, as any, as unknown as, any assertion containing never, Function,
   @ts-ignore, @ts-expect-error, @ts-nocheck, the non-null `!`, eslint-disable, assertions that only
   silence a real mismatch, editing files not in your list, git commands that change anything.

CHECKS
- Typecheck: .claude/handoff/ts-conversion/wave3/tsc-locked.sh /tmp/wave3/c3-N.files
- Compiled-JavaScript diff: node .claude/handoff/ts-conversion/wave3/eqcheck.mjs /tmp/wave3/c3-N.json
  "DIFFERENT" is allowed, but every difference must be a code change under point 2. Undo anything else.

Final answer (short, no diffs): files clean / total; every code change (file: what and why); files
not fixed (one line each); real bugs noticed.

## Review

You are the reviewer. Same rules as above. For every file whose compiled JavaScript changed
(eqcheck.mjs on /tmp/wave3/c3-N.json), compare old (`git show 4c5dba38:agent-hub/<file>`) and new and
judge every code change: OK (allowed kind, behaviour-preserving for every input the old code handled
without crashing); FIX (outside the rules or changes behaviour: restore the original code, keep the
types, prefer a narrowing assertion over a code change; if neither is possible leave the original
code, the gate then sends the file back); BUG-FIX (fixes a real bug, small and certain: keep, state it).
Flag and correct types that lie. Same forbidden list; only files in the list; after edits run
tsc-locked.sh and eqcheck.mjs. Final answer: per changed file OK / FIXED / BUG-FIX, then totals.
