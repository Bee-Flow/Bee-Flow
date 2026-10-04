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
  resumes the moment someone approves. On reject the run ends.
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
  different questions. (Microsoft's approvals refuse to ask the same person twice —
  which quietly collapses a control you deliberately put in place.)
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
