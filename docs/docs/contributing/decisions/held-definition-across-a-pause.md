---
title: "0034: A journey a feature started on its own copy keeps that copy across a pause"
description: Why a run that waits for an approval continues, for a Cowork plan, on the plan as approved and not on the automation's stored version and settings.
---

# 0034: A journey a feature started on its own copy keeps that copy across a pause

**Status:** accepted, in effect. **Supersedes:** no earlier record. It completes
[0030](./cowork-plan-closed-step-list.md) and [0032](./cowork-plan-reaches-its-owner.md) for plans
that wait for their owner's decision.
**Code:** `server/core/automationRunner/heldDefinitions.js` (the runner port `heldDefinitions`,
asked first by `resume.js` `automationToResume`), `server/core/cowork/planHeldDefinition.mts`
(Cowork's answer), `server/core/cowork/planRunFollowUp.mts` (closing the run when the journey ends).
**Enforced by:** `server/core/cowork/planRun.engine.pg.test.js` (the real engine on PGlite: it fails
without the port), `server/core/automationRunner/heldDefinitions.test.js`,
`server/core/cowork/planHeldDefinition.test.js`, `planRunFollowUp.test.js`.

## Context

A run that pauses (an approval, a form page) continues in a new leg, on the definition of the
automation version it started on, with the automation's current settings. That is right for a run
of the automation itself.

A Cowork plan runs a copy: the plan as its owner approved it, with notifications held to the owner.
The first leg ran that copy; the second leg ran the automation's stored version. A change to the
automation after the approval, and its own notification settings (other people, a Talk room),
reached the rest of the journey. The end-to-end test showed it: the result step after the approval
said what the changed automation said.

## Decision

- **The engine asks before it resumes.** A feature that starts runs on a copy of its own fills the
  runner port `heldDefinitions` at boot; `automationToResume` asks it first, with the paused run.
  A journey the feature did not start continues as before.
- **Cowork answers with the approved plan,** exactly the run copy the first leg had, after checking
  the fingerprint and the automation. A copy it cannot vouch for stops the journey: continuing on a
  definition nobody approved is the one outcome that may not happen.
- **A paused plan run is `waiting` in Cowork.** The item's schedule moves on; the decision is made
  under Approvals. When the journey ends, the run is closed as success or error, once, from the
  engine's run events, and a sweep every few minutes closes the ones whose end was not heard (a
  restart, another replica). The owner is told when the plan does not tell them itself.

## Consequences

- An approval step in a plan needs the organisation's approvals capability (Enterprise), like any
  approval step.
- The engine's run events are in-process. The sweep is what makes closing a waiting run independent
  of which replica ran the last leg.
