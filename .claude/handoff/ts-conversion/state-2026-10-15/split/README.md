# Splitting the remaining work over three parallel cloud sessions (2026-10-15)

The integrator session (ccr-28820270-xkvwp8) keeps: prep2 + wave1, batches 07-12, b2-A/b2-B (shared + Studio), LF-A3/LF-A7/the rest of LF-A8, merging S1-S3, lowering the ratchets, the scored review and the PR. S1-S3 own disjoint files and push only their own branch.

Merge order for the integrator: S3 any time; S1 before S2 (shared Builder types); each merge → merged typecheck + gate, then the full checks.

---

## S1: Automation Builder + Agents

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow) as split session S1 (Automation Builder + Agents). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

SCOPE
1. Shared Builder modules first (they unblock batch 22): components/automation/Builder/flow/settings/formPrimitives.jsx, flow/displayHelpers.js (unverified start on origin/ts-local/blockers-2C), flow/AccordionSection.jsx, flow/nodeDefs.js, flow/settings/collectionEditors.jsx, mapping/TemplateField.jsx, flow/settings/formDensity.js. Type precisely; every prop/param optional where the code tolerates its absence. Opus review.
2. Batch 22 (.claude/handoff/ts-conversion/batches/22.txt), then the Builder files kept JS in batches 21-26 that step 1 unblocked (sweep-hints.md). Opus review.
3. Batches 19 and 20 (agents/AgentWizard, AgentDesigner, AgentStudio, appearance/PresetSwatch, VersionHistory). canUseFacts.js stays JS. Caught-error second commits. Opus review.
4. Long functions (structural-plan.md §3), characterised first: LF-A4 (flow/settings/approvalEditors, flow/settings/routeEditors, flow/nodes/StepNodeBase), LF-A5 (Builder/DiagramPane, BuilderShell, mapping/ValueBuilder, automation/index.jsx), and in agents: AgentWizard/BuilderSplit.jsx, AgentStudio/index.jsx, builderSplit/useKnowledgeBases. Opus review.
Scope: agent-hub/src/components/automation/**, the paths in batches 19, 20, 22, and those long-function files.

START
1. git fetch origin; git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8. If origin/ts-local/prep2 is not yet in it (git merge-base --is-ancestor origin/ts-local/prep2 HEAD fails): git merge --no-ff origin/ts-local/prep2 (clean). The resulting commit is your BASE (git rev-parse HEAD); it holds the docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts. Where the docs name another base (44072b7db, fe97b2c68), use your BASE.
2. Read in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (JS→TS contract); .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding); in that folder drafter-brief.md + catch-recipe.md (conversion), refactor-brief.md + structural-plan.md §0 and §3 (long functions), sweep-hints.md, review-notes.md, reviews/*.md (style of reviews).
3. Environment fixes for these cloud machines:
   - Node must equal .nvmrc (22.23.2). If node -v differs: download https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify with SHASUMS256.txt from that directory, copy bin/node next to the node on PATH as node.new and mv it over (22.22.0 fails server csv.test.js).
   - npm ci in root, agent-hub, mobile; in server: ONNXRUNTIME_NODE_INSTALL=skip npm ci (its nuget download is cut off by the proxy).
   - Install gitleaks with the version + sha256 pinned in .github/workflows/secret-scan.yml into /usr/local/bin.
   - Measure nproc and free memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with .claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh; one drafting subagent per heavy slot (max 6).
   - Drafting rounds may use an incremental typecheck (from agent-hub): heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo. The check before a merge or push is always the full npm run typecheck.

OWNERSHIP (makes the parallel sessions safe)
- Touch ONLY your scope (plus extension-named import lines in importers, colocated tests, source-reading test paths in mobile/server). Need a file outside it: leave yours as it is and list it as "blocked by <file>" in your report.
- Never convert these (the integrator session owns them, b2-A/b2-B): utils/helpers.js, utils/agentAvatar.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,SideDrawer,UsedByTab,deadlineMath}, admin/compliance/pages/audits/auditForms.js, agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js, and everything under components/admin/Studio/. A file that stays JS only because of one of these: "blocked by b2".
- Never run --update on a ratchet; never commit a budget JSON except .file-budget.json key renames for files you renamed. Never write STATE.md or review-notes.md (shared); your notes go in your report.

HOW
- Git worktrees, one per batch/package, from your BASE. Drafting/mechanical work → subagents with model "sonnet" (drafter-brief.md / refactor-brief.md). Every ~3 batches or every package → an independent read-only "opus" review subagent that also merge-tests your branches together (git merge-tree / scratch merge + typecheck) and checks API shapes against the server routes; write its review to .claude/handoff/ts-conversion/state-2026-10-15/reviews/S1-<topic>.md. Security-relevant code (auth, licence/entitlement gates, erasure, SQL scoping) always gets an Opus review. You merge, fix, verify.
- Existing ts-local/batch-NN branches named in your scope are drafts: typecheck, gate, revert anything not identical, review. Unverified "wip(ts)" commits are never merged as they are.
- Gate: node scripts/ts-equivalence.mjs <BASE> HEAD --diff → 0 different for type-only commits, plus the delete+add pair check (drafter-brief.md step 4). caughtError rewrites in a separate second commit, reviewed as token substitutions. Long-function refactors: characterisation tests first, behaviour preserved, JS files stay JS.
- Integrate into your designated branch with merge commits (never rebase pushed history).
- Before EVERY push: npm run check:fast; cd server && npm run typecheck; node scripts/duplication-ratchet.mjs; npm run lint:gitleaks; agent-hub typecheck + full vitest (npm run test:run); full mobile jest + npx tsc --noEmit in mobile; full server npm test. Full suites one at a time. Push only when all green; push after each integrated step.
- Push ONLY your designated branch (git push -u origin <branch>). Never push main or ccr-28820270-xkvwp8, never open or merge a PR, never deploy.
- Trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator session)
Keep .claude/handoff/ts-conversion/state-2026-10-15/split/S1-report.md current on your branch with every push: branch + BASE + final commit; per batch/package: converted count, files kept JS with reason ("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files; full-suite numbers; ratchet numbers measured (no --update); what the integrator must watch at merge (conflict risks, mirror candidates, behaviour notes). At the end, give the same summary in chat.
```

---

## S2: Admin: compliance, modules, product website, org

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow) as split session S2 (Admin: compliance, modules, product website, org). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

SCOPE
1. Batch 13 (batches/13.txt, admin/compliance; a 6/37 draft on origin/ts-local/batch-13 — redo it). auditForms.js stays JS.
2. Batch 14 (batches/14.txt: compliance, admin/modules, admin/monitoring; UNVERIFIED wip on origin/ts-local/batch-14: finish, typecheck, gate, revert what is not identical). Opus review of 13+14 (compliance has erasure/retention/audit code: security-relevant).
3. Batch 17 (batches/17.txt: product-website + admin/security; UNVERIFIED wip on origin/ts-local/batch-17) — it holds product-website/primitives.jsx and blockEditors/shared.jsx that batch 16 needs.
4. product-website/analytics/ui.jsx and analytics/useAnalyticsQuery.js, then batch 16 (batches/16.txt; 4/45 draft on origin/ts-local/batch-16 — redo it on top of 17). Opus review of 17+16.
5. Batch 15 (batches/15.txt: product-website, admin/org, monitoring; UNVERIFIED wip on origin/ts-local/batch-15). Opus review.
Caught-error second commit per batch (catch-recipe.md).
Scope: the paths in batches 13, 14, 15, 16, 17 and the two analytics files.

START
1. git fetch origin; git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8. If origin/ts-local/prep2 is not yet in it (git merge-base --is-ancestor origin/ts-local/prep2 HEAD fails): git merge --no-ff origin/ts-local/prep2 (clean). The resulting commit is your BASE (git rev-parse HEAD); it holds the docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts. Where the docs name another base (44072b7db, fe97b2c68), use your BASE.
2. Read in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (JS→TS contract); .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding); in that folder drafter-brief.md + catch-recipe.md (conversion), refactor-brief.md + structural-plan.md §0 and §3 (long functions), sweep-hints.md, review-notes.md, reviews/*.md (style of reviews).
3. Environment fixes for these cloud machines:
   - Node must equal .nvmrc (22.23.2). If node -v differs: download https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify with SHASUMS256.txt from that directory, copy bin/node next to the node on PATH as node.new and mv it over (22.22.0 fails server csv.test.js).
   - npm ci in root, agent-hub, mobile; in server: ONNXRUNTIME_NODE_INSTALL=skip npm ci (its nuget download is cut off by the proxy).
   - Install gitleaks with the version + sha256 pinned in .github/workflows/secret-scan.yml into /usr/local/bin.
   - Measure nproc and free memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with .claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh; one drafting subagent per heavy slot (max 6).
   - Drafting rounds may use an incremental typecheck (from agent-hub): heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo. The check before a merge or push is always the full npm run typecheck.

OWNERSHIP (makes the parallel sessions safe)
- Touch ONLY your scope (plus extension-named import lines in importers, colocated tests, source-reading test paths in mobile/server). Need a file outside it: leave yours as it is and list it as "blocked by <file>" in your report.
- Never convert these (the integrator session owns them, b2-A/b2-B): utils/helpers.js, utils/agentAvatar.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,SideDrawer,UsedByTab,deadlineMath}, admin/compliance/pages/audits/auditForms.js, agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js, and everything under components/admin/Studio/. A file that stays JS only because of one of these: "blocked by b2".
- Never run --update on a ratchet; never commit a budget JSON except .file-budget.json key renames for files you renamed. Never write STATE.md or review-notes.md (shared); your notes go in your report.

HOW
- Git worktrees, one per batch/package, from your BASE. Drafting/mechanical work → subagents with model "sonnet" (drafter-brief.md / refactor-brief.md). Every ~3 batches or every package → an independent read-only "opus" review subagent that also merge-tests your branches together (git merge-tree / scratch merge + typecheck) and checks API shapes against the server routes; write its review to .claude/handoff/ts-conversion/state-2026-10-15/reviews/S2-<topic>.md. Security-relevant code (auth, licence/entitlement gates, erasure, SQL scoping) always gets an Opus review. You merge, fix, verify.
- Existing ts-local/batch-NN branches named in your scope are drafts: typecheck, gate, revert anything not identical, review. Unverified "wip(ts)" commits are never merged as they are.
- Gate: node scripts/ts-equivalence.mjs <BASE> HEAD --diff → 0 different for type-only commits, plus the delete+add pair check (drafter-brief.md step 4). caughtError rewrites in a separate second commit, reviewed as token substitutions. Long-function refactors: characterisation tests first, behaviour preserved, JS files stay JS.
- Integrate into your designated branch with merge commits (never rebase pushed history).
- Before EVERY push: npm run check:fast; cd server && npm run typecheck; node scripts/duplication-ratchet.mjs; npm run lint:gitleaks; agent-hub typecheck + full vitest (npm run test:run); full mobile jest + npx tsc --noEmit in mobile; full server npm test. Full suites one at a time. Push only when all green; push after each integrated step.
- Push ONLY your designated branch (git push -u origin <branch>). Never push main or ccr-28820270-xkvwp8, never open or merge a PR, never deploy.
- Trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator session)
Keep .claude/handoff/ts-conversion/state-2026-10-15/split/S2-report.md current on your branch with every push: branch + BASE + final commit; per batch/package: converted count, files kept JS with reason ("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files; full-suite numbers; ratchet numbers measured (no --update); what the integrator must watch at merge (conflict risks, mirror candidates, behaviour notes). At the end, give the same summary in chat.
```

---

## S3: Subscriptions/security + structural (server LF-S7, pages, editor)

```text
You are continuing a multi-session engineering effort on the Bee-Flow monorepo (github.com/Bee-Flow/Bee-Flow) as split session S3 (Subscriptions/security + structural (server LF-S7, pages, editor)). Work autonomously; do not ask for permission for routine steps. Never push to main or to ccr-28820270-xkvwp8, never merge a PR, never deploy.

SCOPE
1. Batch 18 (batches/18.txt: admin/subscriptions, admin/security, admin/shared; UNVERIFIED wip on origin/ts-local/batch-18). Subscriptions = licence/entitlement code: Opus security review. Caught-error second commit.
2. LF-S7 (server, structural-plan.md §3): routes/transcriptions/upload.js POST /, routes/transcriptions/reprocess.js, automation/formQueue.js createFormQueue, routes/automation/catalog.js GET /catalog, and ⚠ auth/connectorJwt.js connectorJwtMiddleware alone (characterised first; Opus security review: fails closed, err propagated through manually composed middleware). Target: node scripts/count-ratchet.mjs long-function server drops by 5.
3. agent-hub long functions no conversion batch owns: LF-A1 ⚠ pages/LoginPage.jsx alone (OPAQUE/MFA, Opus security review), LF-A2 (pages/TemplatesPage.jsx, pages/AdvancedSettings.jsx, pages/EmbedChat.jsx), LF-A6 (renderers/PageRenderer.jsx, 2 counts; ⚠ editor/react/BeeEditor.jsx, Yjs), hooks/useAppBuilderStream.ts and chat/Voice/useVoiceSession.ts (LF-A9). JS files stay JS here.
Scope: the paths in batch 18, those server files, those agent-hub files, their colocated tests and new extracted sibling files.

START
1. git fetch origin; git checkout -B <your designated branch> origin/ccr-28820270-xkvwp8. If origin/ts-local/prep2 is not yet in it (git merge-base --is-ancestor origin/ts-local/prep2 HEAD fails): git merge --no-ff origin/ts-local/prep2 (clean). The resulting commit is your BASE (git rev-parse HEAD); it holds the docs, tools/heavy.sh and agent-hub/src/utils/caughtError.ts. Where the docs name another base (44072b7db, fe97b2c68), use your BASE.
2. Read in order: CLAUDE.md; .claude/handoff/ts-conversion/README.md (JS→TS contract); .claude/handoff/ts-conversion/state-2026-10-15/STATE.md ("Rules that bit us" are binding); in that folder drafter-brief.md + catch-recipe.md (conversion), refactor-brief.md + structural-plan.md §0 and §3 (long functions), sweep-hints.md, review-notes.md, reviews/*.md (style of reviews).
3. Environment fixes for these cloud machines:
   - Node must equal .nvmrc (22.23.2). If node -v differs: download https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz, verify with SHASUMS256.txt from that directory, copy bin/node next to the node on PATH as node.new and mv it over (22.22.0 fails server csv.test.js).
   - npm ci in root, agent-hub, mobile; in server: ONNXRUNTIME_NODE_INSTALL=skip npm ci (its nuget download is cut off by the proxy).
   - Install gitleaks with the version + sha256 pinned in .github/workflows/secret-scan.yml into /usr/local/bin.
   - Measure nproc and free memory. Prefix EVERY agent-hub typecheck/vitest and mobile jest/tsc with .claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh; one drafting subagent per heavy slot (max 6).
   - Drafting rounds may use an incremental typecheck (from agent-hub): heavy.sh node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile $SCRATCH/<worktree>.tsbuildinfo. The check before a merge or push is always the full npm run typecheck.

OWNERSHIP (makes the parallel sessions safe)
- Touch ONLY your scope (plus extension-named import lines in importers, colocated tests, source-reading test paths in mobile/server). Need a file outside it: leave yours as it is and list it as "blocked by <file>" in your report.
- Never convert these (the integrator session owns them, b2-A/b2-B): utils/helpers.js, utils/agentAvatar.js, components/shared/{StudioSectionHeader,kindColors,statusTone,useConfirm,DataTable,DeadlineClock,SideDrawer,UsedByTab,deadlineMath}, admin/compliance/pages/audits/auditForms.js, agents/AgentWizard/canUse/canUseFacts.js, pages/meeting-notes/lib/format.js, and everything under components/admin/Studio/. A file that stays JS only because of one of these: "blocked by b2".
- Never run --update on a ratchet; never commit a budget JSON except .file-budget.json key renames for files you renamed. Never write STATE.md or review-notes.md (shared); your notes go in your report.

HOW
- Git worktrees, one per batch/package, from your BASE. Drafting/mechanical work → subagents with model "sonnet" (drafter-brief.md / refactor-brief.md). Every ~3 batches or every package → an independent read-only "opus" review subagent that also merge-tests your branches together (git merge-tree / scratch merge + typecheck) and checks API shapes against the server routes; write its review to .claude/handoff/ts-conversion/state-2026-10-15/reviews/S3-<topic>.md. Security-relevant code (auth, licence/entitlement gates, erasure, SQL scoping) always gets an Opus review. You merge, fix, verify.
- Existing ts-local/batch-NN branches named in your scope are drafts: typecheck, gate, revert anything not identical, review. Unverified "wip(ts)" commits are never merged as they are.
- Gate: node scripts/ts-equivalence.mjs <BASE> HEAD --diff → 0 different for type-only commits, plus the delete+add pair check (drafter-brief.md step 4). caughtError rewrites in a separate second commit, reviewed as token substitutions. Long-function refactors: characterisation tests first, behaviour preserved, JS files stay JS.
- Integrate into your designated branch with merge commits (never rebase pushed history).
- Before EVERY push: npm run check:fast; cd server && npm run typecheck; node scripts/duplication-ratchet.mjs; npm run lint:gitleaks; agent-hub typecheck + full vitest (npm run test:run); full mobile jest + npx tsc --noEmit in mobile; full server npm test. Full suites one at a time. Push only when all green; push after each integrated step.
- Push ONLY your designated branch (git push -u origin <branch>). Never push main or ccr-28820270-xkvwp8, never open or merge a PR, never deploy.
- Trailers on every commit:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>

REPORT (for the integrator session)
Keep .claude/handoff/ts-conversion/state-2026-10-15/split/S3-report.md current on your branch with every push: branch + BASE + final commit; per batch/package: converted count, files kept JS with reason ("blocked by <file>", "runtime: <construct>", "react-hooks disable"); gate final lines; review files; full-suite numbers; ratchet numbers measured (no --update); what the integrator must watch at merge (conflict risks, mirror candidates, behaviour notes). At the end, give the same summary in chat.
```
