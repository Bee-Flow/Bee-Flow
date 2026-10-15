# S1 report: Automation Builder + Agents

- Branch: `ccr-c9112ca0-yggf5c`
- BASE: `81d6bedfc` (= `origin/ccr-28820270-xkvwp8` a3afd896 + `--no-ff` merge of `origin/ts-local/prep2`)
- Final commit: (updated on every push)

## Status
| Step | Package | Status |
|---|---|---|
| 1 | Shared Builder modules (7 files) | drafting |
| 2 | Batch 22 + Builder sweep (batches 21-26) | waiting on step 1 |
| 3 | Batches 19, 20 | drafting |
| 4 | Long functions LF-A4, LF-A5, agents | pending |

## Scope notes
- `agents/AgentWizard/builderSplit/useKnowledgeBases.js` is 80 lines and has no function over 200 lines; the
  long-function entry is `hooks/useKnowledgeBases.ts` (LF-A9), outside S1's scope. Nothing to do there.
- `components/apps/appCatalog.jsx` (batch 21) is outside S1's scope (not under automation/).

## BASE is red on two checks (inherited, outside S1's ownership)
Measured on BASE `81d6bedfc` with the full pre-push set (all others green: check:fast 39/39, server
typecheck 0 errors (1074 files), gitleaks clean, agent-hub typecheck 0, vitest 1836 files / 21619 pass,
mobile tsc 0, server tests 28933 pass / 0 fail / 29 skipped):
1. `node scripts/duplication-ratchet.mjs`: production **15423 > budget 15419**. `origin/ccr-28820270-xkvwp8`
   alone is 15379; the +44 comes from the prep2 merge: `admin/Studio/AppStudio/runtime/resolveBinding.ts`
   (lines 50, 75, 261, 394) is now near-identical to `mobile/src/features/app-studio/core/runtime/{paths,dataKeys,resolveBinding}.ts`.
   Fix = a mirror entry (integrator, b2 owns admin/Studio). S1 pushes are gated on "no increase over 15423".
2. mobile jest: `src/meta/serverClosure.test.ts` "has no server pattern that covers nothing mobile reads" fails
   (13429 pass / 1 fail): `mobile/src/core/api/serverContract.test.ts:44` builds the initSchema paths with a
   template literal (`read(\`stores/agent/${f}\`)`), which the closure scan cannot see, so ci.yml's
   `server/stores/agent/{agentTools,directConversations,initSchema}.js` looks stale. Suggested fix: write the three
   paths as plain literals (`['stores/agent/initSchema.js', 'stores/agent/initSchema.base.js', 'stores/agent/initSchema.agents.js'].map(read)`)
   and list `initSchema.base`, `initSchema.agents` in that ci.yml pattern. Already red on `origin/ccr-28820270-xkvwp8`
   (from 9bda3db3), not from prep2. S1 pushes are gated on "this is the only failing mobile test".
