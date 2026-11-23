---
title: "0038: Trust in a Cowork plan grows per step and recipient, and a single stop takes it away"
description: Why a question in front of a step is only dropped for that step to that recipient after the owner let it through five times, and why the organisation's ceiling still wins.
---

# 0038: Trust in a Cowork plan grows per step and recipient, and a single stop takes it away

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0035](./plan-independence-levels.md) and [0037](./cowork-organisation-policy.md).
**Code:** `server/core/cowork/planTrust.mts` (`TRUST_AFTER`, `recipientOf`, `trustedSteps`),
`server/stores/coworkTrust.mts`, `server/usecases/coworkTrust.mts`,
`server/core/cowork/planRun.mts` (the trusted steps of a run, recorded on it).
**Enforced by:** `server/core/cowork/planTrust.test.js`, `server/stores/coworkTrust.pg.test.js`,
`server/usecases/coworkTrust.test.js`, `server/core/cowork/planRun.engine.pg.test.js` (on the real
engine, the sixth run after five approvals asks nothing for that step).

## Context

"Ask before anything leaves Bee Flow" is the right start for a new plan and tiring after weeks of the
same answer. A level for the whole plan is too coarse: trusting the weekly mail to one supplier says
nothing about a new recipient.

## Decision

- **Counted per step and recipient.** Every decision on a question in front of a step counts for that
  step and the recipient the plan fixes. A recipient the plan picks from data counts as "any
  recipient", so trusting it trusts the step.
- **Earned, offered, never assumed.** After five approvals in a row the owner is offered to let that
  step go on its own. Only their yes removes the question, and only while the plan still sends that
  step to that recipient.
- **A stop resets.** One rejection starts the count again and takes the trust away.
- **The ceiling wins.** Below "on its own", no step goes on its own, whatever it was trusted with.
- **Recorded on the run.** A run keeps the steps it trusted, so a resumed journey asks the same.

## Consequences

- A changed plan that sends the step to another recipient asks again: the trust was never about it.
- The count lives with the item; handing the item over starts a new count for the new owner.
