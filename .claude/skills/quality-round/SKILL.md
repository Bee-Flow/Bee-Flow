---
name: quality-round
description: Run the next round of the repository quality programme (server strictness and loose JSDoc types, the agent-hub TypeScript and i18n conversions, the count ratchets) with subagents in worktrees, each task on the model that fits it, every batch behind the repo's gates, one push at the end.
---

# quality-round

The programme that took the repo from an average component score of 8.2 to 8.4 (the 2026-10-28
round: `.claude/handoff/ts-conversion/SERVER.md`) continues here. The session that loads this
skill is the **driver**: it plans, spawns the agents, merges their branches, runs the gates and
commits. Agents do batches; they never decide what the round is.

Read `CLAUDE.md` first, then the two handoffs: `.claude/handoff/ts-conversion/README.md`
(agent-hub, local model) and `.claude/handoff/ts-conversion/SERVER.md` (server, JSDoc, the
loose-type round and what stays loose).

## Ground rules (from the owner)

- One feature branch per round, created from the latest `main`. **Push once, at the end**, or
  when the owner asks. Never per batch: every push costs them an approval click and a CI run.
  Open the PR as a draft; mark it ready when the round is done.
- Agents work in **worktrees** (`isolation: "worktree"`, branch `wt/<topic>`), never in the
  main checkout, and never push. Node modules: symlink them from the main checkout
  (`for p in node_modules server/node_modules agent-hub/node_modules mobile/node_modules; do
  [ -e "$p" ] || ln -s "<main checkout>/$p" "$p"; done`).
- Never raise a ratchet budget, never `--suppress-all`, never skip or quarantine a test, never
  raise a file ceiling: a file over its ceiling is split. Comments-only work must keep the
  compiled program identical (`node scripts/ts-behaviour-diff.mjs --base <start> --paths server
  --quiet` reports 0 different).
- Nothing is committed red. Before every commit: `npm run check:fast` from the root, the
  server typecheck (`cd server && npm run typecheck`), and the tests next to the changed files.
- The owner is not watching. Decide; do not ask. Report at the end with the table below.

## Which model does what

| Work | Model | Why |
|---|---|---|
| Driver: plan, spawn, merge, gates, final report | the session's own model (Opus or above) | every merge and every red gate is a judgment call |
| Loose JSDoc types that need a **code change** (the 929 left) | **Opus** agent | the previous round left exactly the cases where a comment is not enough: narrowing by hand, a cast, a shared `ctx` type |
| Server strictness per directory (`jsdoc-round.sh`) | **Sonnet** agent | the tooling writes the types and the gates revert what is wrong; the agent only drives the loop and splits files over their ceiling |
| agent-hub `.js` → `.ts` first draft | **local model** (llama.cpp, Qwen, see README) | measured: the equivalence gate makes the draft's quality irrelevant to correctness; speed and cost decide |
| agent-hub `.js` → `.ts` repair of the gate's rejects | **Sonnet** agent | typed React callbacks and props, mechanical |
| Review of every converted batch before merge | **Opus** agent (fresh, not the one that wrote it) | lazy types where a real one exists nearby, dropped props, the forbidden constructs |
| agent-hub i18n (99 literals left), Dutch comments, history comments, `eslint-disable` and suppression pruning, `style={{}}` to Tailwind | **Sonnet** agent | mechanical, one ratchet each, the ratchet is the gate |
| Long functions (server 114, agent-hub 170) and the 16 server files over 800 lines | **Opus** agent | a split that keeps behaviour is design work; comments-only is not an option here |
| Never | Haiku | measured on the agent-hub conversion: changed the compiled program in 36% of files |

Give every agent: the goal, the files or directory, the gates, the commit format, the rule that
it never pushes and never raises a budget, and "nobody can answer questions; decide yourself".
A fresh agent knows nothing else.

## The workstreams, with their commands

Start the ones that touch different directories at the same time; keep one writer per
directory, and one writer per `server/i18n/defaults/en/<namespace>.js` (two branches adding to
the same namespace file merge silently, the second wins).

### 1. Server strictness (Sonnet, one agent per server directory)

```bash
cd server && node scripts/typecheck.mjs --measure
```

shows per level what is open. Then per directory:

```bash
scripts/jsdoc-round.sh chunks server/<dir>
```

```bash
scripts/jsdoc-round.sh run <label> <work>/<dir>-*.txt
```

