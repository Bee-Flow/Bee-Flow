# Refactor brief: one structural work package

Your package ID is given in the prompt. Plan: .claude/handoff/ts-conversion/state-2026-10-15/structural-plan.md — read §0 (rules) fully and the section/row for your package (recipes, behaviour changes, file list, verification). Repo rules: CLAUDE.md.
Worktree $WT/<ID>, branch refactor/<ID>, already created at 44072b7db with node_modules symlinked. Work ONLY there; do NOT create worktrees, touch other branches, stash or push.
Prefix every agent-hub typecheck / vitest and every mobile jest with `.claude/handoff/ts-conversion/state-2026-10-15/tools/heavy.sh`.
- Touch only your package's files (+ their colocated tests, + a new leaf file where the plan says so). Needs another package's file → stop and report.
- Behaviour-preserving except the changes the plan lists as intended; keep client-visible tokens (codes/messages clients branch on). Adjust tests on purpose, never weaken an assertion to get green.
- Never commit budget JSONs (.*-ratchet.json, .file-budget.json, .layering-ratchet.json); never run --update.
- Run the package's verification commands from the plan, plus `npm run check:fast`, `node scripts/duplication-ratchet.mjs` and (server) `cd server && npm run -s typecheck` (0 errors) at the end.
- One commit (amend if needed), conventional message, ending with:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LJACbq3gq2PKUfmNJ13uXr

Report (≤ 200 words): what changed (counts before→after for your gate), intended behaviour changes and which tests assert them, verification results verbatim (final lines), anything risky for the reviewer, commit hash.
