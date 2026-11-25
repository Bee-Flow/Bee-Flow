---
title: "0037: An organisation's Cowork policy is read at every start, and an unreadable policy is the strictest"
description: Why the read-only switch, the ceiling on independence, the apps that may run while nobody watches and the monthly budget are checked where every run starts, and fail closed.
---

# 0037: An organisation's Cowork policy is read at every start, and an unreadable policy is the strictest

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0035](./plan-independence-levels.md).
**Code:** `server/core/entitlements/coworkPolicy.mts` (the policy, `runRefusalOf`, `appsNotAllowed`),
`server/core/cowork/coworkRunner.js` (`executeCowork`, `startRefusal`: the one door every start goes
through), `server/core/cowork/runApps.mts` (the apps of a prompt or agent run),
`server/core/cowork/planRun.mts` (`levelOf`: the apps and the ceiling of a plan run),
`server/core/cowork/orgBudget.mts` (the monthly budget), `server/routes/coworkSideRoutes.js` (the
read-only gate on changes), `server/routes/coworkPolicyRoutes.js`.
**Enforced by:** `server/core/entitlements/coworkPolicy.test.js`,
`server/core/cowork/coworkRunner.start.test.js` (read-only, the budget and a review's follow-up all
refuse at the door), `server/core/cowork/runApps.test.js` and `runApps.turn.test.js` (no tool of
another app reaches a prompt run, an agent run or a skill activated mid-turn),
`server/core/cowork/orgBudget.test.js`.

## Context

Coworks run with their owner's credentials while nobody watches. An administrator needs a few
switches that hold for every cowork of the organisation, whatever its owner chose: stop everything,
limit how independent a cowork may be, name the apps that may be used unattended, and cap the AI spend.
A switch that one start path forgets is worse than no switch: the administrator believes it holds.

## Decision

- **One door.** Every start (the scheduler, "run now", a mail, an event, a review's follow-up) goes
  through `executeCowork`, which reads the owner's policy first. Nothing below it reads the policy
  again: the list of apps travels on the run.
- **Fail closed.** A policy that cannot be read is the strictest one: read-only, the lowest ceiling,
  no app. A run then fails with that reason; it never goes ahead on a guess.
- **Apps by run kind.** A plan is checked against the list before it starts and when it is approved.
  A prompt run filters the tools it loads. An agent run filters every tool list it is offered,
  including the tools a skill brings halfway through a turn. A tool of no app stays; an MCP server or a
  custom integration is an app of its own. Nothing is refused when an item is saved, because the policy
  can change after that; the app picker offers only the allowed apps.
- **Read-only also stops changes:** the routes that create or change a cowork answer 423.

## Consequences

- A new way to start a cowork is safe by default only if it calls `executeCowork`; a direct call of
  the task runner is a review finding.
- An administrator who empties the app list closes every app for unattended runs, which is what the
  word "list" promises.
- Each server keeps a policy it read for 30 seconds. With several replicas, a change reaches the others
  within that time; a run that started in it ran under the policy it read.
- A run that waits for a decision checks the policy again when it continues, so a read-only switch
  stops it there too.
