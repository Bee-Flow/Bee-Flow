---
title: "0044: A Cowork plan may start on a new mail; it drafts its answers and never sends them"
description: Why an item that starts on a new mail may carry a plan, with the mail as start data that is outside text, why the one recipient a draft may take from it is the sender of that mail, and why a plan started this way sends nothing itself.
---

# 0044: A Cowork plan may start on a new mail; it drafts its answers and never sends them

**Status:** accepted, in effect. **Supersedes:** no earlier record. It narrows one rule of
[0031](./outside-text-informs-never-instructs.md) for drafts only, and builds on
[0030](./cowork-plan-closed-step-list.md).
**Code:** `server/core/cowork/mailTriggerRun.mts` (`planTriggerOf`: an item with an approved plan runs it
on the mail), `server/core/cowork/plan/planChecks.mts` (`answersStartSender`, the one exemption),
`server/core/cowork/startKinds.mts` (`asStartedBy`: the trigger is marked as bringing outside text),
`server/usecases/coworkPlannerPrompt.mts` (what the planner is told about the mail).
**Enforced by:** `server/core/cowork/plan/planChecks.test.js` (a draft to the sender passes; anything
added to it, a cc from the mail, an address from the text and any send stay refused),
`server/core/cowork/startKinds.test.js`, `server/core/cowork/mailTriggerRun.test.js`,
`server/core/cowork/poisonedMail.engine.pg.test.js` (a mail item's plan that sends cannot be approved).

## Context

Until 3.0, work that starts on a new mail ran only as an agent: the mail went into a prompt, and the
model decided each time. Such items could not be made routine, replayed, repaired or measured, because
all of that works on plans. The obvious plan for a mail desk answers the mail, and answering means a
recipient taken from outside text, which 0031 forbids.

## Decision

- **A mail item may carry a plan.** The mail is the run's start data, as `{{trigger.output.mail.*}}`
  (sender, subject, text, date, message id). The trigger is marked as bringing outside text, so every
  rule of 0031 applies to it.
- **It drafts, it does not send.** The planner is told to save a draft reply and never send one. A draft
  stays in the owner's mailbox until the owner sends it.
- **One exemption, as narrow as it can be:** the `to` of a mail draft may be exactly
  `{{trigger.output.mail.from}}`, the sender of the mail that started the run. Nothing added to it, no cc
  or bcc from the mail, no address found in its text, and no step that sends.
- **No step that sends, whoever it goes to.** `checkPlan` refuses every step whose effect is `sends`
  (`mail.sends`) in a plan that starts on a mail (`startsOnMail`: an item marked by `asStartedBy` with its
  start kind, or a plan whose own trigger is a mail event), also when the plan names the recipient itself.
  A question for the owner and the result for the owner are not sending, and stay.

## Consequences

- A plan that wants to send an answer itself is refused, as before. Sending a reply without the owner
  would need the run to carry the mail's thread into the engine and an always-asked question in front
  of it; that is not part of this decision.
- The mail sits in the run's start data for as long as automation runs are kept, the same place and
  rules as mail that a reading step returns.
- A From header can be forged; a draft to it is still only a draft, which the owner reads before
  sending.
