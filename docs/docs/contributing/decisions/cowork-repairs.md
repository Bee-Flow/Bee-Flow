---
title: "0048: Cowork proposes its own repairs and cheaper steps from facts only, proves them on a replay, and never applies one by itself"
description: Why a repair or a fixed step that Cowork works out is a proposal of its own and not a change, why the planner is told facts and never an error message, why a proposal with findings is dropped and a stale one is refused, why a fixed step is offered only at 95% the same on a replay of that change, and why undo is an approval of the earlier version.
---

# 0048: Cowork proposes its own repairs and cheaper steps, and never applies one by itself

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0033](./cowork-planner-builds-with-builder-tools.md), [0040](./cowork-budgets.md),
[0042](./cowork-replay.md) and [0043](./cowork-goals.md).
**Code:** `server/core/cowork/repairs/repairTriggers.mts` (when a repair is worked out),
`server/core/cowork/cheaper/stableSteps.mts` (the weekly look for steady AI steps),
`server/usecases/coworkPlanAmend.mts` and `coworkPlanAmendPrompt.mts` (the planner's amend mode),
`server/usecases/coworkProposals.mts` (making, listing, approving and putting aside a proposal),
`server/usecases/coworkPlanVersions.mts` (approving a definition, and "Undo"), `server/stores/coworkProposals.mts`
(`cowork_proposals`, `cowork_proposal_attempts`), `server/core/cowork/plan/planChanges.mts` (what changes, step by
step), `server/routes/coworkProposalRoutes.js`.
**Enforced by:** `server/core/cowork/repairs/repairs.engine.pg.test.js` (on the real engine: a step that failed
twice with an error message holding instructions and an address gets a repair, and the planner's prompt never holds
that message; making the proposal changes no row of `cowork_plans`, the item or its automation; a run while it is
open executes the approved fingerprint; approving gives exactly the proposal's fingerprint; a stale proposal is
refused; "Undo" gives back exactly the earlier fingerprint), `repairTriggers.test.js` (the two triggers and the
limits: an open repair, read-only, a budget, once a day), `server/core/cowork/cheaper/stableSteps.test.js` (which
steps are steady; the weekly look respects read-only, the budgets and the week),
`server/usecases/coworkProposals.test.js` (a proposal with findings is dropped; below 95% nothing surfaces; a stale
proposal is refused), `server/usecases/coworkPlanAmend.test.js` (a copy is changed; a poisoned error class becomes
"Unknown"), `server/usecases/coworkPlanVersions.test.js`, `server/tenantIsolation.matrix.test.js`.

## Context

A plan that keeps failing at the same step, or a goal that stays under its target, waits for its owner to notice
and fix it in Studio. And an AI step that gives the same answer run after run keeps costing a model call. Cowork
can work out a fix, and it can see which steps are steady. But a plan is what its owner approved: a fix it applied
by itself would be a plan nobody approved, and a fix worked out from what the failing run read would let a mail
tell the planner what to change.

## Decision

- **A proposal is not a change.** The amend mode runs the planner's own loop on a COPY of the approved definition.
  What comes out is stored as a row of `cowork_proposals`: the definition, its fingerprint, the fingerprint of the
  approved plan it was made on, what it may newly do (the `widens` sentences) and the replay that tested it. The
  item, its plan automation and its approved plans are not written.
- **Facts only.** The planner is told the id and title of the step as the approved plan names it and the error
  CLASS a run recorded (a short code; anything else is "Unknown"), or the goal's target and its last three
  percentages, or which steady step to make fixed. Never an error message, never anything a run read or wrote: the
  store's query does not even select the message.
- **When.** A repair after a run in which the same step of the approved plan failed in the last two runs (both of
  that plan), or after the goal stayed under target in the last three measurements. A fixed step weekly, for an AI
  step without tools, knowledge bases or an agent that ended well in at least ten runs of the approved plan. Never
  while the organisation is read-only or a budget is used up; at most one open proposal per item and kind; at most
  one attempt per item per day for a repair and per week for a fixed step, claimed in the store. The model's cost
  is booked on the run that set it off, so it counts on the item's budget.
- **Judged as approval judges it, and proven.** A proposal is held to the plan rules, the licence and the
  organisation's policy; one with any finding is dropped and never shown, and an open one that later gets a finding
  is set aside. Each proposal is replayed on the past runs (0042). A fixed step is replayed only on that change, on
  the runs of the approved plan, comparing that step on what it hands on, and is offered only when at least 95% of
  at least ten replayed runs come out the same; otherwise it is dropped without a word.
- **Approved like a plan.** Approving writes the definition into the plan automation and goes through
  `approvePlan` with every check; a refusal puts the automation back. A proposal whose base is no longer the
  approved plan is stale and refused. An automation with changes its owner has not approved is not written over.
- **One exception.** A broken reference between the plan's own steps, fixed with exactly the same permissions and
  proven on a replay, is approved by Cowork itself and can be undone in one click: see
  [0050](./cowork-auto-resolve.md). Everything else stays a proposal.
- **Undo is an approval.** "Undo" approves the earlier `cowork_plans` version again through the same checks, so it
  gives back exactly the earlier fingerprint and leaves a version of its own in the history.
- **On screen.** A repair is a need: one entry in the item's "Needs you" strip and in the home's list. A fixed step
  is an offer, not a need: one quiet line on the Plan tab, and after approval "Made fixed on … · Undo".

## Consequences

- A fix that needs more than the facts (the content of the failing mail, say) is not found; the owner still sees
  the failure and can fix it in Studio.
- A fixed step replaces only an AI step without tools; "data extraction" is a model too and is not offered as one.
- The weekly look reads every switched-on item with an approved plan in pages; an item gets at most one offer a
  week, its steady steps in turn.
- The phone does not show proposals yet; the daily mail names a repair in one line.
