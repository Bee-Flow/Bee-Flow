---
title: Approvals
---

# Approvals

An approval is a decision a **person** has to make before something continues — pay
this invoice, send this quote, publish this page, grant this access. Bee Flow turns
that into a durable, auditable record: who was asked, who decided, when, why, and
what they were looking at when they did.

URL: `/app/studio/approvals` · every approval also has its own page at
`/app/studio/approvals/:id`, which is where a notification takes you.

**Tier:** Enterprise. Creating and browsing approvals needs the Enterprise
`approvals` entitlement. Deciding and withdrawing stay open on purpose — if a
licence lapses while requests are still pending, the people already waiting can
finish, rather than being left with rows nobody can ever resolve.

## Where approvals come from

Two places, one record. Whatever asked for it, the row looks the same, lands in the
same inbox, and is answered the same way.

- **Automations** — add an **Approval** step. The run *pauses* at that step and
  resumes the moment someone approves. On reject the run ends, unless the step has an
  [On rejected branch](#when-the-approver-rejects).
- **Apps** — add a **Request approval** step to any action. There is no run behind
  it: the decision *is* the outcome. The app reacts through the `onDecided` hook
  (which writes straight back to a record) and through the `approval.decided`
  event.

- **Solution stages** — when a Production stage requires approval, every deployment to
  it waits as a *deployment* request (see [Deployment requests](#deployment-requests)).
  There is no run behind it either: the decision releases the deployment.

An app can also show its own inbox: drop an **Approval list** component on a screen
and the people who can decide see their pending requests there, and decide in place.

## What an approver sees

More than a yes/no button, because a decision made without the context is not
really a decision:

- **The question** — one line, template-interpolated, so it quotes the actual
  thing: *"Pay invoice INV-2291 from Acme BV — €12,400?"*
- **Details** — a markdown block for the reasoning, the amounts, the drafted text.
- **Attachments** — the PDF, the contract, the generated document. Verified against
  the run's own file ledger, and their expiry is pushed out to the approval's
  deadline so an attachment can never vanish before the decision window closes.
- **Questions** — extra fields the approver fills in while deciding (a PO number, a
  cost centre, a reason). The answers bind downstream as
  `steps.<id>.output.answers.<name>`.

## What the step hands on

An approval step in an automation always hands the same fields to the steps after it,
whoever decided and however the run was started (a production run, a test run, a dry
run, a scenario or a golden replay):

| Field | Holds |
|---|---|
| `approved` | `true` or `false` |
| `by` | The id of the person who decided, or empty |
| `reason` | The comment given with the decision, or empty |
| `decidedAt` | When it was decided |
| `answers` | The answers to the approver's questions, by name; `{}` when there are none |
| `votes` | A panel's votes; `[]` when it is not a panel |

Bind them as `steps.<id>.output.approved`, `steps.<id>.output.answers.<name>` and so on.
A dry run that decided nothing itself marks the step as simulated; the fields stay the
same.

## When the approver rejects

Without anything wired for it, a reject ends the run with the error *Approval rejected*
and the reason.

To do something on a reject instead (tell the requester, file the request elsewhere),
give the approval an **On rejected branch**. In the builder the approval step has two
ports, **Approved** and **On rejected**; connect the next step from the one you mean. A
reject then continues the run along that branch, with `approved: false` in the step's
output, and an approve never takes it. Dry runs, scenarios and golden replays follow
the same branch as a live run. The AI builder and the MCP tools wire it with
`branch: "rejected"` when they add the step after the approval.

The validator checks the branch on every save:

| Code | Level | Meaning |
|---|---|---|
| `edge.rejected_label_invalid` | Error | An on-rejected branch starts from a step that is not an approval, so it would never run. |
| `edge.rejected_label_duplicate` | Error | An approval has more than one on-rejected branch. Keep one and chain the other steps after it. |
| `approval.rejected_only` | Warning | The approval continues only when it is rejected, so an approve ends the run there. |

The decision is recorded before the run continues. If the continuation cannot start,
the run ends with the error code `resume_failed` and its run history says so; the
decision itself stays.

## One approver, a panel, or a chain

Three shapes, in increasing order of ceremony. Pick the smallest one that describes
your actual process.

### One approver

Name a person or a group. With a group, any member may decide and the first
decision wins. Leave it empty and the automation's owner decides.

### A panel

Several **seats** — people and groups, up to 10 — deciding *together*, with a rule:

| Rule | Meaning |
|---|---|
| **Everyone must approve** | Every seat has to say yes. One reject declines immediately. |
| **First to respond** | The first vote decides for everyone. |
| **N of M (quorum)** | Approved at N approvals; declined as soon as N becomes unreachable. |

A group seat is filled by whichever member votes first. Nobody votes twice, and the
owner cannot vote a seat they do not hold — an "everyone must approve" that the
owner can bypass would be theatre.

### A chain of stages

Up to **five named stages**, asked **one after another**. This is the shape for
"team lead, then finance, then a director": each stage has its own approvers and its
own rule, and only the current stage's people are asked, and only when their turn
arrives.

Give each stage a **name** and a **description** — the name is what everyone sees in
the timeline ("Finance"), and the description tells that stage's approvers what they
are being asked to check ("Does this fit the quarter's budget?").

Rules that make a chain predictable:

- **A reject at any stage ends the whole request, immediately.** Nobody further down
  the chain is asked, and the requester hears at once.
- **The same person may sit in more than one stage, and votes in each.** If your
  finance lead is also the director, they are asked twice, because those are two
  different questions. Refusing to ask the same person twice would quietly collapse a
  control you deliberately put in place.
- **Each stage gets its own clock.** The reminder is re-armed when a stage begins,
  so the people asked in stage three get their full window from the moment stage
  three starts, not from when the request was raised a week earlier.

### Conditional stages

A stage can carry a **condition**, written like a condition step's expression:

```
steps.invoice.output.amount > 5000
```

Conditions are evaluated **once**, when the request is raised. A stage whose
condition is not met is **skipped** — and *kept*, marked as skipped. "Why did this
never reach the director?" is an audit question, and a stage that silently vanished
cannot answer it.

You can also route at the flow level: put a **condition** or **switch** step before
the approval and give each branch its own chain. Use per-stage conditions when the
chain is the same shape and one link is optional; use flow-level branching when
different amounts or suppliers need genuinely different chains.

## Reminders, deadlines and escalation

- **Deadline** — 0–720 hours (30 days). `0` means no deadline. An overdue request is
  closed as *expired*, and everyone who was asked hears about it — an approval dying
  in silence is the failure this whole path exists to prevent.
- **Reminder** — nudge again after N hours. It only reaches the people who still owe
  a decision; someone who already voted never reads "still waiting on you".
- **Escalation** — after N hours, a second person or group *gains* the right to
  decide. Escalation **widens** the decider set; the original approver keeps their
  rights. It applies to single-approver requests: a panel's or a chain's own later
  stages are already its takeover mechanism.

A clock that would fire at or after the deadline is dropped, because reminding
someone about an approval that already expired is worse than saying nothing.

## Who can see what

- **Decide** — the current stage's seats (or the panel's seats, or the assignee).
- **Watch** — the owner, an org admin, anyone seated anywhere in the chain, and
  whoever raised the request. Someone seated in stage three can follow the request
  from the start; they simply cannot vote until their turn.
- Everything is scoped to the organisation the approval was requested in, and that
  is frozen at creation. If the owner later moves organisations, historical
  approvals stay where they were decided — that is what an audit means.

## Test approvals

An approval in a test run or a dry run (see
[Testing automations → Run modes](../features/automation-testing.md#run-modes)) is a
**test approval**. It goes to one *sandbox seat*: the person who started the run (for a
form's test link, the person who submitted the form) decides alone, for every approver,
whatever the step says about panels and stages. The automation's owner may decide too.

- **Nobody configured on the step is asked or told.** A live test sends the tester one
  bell titled *Test: approval needed in …*; a dry run in the builder sends nothing,
  because you are watching the canvas. Any other notice about a test approval reaches
  only the tester and the owner, on the bell, with a title that starts with *Test:*.
- **The inbox marks it.** It carries a **Test** chip, says *Test decision: you decide for
  every approver*, and shows *In production this goes to …* with the names of the stages
  and how many seats each has.
- **No clocks, no events.** A test approval has no reminder and no escalation, and it
  raises no `approval.requested` or `approval.decided` event and runs no `onDecided`
  hook, so a test never sets off another automation.
- **It waits a limited time**: at most `AUTOMATION_TEST_PAUSE_TTL_MS` (default 24 hours),
  or the step's own deadline when that is shorter (see
  [Testing automations → Limits](../features/automation-testing.md#limits)).

To rehearse an approval with the real approvers in their seats, deploy the automation to
a Solution's UAT stage (see [Solutions → Stages and deployments](solutions.md#stages-and-deployments)):
runs there are production runs with the stage's own approvers.

## Deployment requests

A Solution's Production stage can require a second person before anything changes in it
(see [Solutions → Stages and deployments](solutions.md#stages-and-deployments)). With that
gate on, a deploy, a redeploy, a removal, a rollback (when the stage says so) and a change
to the gate itself arrive in the approvers' inbox as a request of type **deployment**,
titled *Deploy release 7 of Orders to Production*.

- **The card shows counts and names, never content**: how many parts are created, replaced
  or retired, which columns are retired, which acknowledgements the requester gave, and for
  a removal whether the data is deleted too. The release's own details stay in the pipeline.
- **Four-eyes.** The person who asked for the deployment can never decide it, whatever seat,
  ownership or admin right they also hold, in a single seat, a panel or a chain. A seat the
  requester holds does not count towards "everyone" or a quorum. The stage's approval chain
  is checked when it is saved: every stage of it needs an approver other than the Solution
  owner, or the gate could never open.
- **The decision releases the deployment.** *Approve* queues it, *Reject* closes it, and an
  expiry (7 days) or a withdrawal cancels it. Before it runs, the plan is computed again; if
  it no longer matches what was approved the deployment fails with *the plan changed after
  it was approved* instead of running something nobody saw.
- The requester can **cancel** a request that is still waiting, which withdraws it here.
- Deciding and withdrawing stay available if the licence lapses, like every approval.

## Reacting to a decision

- **`approval.requested` / `approval.decided`** trigger events, for any automation that
  should react — post to a channel, email the customer, start the next automation. The
  decided event carries the final status (`approved`, `rejected`, `expired`,
  `cancelled`), the reason, the answers, every vote, and — for a chain — the stages
  with their names and which ones were skipped.
- **`onDecided`** — App Studio's own channel: a record write executed inside the
  decision itself, with per-outcome column templates over `{{answers.*}}`,
  `{{reason}}` and `{{decidedByName}}`. The row reflects the decision without an
  automation in between.

## The audit trail

Every approval keeps its own history: requested, each vote, each stage hand-over,
reminders, escalations, the decision, and a withdrawal. The record outlives the run
that created it — cancel or delete the run and the decision record stays, because
the decision is the thing worth keeping.
