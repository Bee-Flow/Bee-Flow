---
title: "0040: Cowork budgets are measured from the usage ledger; an item pauses itself, an organisation refuses runs"
description: Why the monthly AI budget of one item pauses that item, why the organisation's budget refuses runs without pausing anything, and why a cost that cannot be read does not stop a run.
---

# 0040: Cowork budgets are measured from the usage ledger

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0037](./cowork-organisation-policy.md).
**Code:** `server/stores/coworkRunCosts.mts` (`costsSince`, `orgCostSince`: the ledger rows of a run,
however it ran), `server/core/cowork/runBudget.mts` (one item), `server/core/cowork/orgBudget.mts`
(the organisation, and the subscription's own monthly limits), `server/core/cowork/coworkRunner.js`.
**Enforced by:** `server/stores/coworkStore.costs.pg.test.js`, `server/core/cowork/runBudget.test.js`,
`server/core/cowork/orgBudget.test.js`, `server/core/cowork/coworkRunner.start.test.js`.

## Context

A cowork that loops on a large model can spend a month's money in a night. Owners want a limit per
item; administrators want one for the whole organisation. Both have to count what a run really cost,
whether it was a prompt, an agent conversation or a plan with several legs.

## Decision

- **One measure.** Costs come from the usage ledger, which prices every model call when it is written,
  counted in euros from the 1st of the calendar month.
- **An item pauses itself** at its own budget and tells its owner once; the owner raises the budget or
  switches it on again.
- **An organisation refuses runs** at its budget and pauses nothing, so nothing has to be switched back
  on next month. The first refused run of an item in a month fails with the reason; later moments the
  scheduler finds due move on without a failed run; a run started by hand always says why. The
  administrators are told once a month.
- **Spending, not access.** A cost that cannot be read lets the run go ahead and is logged. The
  read-only switch is the tool for stopping everything.

## Consequences

- A cost in another currency than euros does not count towards a budget; the admin panel says the
  budget is in euros.
- Costs show up a little after a call is made, so a budget can be passed by the run that crosses it.
