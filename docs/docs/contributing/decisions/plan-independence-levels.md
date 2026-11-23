---
title: "0035: How independent a Cowork plan may be is a question added at run time, never a change to the plan"
description: Why the three levels of independence put approval steps in front of the steps they are about in the run's copy, keep the approved plan and its fingerprint as they are, and keep a run's level across its pause.
---

# 0035: How independent a Cowork plan may be is a question added at run time, never a change to the plan

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0030](./cowork-plan-closed-step-list.md), [0032](./cowork-plan-reaches-its-owner.md) and
[0034](./held-definition-across-a-pause.md).
**Code:** `server/core/cowork/plan/planIndependence.mts` (the levels, `askTargets`, `withAsks`,
`effectiveIndependence`), `server/core/cowork/planRun.mts` (the level of a run, recorded on it),
`server/core/cowork/planHeldDefinition.mts` (the same questions after a pause),
`server/usecases/coworkIndependence.mts` (which level may be chosen).
**Enforced by:** `server/core/cowork/planRun.engine.pg.test.js` (the real engine: the run stops at
the question in front of the mail, a rejection ends it there, an approval goes on),
`server/core/cowork/plan/planIndependence.test.js`, `server/core/cowork/planRun.test.js`,
`server/usecases/coworkIndependence.test.js`, `server/stores/coworkStore.plans.pg.test.js`.

## Context

An approved plan runs as approved: what it sends, it sends. An owner who wants to see a mail before it
goes out had to put an approval step in the plan, which changes the plan, its fingerprint, and so asks
for a new approval. An owner who trusts a plan more after weeks of good runs had no way to say so.

## Decision

- **Three levels, chosen per item:** "ask me about everything" (every step that changes or sends
  something waits for the owner), "ask before anything leaves Bee Flow" (a step that sends waits;
  changes inside its reach do not), and "on its own". With no choice, a run asks before sending
  where the licence has approvals, else runs on its own: the approval of the plan is then the only
  question there is.
- **A level adds questions to the run's copy.** In front of each step the level asks about, the copy
  gets an approval step that asks the run's owner; whatever led to the step leads to its question. A
  step inside a loop is asked about once, in front of its outermost loop. A result for the owner and
  the plan's own questions are never asked about. The approved plan, its permissions and its
  fingerprint are not touched, so choosing a level never needs a new approval.
- **A run keeps its level.** It is recorded on the run; the held copy after a pause is built with the
  same level, so the journey continues on exactly the steps its first leg had.
- **Asking that cannot be honoured stops the run.** An owner who chose to be asked, when approvals are
  no longer in the licence, gets a refused run and a card that says why, never a run that goes ahead
  without the question.
- **"On its own" is earned.** It opens after ten runs of the same approved version that the owner let
  through since the last one they stopped. A new version starts at zero.

## Consequences

- A decision is made under Approvals and shows under "Needs you", like any approval of a plan.
- The question's id (`cowork_ask__<step>`) is one the plan grammar cannot produce, so the run's trace
  can show it and a resumed journey finds it.
- The ceiling an organisation sets on independence (version 2.2) narrows the levels offered here; it
  does not change how a level works.
