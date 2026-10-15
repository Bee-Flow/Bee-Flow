# Splitting the remaining work over parallel cloud sessions (2026-10-15)
The integrator session (on `ccr-28820270-xkvwp8`) keeps: pushing prep2 + wave1, batches 07–12, b2-A, b2-B (Studio,
after 07–12), LF-A3/LF-A7/LF-A8 rest, merging every split branch, lowering the ratchets, the scored review and the PR.
Sessions B–F below own disjoint files and push only their own branch. Paste one prompt per new cloud session
(same repo). When a session reports done, tell the integrator its branch name.

| ID | Area | BASE | Main risk at merge |
|---|---|---|---|
| B | Automation Builder | convert + prep2 | TS importers of formPrimitives/nodeDefs in other areas |
| C | Admin: compliance, modules | convert + prep2 | auditForms (b2-A) importers |
| D | Admin: product website, org | convert + prep2 | largest scope (149 files) |
| E | Admin subscriptions/security, agents | convert + prep2 | entitlement code, canUseFacts (b2-A) |
| F | Structural: server LF-S7 + page/editor long functions | `origin/ccr-28820270-xkvwp8` | auth middleware, LoginPage |

Merge order for the integrator: F any time (server + untouched pages); B before D/E (shared Builder types); C, D, E in any order; each merge followed by a merged typecheck + gate, then the full checks.

---

## Prompt for session B: Automation Builder

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow), as split session B (Automation Builder). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

BASE = origin/ccr-28820270-xkvwp8 with origin/ts-local/prep2 merged in (see START 1)

YOUR SCOPE
1. b2-C, Builder part (shared modules first, they unblock batch 22): components/automation/Builder/flow/settings/formPrimitives.jsx,
   flow/displayHelpers.js, flow/AccordionSection.jsx, flow/nodeDefs.js, flow/settings/collectionEditors.jsx,
   mapping/TemplateField.jsx, flow/settings/formDensity.js. An unverified start for displayHelpers exists on
   origin/ts-local/blockers-2C. Type precisely; every prop/param optional where the code tolerates its absence
   (state-2026-10-15/sweep-hints.md lists what these keep back). Opus review.
2. Batch 22 (`.claude/handoff/ts-conversion/batches/22.txt`, components/automation/Builder), then a sweep of the
   Builder files kept JS in batches 21–26 that the b2-C modules blocked (sweep-hints.md). Opus review.
3. Long functions LF-A4 (flow/settings/approvalEditors, flow/settings/routeEditors, flow/nodes/StepNodeBase) and
   LF-A5 (DiagramPane, BuilderShell, mapping/ValueBuilder, automation/index.jsx), structural-plan.md §3: characterise
   first, keep JS files JS. Opus review.