The loop commits per batch and reverts whatever a gate refuses. Afterwards
`cd server && node scripts/typecheck.mjs --promote` moves the files that are now clean at a
higher level. Optional, worth it: `node scripts/ts-runtime-types.mjs collect-server --batch
<list> --out obs.json` first and pass `--observed obs.json`.

### 2. The loose types that need code (Opus, one agent per area)

`node scripts/count-ratchet.mjs jsdoc-loose-type server --list` shows where the 929 are. The
categories and why they stayed loose are in SERVER.md ("The loose-type round"). Here a code
change is allowed, so the behaviour diff is informative, not a gate; the tests next to the file
and the full suite of the area are. Each change states in the commit why the narrowing is
safe. Run `node scripts/count-ratchet.mjs jsdoc-loose-type server --update` before each commit.

### 3. agent-hub TypeScript (local model + Sonnet + Opus review)

`node scripts/ts-ratchet.mjs agent-hub --list` shows the 416 `.js`/`.jsx` files. The loop is
written out in README.md: `ts-convert-local.mjs` pass 1 and 2, `ts-equivalence.mjs` as the only
rule, `ts-convert-gate.mjs` keeps the green files, `file-budget.mjs agent-hub`, `ts-ratchet.mjs
agent-hub --update`. Without the laptop's local model, Sonnet drafts.

### 4. agent-hub i18n (Sonnet)

`node scripts/i18n-ratchet.mjs agent-hub --list`: 99 literals. Keys go in
`server/i18n/defaults/en/<namespace>.js`, then `npm run i18n:gen` and commit both files. Never
edit `agent-hub/src/i18n/en-defaults.js` by hand.

### 5. The count ratchets (Sonnet, one agent per metric; Opus for splits)

`node scripts/count-ratchet.mjs <metric> <package> --list` for `long-function`, `big-file`,
`dutch-comment`, `history-comments`, `eslint-disable`, `inline-style`, `fire-event`, `module-mock`,
`fetch-in-effect`; `--update` after each batch (it only lowers). After fixing suppressed eslint
violations: `cd <package> && npm run lint:suppress:prune`.

### 6. What the cloud could not run (driver, once)

`npm run lint:gitleaks`, `cd desktop && npm run verify`, and `uv lock` in `guard-service` or
`classify-service` when a Python dependency moved (the PyTorch index is unreachable from the
cloud, not from the laptop).

## Merging an agent's branch

1. Comments-only branch (strictness, loose types without code): `git merge --no-edit -X theirs
   wt/<topic>`. Anything else: a normal merge; resolve by hand.
2. Then, every time: `cd server && npm run typecheck`; `node scripts/ts-behaviour-diff.mjs
   --base HEAD^1 --paths server --quiet` (0 different for comments-only); a typedef defined
   twice in one file (`grep -oE '@typedef \{.*\} *\w+' <changed files> | sort | uniq -d`); a
   helper one branch typed narrower than a caller the other branch typed (the typecheck names
   it: fix the tag, not the code); the ratchet budgets with `--update` (`jsdoc-loose-type`,
   `checkjs-ratchet.mjs server --update`, the metric the agent worked on); `npm run check:fast`;
   the tests next to every file in `git diff --name-only HEAD^1 HEAD`.
3. A reflowed comment can put a history phrase ("before this", "used to") on one line and trip
   `history-comments`: reword it to state what holds now.
4. Then the full suites, once, before the push: `cd server && npm test`, `cd agent-hub && npm run
   test:run`, `cd mobile && npm test`, `cd desktop && npm run verify`.

## The report

End with one table, main versus branch, from the ratchet files (`server/.jsdoc-loose-type-
ratchet.json`, `server/.checkjs-ratchet.json`, `agent-hub/.ts-ratchet.json`,
`agent-hub/.i18n-ratchet.json`, the `.<metric>-ratchet.json` files touched), plus: the full
suites' pass counts, what each agent left and why, and which `wt/*` branches can be deleted.
Then the one push, and the PR link.

## Last round's numbers (2026-10-28), the baseline for this one

| Metric | main before | after the round |
|---|---|---|
| Loose JSDoc types, server | 2227 | 929 |
| Server files under typecheck (any / noImplicitAny / strict) | 3644 / 2302 / 1929 | 3668 / 2329 / 1954 |
| Mobile untranslated literals | 220 | 0 |
| agent-hub `.js`/`.jsx` files | 418 | 416 |
| agent-hub untranslated literals | 99 | 99 |
| Server files over 800 lines | 17 | 16 |
| Long functions, server / agent-hub | 114 / 173 | 114 / 170 |
