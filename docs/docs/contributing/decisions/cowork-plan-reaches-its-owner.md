---
title: "0032: What a Cowork plan sends without a send step reaches its owner and nobody else"
description: Why a step that waits for a decision asks the plan's owner, why a plan run ignores its automation's own notification settings, and why an automation managed by a Solution stage is no plan.
---

# 0032: What a Cowork plan sends without a send step reaches its owner and nobody else

**Status:** accepted, in effect. **Supersedes:** no earlier record. It completes
[0030](./cowork-plan-closed-step-list.md): the permissions on a plan's card are derived from its
steps, and this record closes the ways a run could reach someone that no step names.
**Code:** `server/core/cowork/plan/planChecks.mts` (the rule for a step that asks),
`planRunCopy.mts` (the notifications of a run), `planSource.mts` (which automation can be a plan).
**Enforced by:** `server/core/cowork/plan/planChecks.test.js`, `planSource.test.js` and
`server/core/cowork/planRun.test.js`.

## Context

A plan's card says who the plan can reach: nobody, only its owner, or other people. "Other people"
is derived from the steps that send through a connected app. Two parts of the automation engine
reach people without such a step:

- an approval step can name another approver, a panel, stages, a final say or an escalation, and
  whoever is named is shown the question with whatever the plan put in it;
- every automation carries notification settings of its own. By default a waiting approval is
  posted as a card in the organisation's Talk approvals room, and the settings can name other
  people, groups and rooms for a failure or a success.

Either one makes "only to you" untrue while the card still says it. A plan run also told its owner
twice about a failure: once from the engine, once from Cowork.

## Decision

- **A step that waits for a decision asks the plan's owner.** An approval step in a plan names no
  assignee, approvers, final approver, escalation or stages; one that does is a finding, and the
  plan is not approved, tried or run.
- **A plan run does not use its automation's notification settings.** The copy the runner is handed
  carries fixed ones: failure and success off (Cowork tells the owner, once), a waiting approval on
  the owner's bell and nowhere else. The approved plan and its fingerprint are not changed; the copy
  is derived at run time.
- **An automation managed by a Solution stage is no plan.** Its runs execute the stage's live copy
  with the stage's settings, so Cowork could neither run exactly what was approved nor hold the
  notifications to the owner. It cannot be named as a plan, and a plan whose automation became
  managed reads as gone.

## Consequences

- A plan cannot ask a colleague to decide. Work that needs someone else's approval stays a Studio
  automation until sharing a Cowork item is designed; then the card will have to say who is asked.
- The owner's own choices under an automation's Settings (a mail on failure, a Talk room) have no
  effect on a run of that automation as a plan. They keep applying when it runs as an automation.
- A try-out was never affected: a dry run sends no notifications at all.
