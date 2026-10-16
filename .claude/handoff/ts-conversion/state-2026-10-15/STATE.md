# State of the TS conversion and structural work (final, 2026-10-16)

This folder is session working state. It is removed from the branch in the commit right after this one, before the PR
to main; read it at that commit's parent, or on `ts-int/review-final`.

## Done (convert branch `ccr-28820270-xkvwp8`)
- agent-hub non-test source 83.6% TypeScript (611 JS / 3,120 TS); 1,302 renames, 940 of 1,310 compile identical, the
  rest accounted for (inline-style sweep, caughtError helpers, documented runtime cases with tests).
- Server structure: HttpError + terminal handler for 5xx, largest import cycle 569 → 60, long functions 201 → 104
  (agent-hub 314 → 243). Server stays JavaScript (`// @typecheck` + JSDoc).
- Final scored review (reviews/final-*.md, three parts) and its blockers fixed: stale `as unknown as` shims (fix-b2),
  caught-error casts and non-null `!` (fix-b3), chart-cap bypass, path tokens in the error log, studio data 4xx
  pass-through, friendly public-form sentences.
- CI/release audit: no workflow path breaks; JS lint policy and five source guards now cover TS; prd agent-hub image
  build waits for tsc; ts-equivalence checks every rename (-l).
- Ratchets lowered (chore commit). Full suites green on the runner: vitest 22,005, mobile jest 13,428, server 29,101.

## Open
- PR to main from the convert branch (squash merge recommended). Do not merge or deploy without the owner.
- Follow-ups: "B2 part 3" (`ts-laptop/fix-b2p3`, remaining `as unknown as` over now-TS modules), exhaustive-deps budget
  for TS, mobile wrapper casts, files that stay JS (per-session runtime-rewrite lists in split/*-report.md), LF-A3,
  InputArea/SkillsPopover, NotificationCenter split test, definitionOps redesign, skillModel mirror.
- Bug fixes after the cut-off: their own PR from `ts-bugs/fixes` (and `ts-bugs/sec-webpage-sqlite`), #174 waits for the
  owner. One pre-existing security issue was reported to the owner privately.
