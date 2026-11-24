---
title: "0050: A Cowork run that did not do its work is not a success, its AI can only make a run worse, and a broken reference between a plan's own steps is fixed by itself"
description: Why a run whose list step found no list is incomplete and not green, why an AI's verdict on its own run can turn a success into a failure but never the other way round, and why Cowork may fix a broken reference between a plan's own steps without its owner's approval, as a narrow exception to "only the plan the owner approved runs".
---

# 0050: A run that did not do its work is not a success, and a broken reference is fixed by itself

**Status:** accepted, in effect. **Supersedes:** no earlier record. It is a narrow exception to
[0048](./cowork-repairs.md) ("Cowork never applies a change by itself") and builds on [0041](./cowork-run-receipts.md)
and [0042](./cowork-replay.md).
**Code:** `server/core/cowork/runOutcome.mts` (how a run really ended), `server/core/cowork/planRun.mts` (a plan run
closes by it), `server/core/automationRunner/aiStepVerdict.mts` (an AI step's verdict in its structured output),
`server/core/cowork/plan/planRunCopy.mts` (a run asks every AI step for it), `server/core/cowork/outcomeTool.mts`
(`cowork_report_outcome` for prompt and agent runs), `server/usecases/coworkPlanRefs.mts` (the check before
approval), `server/usecases/coworkPlanTry.mts` (the try-out), `server/core/cowork/repairs/autoResolve.mts` and
`server/usecases/coworkAutoResolve.mts` (the fix), `server/stores/coworkRunOutcomes.mts`,
`server/core/entitlements/coworkPolicy.mts` (`autoFix`), `server/automation/outputSchemasFireflies.mts`.
**Enforced by:** `server/core/cowork/repairs/autoResolve.engine.pg.test.js` (on the real engine: the Fireflies plan
that reads `output.transcripts` from a tool that hands on `results` ends incomplete, not succeeded; the fix takes
`output.results`, changes only that reference, keeps the permissions exactly, is replayed on the run's recording,
approved by Cowork with a trail entry, and the item runs again over every meeting; a marker in the meetings reaches
nothing stored; Undo gives back the old fingerprint; an empty list is a success and sets off nothing; `autoFix: false`,
read-only and a used attempt apply nothing; a fix the replay does not prove becomes a proposal; the model is asked only
when the shape does not answer, with paths and titles only), `server/core/cowork/runOutcome.test.js`,
`server/core/cowork/planRun.test.js` (an AI's "failed" fails the run with its reason; "done" does not clear an
incomplete run; "nothing to do" over an empty list is a success), `server/core/cowork/repairs/autoResolve.test.js`
(a patch that changes a tool or reads another step does not reach the same), `server/core/cowork/outcomeTool.test.js`,
`server/core/automationRunner/aiStepVerdict.test.js`, `execAi.verdict.test.js`,
`server/usecases/coworkPlanRefs.test.js`, `server/usecases/coworkPlanTry.test.js` (a missing path fails the
try-out), `server/core/cowork/receipts/receiptFacts.outcome.test.js` (the outcome is a code on the receipt, the reason
is not in it), `server/stores/coworkProposals.pg.test.js` (an AI-failed step counts toward the repair trigger).

## Context

A plan listed last week's Fireflies meetings and then summarised each one over `steps.list.output.transcripts`. The
tool hands its list on as `results`; `transcripts` is a field name inside the tool that the planner copied. The step
that runs once per item found nothing and was skipped, the AI step wrote "no meetings found", the notification went
out, and the run read "Succeeded, nothing went wrong". The owner never learned that the plan was broken, and the
repairs of 0048 only listen for a step that FAILS twice: this one did not fail.

## Decision

- **Not a success.** After the runner calls a plan run a success, Cowork reads what the run recorded: a step that
  works through a list (run once per item, a Loop, a list step) that was skipped because its reference did not resolve
  to a list, on an earlier step that did run, makes the run `incomplete`. The reference is resolved again with the
  runner's own walk on the recorded outputs, so a list that resolved and was empty (no meetings this week) is a real
  success. An incomplete run closes as `incomplete` on the run and the item, counts with what went wrong, is told to
  the owner ("Did not do its work: step '…' found nothing to work on.") and is a need. The row keeps the facts only:
  step ids, the plan's own reference and the kind of value found, never a value.
- **The AI can only make a run worse.** Every AI step of a plan run ends with a verdict in its structured output
  (`done`, `nothing_to_do` or `failed`, and one short sentence), taken out of the output before anything binds to it
  and kept beside it; a prompt or agent run gives it with `cowork_report_outcome`. `failed` turns a would-be success
  into a failed run with the AI's reason ("The AI says: …"); it counts toward the repair trigger of 0048 as that step
  failing, and the receipt records the outcome as a code, never the reason. `done` and `nothing_to_do` never override
  what the runner found: an error, an unresolved reference, an incomplete run. "Nothing to do" is trusted only when the
  runner saw no unresolved reference. Text from outside (a mail, a tool result) could push the AI to say `failed`;
  that costs the owner a notification, never a send.
- **Prevent first.** The Fireflies tools now have a curated output schema, so the builder refuses `transcripts` when
  the planner adds it. Before approval, and while the planner and the amend mode draft, every list reference to an
  earlier step's described output is checked against that shape (a finding with a plain sentence); a try-out in which a
  list step found no list in what the earlier step really returned is a failure with that sentence. An undescribed
  output is never a finding. "Undo" brings an earlier version back even when that version has such a finding.
- **The exception: a broken reference is fixed by itself.** "Only the plan the owner approved runs" (0048) gets one
  narrow exception. After an incomplete run, Cowork may approve a fixed plan itself, only when ALL of these hold:
  - the change is ONE reference between two existing steps of the plan: the same steps, types, tools and inputs, and
    the reference reads the same earlier step;
  - the permissions are exactly equal (no new step, tool, app or recipient);
  - the candidate comes from the SHAPE of what the earlier step really returned (keys and types, never a value):
    a list whose last name is the missing one, or the one list near the top; only when neither answers does the model
    choose among the lists, from their paths and the step titles alone, under the item's and the organisation's budget;
  - the fixed plan has no finding, and a replay on that run's recording shows the step now gets its list and nothing
    fails;
  - the organisation allows it (`autoFix`, on unless an administrator switches it off; never while read-only), the
    item has no open repair, and it is the item's one attempt of the day.
  It is approved as a new version by `cowork:auto_fix`, recorded in the trail as `cowork.plan_auto_fixed`, shown on
  the item as "Fixed automatically: step '…' was reading the wrong field. · Undo" (Undo approves the version before it
  again, in one click), and a scheduled item runs once more right away through the Cowork runner, so the policy and the
  budgets apply. Anything that does not hold falls back to a repair its owner decides (0048), with the patched plan
  when there is one. Nothing that widens what a plan may do is ever applied.

## Consequences

- An owner whose plan had a broken reference gets a working plan, a note that says so and an Undo, instead of a green
  run that did nothing. A plan whose list legitimately came back empty still reads as a success.
- A run that paused for a decision is judged only when it first stops; its follow-up after the decision closes it as
  before (`core/cowork/planRunFollowUp.mts`).
- An AI step that answered in text now answers `{ answer, coworkOutcome }` in a plan run; its output is the text again,
  so nothing downstream changes. A model that gives no verdict gives none, and the run is judged without it.
- The receipt carries an `outcome` code only when a run was judged, so earlier receipts read as before.
