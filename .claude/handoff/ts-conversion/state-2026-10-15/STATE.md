# State of the TS conversion and structural work (paused 2026-10-15)

Read this first, then `../README.md`, which is the contract for the JS→TS conversion.

## Where things stand
- The convert branch `ccr-28820270-xkvwp8` is on GitHub, fully green, and **all completed work is on it**:
  - **Gates and typechecks:**
    - server tests: 28933 pass, 0 fail
    - agent-hub vitest: 21601 pass
    - mobile jest: 13430 pass
    - typechecks: 0 errors in server, agent-hub and mobile
    - `check:fast`: 39/39 pass
    - duplication: 15379 against a budget of 15419
    - gitleaks: clean
  - **Server structural wave:**
    - hand-written 5xx: 118 → 14
    - largest import cycle: 552 → 60
    - long functions: 132 → 109
    - three fail-open gate bugs fixed and tested
  - **CI fixes:**
    - server typecheck
    - gitleaks allowlist path
    - web↔mobile mirror dedupe (`scripts/shared-mirror.manifest.json`, `generatedRoots`)
- **agent-hub TS share** (non-test source):
  - convert branch: 63% (js 1288 / ts 2211)
  - all work branches below included: ~73%
- **Out of scope:** the server stays JavaScript by design (CommonJS, `// @typecheck` + JSDoc).

## Work branches on GitHub (not yet in the convert branch)
| Branch | Content | Status | Next step |
|---|---|---|---|
| `ts-local/wave1` | batches 01–06 merged with all review fixes (reviews/wave1-*.md), on base 7dcc326b7 | stopped just before the final checks | run the full checks (below), then `ts-ratchet --update`, then merge into convert |
| `ts-local/prep2` (fe97b2c68) | 44072b7db + blockers-1 (AppIcon, AnchoredMenu, FieldHint, kit, resolveBinding; Opus APPROVED) + `agent-hub/src/utils/caughtError.ts` helpers (Opus-reviewed, fixed) + ci.yml filter | done | merge into convert first; it is the base for batches 13+ |
| `ts-local/batch-07`, `-11`, `-12` | drafted, gate 0 different, each on 44072b7db | Opus review not done | review all three together, including a merge-tree check; apply fixes; integrate |
| `ts-local/batch-08`, `-09`, `-10` | drafted | reviewed: reviews/wave2-b08-b09-b10.md (small fixes, one merge break, one lockstep conflict; resolutions given) | apply the fixes, then integrate |
| `ts-local/batch-13` (6/37), `-16` (4/45) | drafted on prep2 | not reviewed; low yield, blocked by shared modules | redo after blockers-2 lands (16 depends on batch 17's primitives.jsx and shared.jsx) |
| `ts-local/batch-14`, `-15`, `-17`, `-18` | stopped mid-work; the last commit is a `wip(ts): …` commit, UNVERIFIED | unverified | finish them: typecheck, gate, revert anything that is not identical, then review |
| `ts-local/blockers-2A`, `-2C` | stopped early (a few files); `blockers-2B` was not pushed (empty) | unverified | redo; see "Priority" |

Review notes the drafters raised per branch are in `review-notes.md`.

## Priority (what gives the most % fastest)
The batches follow directories, not dependencies, so yield is about 35%: shared JS modules block their importers.
1. Convert the most-imported shared JS modules first. The ranking is `js-fanin.txt`; `utils/helpers.js` alone has 181 JS importers. Split the work: `b2-A.txt` (shared/utils), `b2-B.txt` (Studio), `b2-C.txt` (Builder/analytics). Base them on `ts-local/prep2`. Type precisely and make every prop or param optional where the code tolerates its absence.
2. Integrate:
   1. prep2
   2. wave1
   3. 07–12
   4. blockers-2
3. Rerun the low-yield batches (13–18), then do 19, 20 and 22 on the new base. Use the caughtError recipe (`catch-recipe.md`) as a separate second commit.
4. Then the rest of `../README.md` phase 2 (runtime cases with tests), the agent-hub long functions (`structural-plan.md` §3, LF-A*), and LF-S7.
5. Phase 4:
   1. re-run the scored review
   2. `ci-local` / GitHub CI green
   3. open a PR from the convert branch to main; do not merge it
   4. dev deploy only with the owner's explicit OK

## Rules that bit us (do not skip)
- `check:fast` does NOT cover these; run them yourself before every push:
  - `cd server && npm run typecheck`
  - `node scripts/duplication-ratchet.mjs`
  - `npm run lint:gitleaks`
- Before merging branches, test them TOGETHER: `git merge-tree` or a scratch merge, then typecheck. Branches that are green on their own broke each other (shared type shapes; one home per shape, see reviews/wave1-*.md).
- Server tests and mobile tests read agent-hub and server source by path. After renames or splits, run the full server suite and the mobile jest suite.
- Never mark a field required when the code reads it defensively.
- Never write `(e as Error)`; use `caughtError.ts`.
- Casts from `unknown` need a runtime guard at the site.
- When a gate refactor composes middleware manually, the continuation must propagate `err` (fail closed).
- When a typed web module becomes identical to its mobile lockstep port, turn the port into a mirror entry, never a hand copy.
- **Model split:**
  - Sonnet drafts.
  - Opus reviews: one review per 3 batches or per package, and always for security-relevant code.
  - A script does whatever a script can prove.
- **Tools:**
  - `tools/heavy.sh <cmd>` caps parallel heavy jobs from cores and memory (`HEAVY_SLOTS` overrides).
  - `PAIR_BASE=<base> node tools/pair-check.mjs agent-hub/src/<stem>` compares delete+add pairs the gate misses.
- Never push to main. Push the convert branch only when everything is green. Commit trailers are in `../README.md`.