Scope: agent-hub/src/components/automation/** only (and their tests).

## Common rules (same in every split session)

START
1. `git fetch origin`, then `git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8`. If that does not
   yet contain prep2 (`git merge-base --is-ancestor origin/ts-local/prep2 HEAD` fails), merge it:
   `git merge --no-ff origin/ts-local/prep2` (a clean merge). The resulting commit is your BASE (`git rev-parse HEAD`;
   write it into your report). It holds the handoff docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts.
2. Read, in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (the JS→TS contract);
   .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding);
   drafter-brief.md and catch-recipe.md (conversion work) or refactor-brief.md and structural-plan.md §0 + §3
   (long-function work), all in that folder. Where those docs name a base commit (44072b7db, fe97b2c68), use YOUR BASE.
3. Environment (measured problems on these cloud machines):
   - Node must be the version in `.nvmrc` (22.23.2). If `node -v` differs, download
     https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify it against SHASUMS256.txt from the same
     directory, and replace the node binary on PATH (copy to `node.new`, then `mv` over it). Node 22.22.0 decodes
     windows-1252 0x80 wrongly and fails server csv.test.js.
   - Install: `npm ci` in root, agent-hub, mobile; in server `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (its postinstall
     download from nuget is cut off by the proxy).
   - gitleaks 8.30.1 (the version and sha256 pinned in .github/workflows/secret-scan.yml) into /usr/local/bin, so
     `npm run lint:gitleaks` runs the real scanner.
   - Measure `nproc` and memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with
     `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`. Use one drafting subagent per heavy slot (max 6).
   - Faster intermediate typechecks (drafting rounds only; the final check before a push is always the full
     `npm run typecheck`): from agent-hub,
     `heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo`.
     Collect several fixes before each run.

OWNERSHIP (this is what makes parallel sessions safe)
- Touch ONLY the files in your scope (plus their importers' extension-named import lines, colocated tests, and
  source-reading test paths in mobile/server). If you need a file outside your scope, keep your file as it is and list
  it under "blocked by" in your report.
- Never convert these files, another session owns them (b2-A, in the integrator session):
  utils/helpers.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,
  SideDrawer,UsedByTab,deadlineMath}, utils/agentAvatar.js, admin/compliance/pages/audits/auditForms.js,
  agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js. A file that stays JS only because one
  of these is untyped is listed as "blocked by b2-A" (it is converted in the later sweep).
- Never run `--update` on any ratchet and never commit a budget JSON (`.*-ratchet.json`, `.layering-ratchet.json`),
  except `.file-budget.json` key renames for files you renamed. The integrator lowers the budgets once, at merge.
- Do not write to STATE.md or review-notes.md (shared files: two sessions writing them conflict). Your notes go in
  your own report file (below).

HOW
- Git worktrees, one per batch/package, branched from your BASE. Drafting and mechanical work → subagents with
  model "sonnet" using drafter-brief.md / refactor-brief.md. Every ~3 batches or every package → an independent
  "opus" review subagent (read-only), which also merge-tests your branches together (git merge-tree / scratch merge +
  typecheck) and checks API shapes against the server routes. Security-relevant code (auth, entitlement gates,
  erasure, SQL scoping) always gets an Opus review. You merge, fix, and keep notes.
- Existing unverified work branches named in your scope may be reused, but treat them as drafts: typecheck, gate,
  revert anything not identical, review.
- Gate: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff` reports 0 different for type-only commits (plus the
  delete+add pair check in drafter-brief.md). caughtError rewrites go in a separate second commit, reviewed as token
  substitutions. Refactors (long functions) are behaviour-preserving with characterisation tests first.
- Integrate your own batches into your designated branch (merge commits, never rebase pushed history).
- Before EVERY push of your designated branch: `npm run check:fast`, `cd server && npm run typecheck`,
  `node scripts/duplication-ratchet.mjs`, `npm run lint:gitleaks`, agent-hub typecheck + full vitest, full mobile
  jest + `npx tsc --noEmit` in mobile, full server `npm test`. Full suites one at a time. Push only when all green.
- Push ONLY your designated branch (`git push -u origin <branch>`). Never push main or ccr-28820270-xkvwp8, never
  open or merge a PR, never deploy.
- Commit trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator)
Write `.claude/handoff/ts-conversion/state-2026-10-15/split/<ID>-report.md` on your branch and keep it current with
every push: branch name and final commit; per batch/package converted count and files kept JS with the reason
("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files written
(`reviews/<ID>-*.md`); full-suite numbers; ratchet numbers measured (no --update); anything the integrator must do at
merge (conflict risks, mirror candidates, behaviour notes).
```

---

## Prompt for session C: Admin: compliance, modules

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow), as split session C (Admin: compliance, modules). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

BASE = origin/ccr-28820270-xkvwp8 with origin/ts-local/prep2 merged in (see START 1)

YOUR SCOPE
1. Batch 13 (`batches/13.txt`, components/admin/compliance; a 6/37 draft exists on origin/ts-local/batch-13, low yield
   — redo it). auditForms.js stays JS (b2-A owns it); list its importers as "blocked by b2-A".
2. Batch 14 (`batches/14.txt`, admin/compliance, admin/modules, admin/monitoring; an UNVERIFIED wip commit exists on
   origin/ts-local/batch-14: finish it, typecheck, gate, revert anything not identical).
3. Caught-error second commits per batch (catch-recipe.md). Opus review of 13+14 together (compliance holds
   erasure/retention and audit code: review those as security-relevant).
Scope: the paths in batches 13 and 14 only.

## Common rules (same in every split session)

START
1. `git fetch origin`, then `git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8`. If that does not
   yet contain prep2 (`git merge-base --is-ancestor origin/ts-local/prep2 HEAD` fails), merge it:
   `git merge --no-ff origin/ts-local/prep2` (a clean merge). The resulting commit is your BASE (`git rev-parse HEAD`;
   write it into your report). It holds the handoff docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts.
2. Read, in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (the JS→TS contract);
   .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding);
   drafter-brief.md and catch-recipe.md (conversion work) or refactor-brief.md and structural-plan.md §0 + §3
   (long-function work), all in that folder. Where those docs name a base commit (44072b7db, fe97b2c68), use YOUR BASE.
3. Environment (measured problems on these cloud machines):
   - Node must be the version in `.nvmrc` (22.23.2). If `node -v` differs, download
     https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify it against SHASUMS256.txt from the same
     directory, and replace the node binary on PATH (copy to `node.new`, then `mv` over it). Node 22.22.0 decodes
     windows-1252 0x80 wrongly and fails server csv.test.js.
   - Install: `npm ci` in root, agent-hub, mobile; in server `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (its postinstall
     download from nuget is cut off by the proxy).
   - gitleaks 8.30.1 (the version and sha256 pinned in .github/workflows/secret-scan.yml) into /usr/local/bin, so
     `npm run lint:gitleaks` runs the real scanner.
   - Measure `nproc` and memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with
     `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`. Use one drafting subagent per heavy slot (max 6).
   - Faster intermediate typechecks (drafting rounds only; the final check before a push is always the full
     `npm run typecheck`): from agent-hub,
     `heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo`.
     Collect several fixes before each run.

OWNERSHIP (this is what makes parallel sessions safe)
- Touch ONLY the files in your scope (plus their importers' extension-named import lines, colocated tests, and
  source-reading test paths in mobile/server). If you need a file outside your scope, keep your file as it is and list
  it under "blocked by" in your report.
- Never convert these files, another session owns them (b2-A, in the integrator session):
  utils/helpers.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,
  SideDrawer,UsedByTab,deadlineMath}, utils/agentAvatar.js, admin/compliance/pages/audits/auditForms.js,
  agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js. A file that stays JS only because one
  of these is untyped is listed as "blocked by b2-A" (it is converted in the later sweep).
- Never run `--update` on any ratchet and never commit a budget JSON (`.*-ratchet.json`, `.layering-ratchet.json`),
  except `.file-budget.json` key renames for files you renamed. The integrator lowers the budgets once, at merge.
- Do not write to STATE.md or review-notes.md (shared files: two sessions writing them conflict). Your notes go in
  your own report file (below).

HOW
- Git worktrees, one per batch/package, branched from your BASE. Drafting and mechanical work → subagents with
  model "sonnet" using drafter-brief.md / refactor-brief.md. Every ~3 batches or every package → an independent
  "opus" review subagent (read-only), which also merge-tests your branches together (git merge-tree / scratch merge +
  typecheck) and checks API shapes against the server routes. Security-relevant code (auth, entitlement gates,
  erasure, SQL scoping) always gets an Opus review. You merge, fix, and keep notes.
- Existing unverified work branches named in your scope may be reused, but treat them as drafts: typecheck, gate,
  revert anything not identical, review.
- Gate: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff` reports 0 different for type-only commits (plus the
  delete+add pair check in drafter-brief.md). caughtError rewrites go in a separate second commit, reviewed as token
  substitutions. Refactors (long functions) are behaviour-preserving with characterisation tests first.
- Integrate your own batches into your designated branch (merge commits, never rebase pushed history).
- Before EVERY push of your designated branch: `npm run check:fast`, `cd server && npm run typecheck`,
  `node scripts/duplication-ratchet.mjs`, `npm run lint:gitleaks`, agent-hub typecheck + full vitest, full mobile
  jest + `npx tsc --noEmit` in mobile, full server `npm test`. Full suites one at a time. Push only when all green.
- Push ONLY your designated branch (`git push -u origin <branch>`). Never push main or ccr-28820270-xkvwp8, never
  open or merge a PR, never deploy.
- Commit trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator)
Write `.claude/handoff/ts-conversion/state-2026-10-15/split/<ID>-report.md` on your branch and keep it current with
every push: branch name and final commit; per batch/package converted count and files kept JS with the reason
("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files written
(`reviews/<ID>-*.md`); full-suite numbers; ratchet numbers measured (no --update); anything the integrator must do at
merge (conflict risks, mirror candidates, behaviour notes).
```

---

## Prompt for session D: Admin: product website, org

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow), as split session D (Admin: product website, org). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

BASE = origin/ccr-28820270-xkvwp8 with origin/ts-local/prep2 merged in (see START 1)

YOUR SCOPE
1. Batch 17 first (`batches/17.txt`, admin/product-website + admin/security; UNVERIFIED wip on origin/ts-local/batch-17):
   it holds product-website/primitives.jsx and blockEditors/shared.jsx that batch 16 needs.
2. product-website/analytics/ui.jsx and analytics/useAnalyticsQuery.js (moved here from b2-C), then batch 16
   (`batches/16.txt`; a 4/45 draft exists on origin/ts-local/batch-16 — redo it on top of 17).
3. Batch 15 (`batches/15.txt`, product-website + admin/org + monitoring; UNVERIFIED wip on origin/ts-local/batch-15).
4. Caught-error second commits. Opus review after 17+16, and after 15.
Scope: the paths in batches 15, 16, 17 only (admin/monitoring files in 15 are yours; those in 14 belong to session C).

## Common rules (same in every split session)

START
1. `git fetch origin`, then `git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8`. If that does not
   yet contain prep2 (`git merge-base --is-ancestor origin/ts-local/prep2 HEAD` fails), merge it:
   `git merge --no-ff origin/ts-local/prep2` (a clean merge). The resulting commit is your BASE (`git rev-parse HEAD`;
   write it into your report). It holds the handoff docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts.
2. Read, in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (the JS→TS contract);
   .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding);
   drafter-brief.md and catch-recipe.md (conversion work) or refactor-brief.md and structural-plan.md §0 + §3
   (long-function work), all in that folder. Where those docs name a base commit (44072b7db, fe97b2c68), use YOUR BASE.
3. Environment (measured problems on these cloud machines):
   - Node must be the version in `.nvmrc` (22.23.2). If `node -v` differs, download
     https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify it against SHASUMS256.txt from the same
     directory, and replace the node binary on PATH (copy to `node.new`, then `mv` over it). Node 22.22.0 decodes
     windows-1252 0x80 wrongly and fails server csv.test.js.
   - Install: `npm ci` in root, agent-hub, mobile; in server `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (its postinstall
     download from nuget is cut off by the proxy).
   - gitleaks 8.30.1 (the version and sha256 pinned in .github/workflows/secret-scan.yml) into /usr/local/bin, so
     `npm run lint:gitleaks` runs the real scanner.
   - Measure `nproc` and memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with
     `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`. Use one drafting subagent per heavy slot (max 6).
   - Faster intermediate typechecks (drafting rounds only; the final check before a push is always the full
     `npm run typecheck`): from agent-hub,
     `heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo`.
     Collect several fixes before each run.

OWNERSHIP (this is what makes parallel sessions safe)
- Touch ONLY the files in your scope (plus their importers' extension-named import lines, colocated tests, and
  source-reading test paths in mobile/server). If you need a file outside your scope, keep your file as it is and list
  it under "blocked by" in your report.
- Never convert these files, another session owns them (b2-A, in the integrator session):
  utils/helpers.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,
  SideDrawer,UsedByTab,deadlineMath}, utils/agentAvatar.js, admin/compliance/pages/audits/auditForms.js,
  agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js. A file that stays JS only because one
  of these is untyped is listed as "blocked by b2-A" (it is converted in the later sweep).
- Never run `--update` on any ratchet and never commit a budget JSON (`.*-ratchet.json`, `.layering-ratchet.json`),
  except `.file-budget.json` key renames for files you renamed. The integrator lowers the budgets once, at merge.
- Do not write to STATE.md or review-notes.md (shared files: two sessions writing them conflict). Your notes go in
  your own report file (below).

HOW
- Git worktrees, one per batch/package, branched from your BASE. Drafting and mechanical work → subagents with
  model "sonnet" using drafter-brief.md / refactor-brief.md. Every ~3 batches or every package → an independent
  "opus" review subagent (read-only), which also merge-tests your branches together (git merge-tree / scratch merge +
  typecheck) and checks API shapes against the server routes. Security-relevant code (auth, entitlement gates,
  erasure, SQL scoping) always gets an Opus review. You merge, fix, and keep notes.
- Existing unverified work branches named in your scope may be reused, but treat them as drafts: typecheck, gate,
  revert anything not identical, review.
- Gate: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff` reports 0 different for type-only commits (plus the
  delete+add pair check in drafter-brief.md). caughtError rewrites go in a separate second commit, reviewed as token
  substitutions. Refactors (long functions) are behaviour-preserving with characterisation tests first.
- Integrate your own batches into your designated branch (merge commits, never rebase pushed history).
- Before EVERY push of your designated branch: `npm run check:fast`, `cd server && npm run typecheck`,
  `node scripts/duplication-ratchet.mjs`, `npm run lint:gitleaks`, agent-hub typecheck + full vitest, full mobile
  jest + `npx tsc --noEmit` in mobile, full server `npm test`. Full suites one at a time. Push only when all green.
- Push ONLY your designated branch (`git push -u origin <branch>`). Never push main or ccr-28820270-xkvwp8, never
  open or merge a PR, never deploy.
- Commit trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator)
Write `.claude/handoff/ts-conversion/state-2026-10-15/split/<ID>-report.md` on your branch and keep it current with
every push: branch name and final commit; per batch/package converted count and files kept JS with the reason
("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files written
(`reviews/<ID>-*.md`); full-suite numbers; ratchet numbers measured (no --update); anything the integrator must do at
merge (conflict risks, mirror candidates, behaviour notes).
```

---

## Prompt for session E: Admin subscriptions/security, agents

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow), as split session E (Admin subscriptions/security, agents). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

BASE = origin/ccr-28820270-xkvwp8 with origin/ts-local/prep2 merged in (see START 1)

YOUR SCOPE
1. Batch 18 (`batches/18.txt`, admin/subscriptions + admin/security + admin/shared; UNVERIFIED wip on
   origin/ts-local/batch-18). Subscriptions = licence/entitlement code: Opus review as security-relevant.
2. Batch 19 (`batches/19.txt`, agents/AgentWizard, AgentDesigner, AgentStudio) and batch 20 (`batches/20.txt`).
   canUseFacts.js stays JS (b2-A owns it).
3. Caught-error second commits. Opus review after 19+20.
4. Then long functions in your area (structural-plan.md §3): AgentWizard/BuilderSplit.jsx, AgentStudio/index.jsx,
   builderSplit/useKnowledgeBases (the LF-A8/LF-A9 rows for those files only), characterised first.
Scope: the paths in batches 18, 19, 20 only.

## Common rules (same in every split session)

START
1. `git fetch origin`, then `git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8`. If that does not
   yet contain prep2 (`git merge-base --is-ancestor origin/ts-local/prep2 HEAD` fails), merge it:
   `git merge --no-ff origin/ts-local/prep2` (a clean merge). The resulting commit is your BASE (`git rev-parse HEAD`;
   write it into your report). It holds the handoff docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts.
2. Read, in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (the JS→TS contract);
   .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding);
   drafter-brief.md and catch-recipe.md (conversion work) or refactor-brief.md and structural-plan.md §0 + §3
   (long-function work), all in that folder. Where those docs name a base commit (44072b7db, fe97b2c68), use YOUR BASE.
3. Environment (measured problems on these cloud machines):
   - Node must be the version in `.nvmrc` (22.23.2). If `node -v` differs, download
     https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify it against SHASUMS256.txt from the same
     directory, and replace the node binary on PATH (copy to `node.new`, then `mv` over it). Node 22.22.0 decodes
     windows-1252 0x80 wrongly and fails server csv.test.js.
   - Install: `npm ci` in root, agent-hub, mobile; in server `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (its postinstall
     download from nuget is cut off by the proxy).
   - gitleaks 8.30.1 (the version and sha256 pinned in .github/workflows/secret-scan.yml) into /usr/local/bin, so
     `npm run lint:gitleaks` runs the real scanner.
   - Measure `nproc` and memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with
     `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`. Use one drafting subagent per heavy slot (max 6).
   - Faster intermediate typechecks (drafting rounds only; the final check before a push is always the full
     `npm run typecheck`): from agent-hub,
     `heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo`.
     Collect several fixes before each run.

OWNERSHIP (this is what makes parallel sessions safe)
- Touch ONLY the files in your scope (plus their importers' extension-named import lines, colocated tests, and
  source-reading test paths in mobile/server). If you need a file outside your scope, keep your file as it is and list
  it under "blocked by" in your report.
- Never convert these files, another session owns them (b2-A, in the integrator session):
  utils/helpers.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,
  SideDrawer,UsedByTab,deadlineMath}, utils/agentAvatar.js, admin/compliance/pages/audits/auditForms.js,
  agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js. A file that stays JS only because one
  of these is untyped is listed as "blocked by b2-A" (it is converted in the later sweep).
- Never run `--update` on any ratchet and never commit a budget JSON (`.*-ratchet.json`, `.layering-ratchet.json`),
  except `.file-budget.json` key renames for files you renamed. The integrator lowers the budgets once, at merge.
- Do not write to STATE.md or review-notes.md (shared files: two sessions writing them conflict). Your notes go in
  your own report file (below).

HOW
- Git worktrees, one per batch/package, branched from your BASE. Drafting and mechanical work → subagents with
  model "sonnet" using drafter-brief.md / refactor-brief.md. Every ~3 batches or every package → an independent
  "opus" review subagent (read-only), which also merge-tests your branches together (git merge-tree / scratch merge +
  typecheck) and checks API shapes against the server routes. Security-relevant code (auth, entitlement gates,
  erasure, SQL scoping) always gets an Opus review. You merge, fix, and keep notes.
- Existing unverified work branches named in your scope may be reused, but treat them as drafts: typecheck, gate,
  revert anything not identical, review.
- Gate: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff` reports 0 different for type-only commits (plus the
  delete+add pair check in drafter-brief.md). caughtError rewrites go in a separate second commit, reviewed as token
  substitutions. Refactors (long functions) are behaviour-preserving with characterisation tests first.
- Integrate your own batches into your designated branch (merge commits, never rebase pushed history).
- Before EVERY push of your designated branch: `npm run check:fast`, `cd server && npm run typecheck`,
  `node scripts/duplication-ratchet.mjs`, `npm run lint:gitleaks`, agent-hub typecheck + full vitest, full mobile
  jest + `npx tsc --noEmit` in mobile, full server `npm test`. Full suites one at a time. Push only when all green.
- Push ONLY your designated branch (`git push -u origin <branch>`). Never push main or ccr-28820270-xkvwp8, never
  open or merge a PR, never deploy.
- Commit trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator)
Write `.claude/handoff/ts-conversion/state-2026-10-15/split/<ID>-report.md` on your branch and keep it current with
every push: branch name and final commit; per batch/package converted count and files kept JS with the reason
("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files written
(`reviews/<ID>-*.md`); full-suite numbers; ratchet numbers measured (no --update); anything the integrator must do at
merge (conflict risks, mirror candidates, behaviour notes).
```

---

## Prompt for session F: Structural: server LF-S7 + page/editor long functions

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow), as split session F (Structural: server LF-S7 + page/editor long functions). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

BASE = origin/ccr-28820270-xkvwp8 (see START 1; the prep2 merge is harmless here too)

YOUR SCOPE
1. LF-S7 (server, structural-plan.md §3): routes/transcriptions/upload.js `POST /`, routes/transcriptions/reprocess.js,
   automation/formQueue.js `createFormQueue`, routes/automation/catalog.js `GET /catalog`, and ⚠ auth/connectorJwt.js
   `connectorJwtMiddleware` (alone, characterised first, Opus security review: fail closed, err propagated through any
   manually composed middleware). Target: `node scripts/count-ratchet.mjs long-function server` goes down by 5.
2. agent-hub long functions in files no conversion batch owns: LF-A1 ⚠ pages/LoginPage.jsx (OPAQUE/MFA, alone, Opus
   security review), LF-A2 (pages/TemplatesPage.jsx, pages/AdvancedSettings.jsx, pages/EmbedChat.jsx), LF-A6
   (renderers/PageRenderer.jsx 2 counts, ⚠ editor/react/BeeEditor.jsx Yjs), LF-A9 minus useKnowledgeBases
   (hooks/useAppBuilderStream.ts, chat/Voice/useVoiceSession.ts). JS files stay JS (no conversion in this session).
Scope: exactly those files, their colocated tests, and new extracted sibling files.

## Common rules (same in every split session)

START
1. `git fetch origin`, then `git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8`. If that does not
   yet contain prep2 (`git merge-base --is-ancestor origin/ts-local/prep2 HEAD` fails), merge it:
   `git merge --no-ff origin/ts-local/prep2` (a clean merge). The resulting commit is your BASE (`git rev-parse HEAD`;
   write it into your report). It holds the handoff docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts.
2. Read, in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (the JS→TS contract);
   .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding);
   drafter-brief.md and catch-recipe.md (conversion work) or refactor-brief.md and structural-plan.md §0 + §3
   (long-function work), all in that folder. Where those docs name a base commit (44072b7db, fe97b2c68), use YOUR BASE.
3. Environment (measured problems on these cloud machines):
   - Node must be the version in `.nvmrc` (22.23.2). If `node -v` differs, download
     https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify it against SHASUMS256.txt from the same
     directory, and replace the node binary on PATH (copy to `node.new`, then `mv` over it). Node 22.22.0 decodes
     windows-1252 0x80 wrongly and fails server csv.test.js.
   - Install: `npm ci` in root, agent-hub, mobile; in server `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (its postinstall
     download from nuget is cut off by the proxy).
   - gitleaks 8.30.1 (the version and sha256 pinned in .github/workflows/secret-scan.yml) into /usr/local/bin, so
     `npm run lint:gitleaks` runs the real scanner.
   - Measure `nproc` and memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with
     `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`. Use one drafting subagent per heavy slot (max 6).
   - Faster intermediate typechecks (drafting rounds only; the final check before a push is always the full
     `npm run typecheck`): from agent-hub,
     `heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo`.
     Collect several fixes before each run.

OWNERSHIP (this is what makes parallel sessions safe)
- Touch ONLY the files in your scope (plus their importers' extension-named import lines, colocated tests, and
  source-reading test paths in mobile/server). If you need a file outside your scope, keep your file as it is and list
  it under "blocked by" in your report.
- Never convert these files, another session owns them (b2-A, in the integrator session):
  utils/helpers.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,
  SideDrawer,UsedByTab,deadlineMath}, utils/agentAvatar.js, admin/compliance/pages/audits/auditForms.js,
  agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js. A file that stays JS only because one
  of these is untyped is listed as "blocked by b2-A" (it is converted in the later sweep).
- Never run `--update` on any ratchet and never commit a budget JSON (`.*-ratchet.json`, `.layering-ratchet.json`),
  except `.file-budget.json` key renames for files you renamed. The integrator lowers the budgets once, at merge.
- Do not write to STATE.md or review-notes.md (shared files: two sessions writing them conflict). Your notes go in
  your own report file (below).

HOW
- Git worktrees, one per batch/package, branched from your BASE. Drafting and mechanical work → subagents with
  model "sonnet" using drafter-brief.md / refactor-brief.md. Every ~3 batches or every package → an independent
  "opus" review subagent (read-only), which also merge-tests your branches together (git merge-tree / scratch merge +
  typecheck) and checks API shapes against the server routes. Security-relevant code (auth, entitlement gates,
  erasure, SQL scoping) always gets an Opus review. You merge, fix, and keep notes.
- Existing unverified work branches named in your scope may be reused, but treat them as drafts: typecheck, gate,
  revert anything not identical, review.
- Gate: `node scripts/ts-equivalence.mjs <BASE> HEAD --diff` reports 0 different for type-only commits (plus the
  delete+add pair check in drafter-brief.md). caughtError rewrites go in a separate second commit, reviewed as token
  substitutions. Refactors (long functions) are behaviour-preserving with characterisation tests first.
- Integrate your own batches into your designated branch (merge commits, never rebase pushed history).
- Before EVERY push of your designated branch: `npm run check:fast`, `cd server && npm run typecheck`,
  `node scripts/duplication-ratchet.mjs`, `npm run lint:gitleaks`, agent-hub typecheck + full vitest, full mobile
  jest + `npx tsc --noEmit` in mobile, full server `npm test`. Full suites one at a time. Push only when all green.
- Push ONLY your designated branch (`git push -u origin <branch>`). Never push main or ccr-28820270-xkvwp8, never
  open or merge a PR, never deploy.
- Commit trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator)
Write `.claude/handoff/ts-conversion/state-2026-10-15/split/<ID>-report.md` on your branch and keep it current with
every push: branch name and final commit; per batch/package converted count and files kept JS with the reason
("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files written
(`reviews/<ID>-*.md`); full-suite numbers; ratchet numbers measured (no --update); anything the integrator must do at
merge (conflict risks, mirror candidates, behaviour notes).
```
