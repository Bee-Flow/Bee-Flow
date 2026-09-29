---
title: Runs & log
---

# Runs & log

Every time a routine fired: what started it, what it did, and what went wrong. Opening
a run shows it step by step.

URL: `/app/studio/runs`. A single run is deep-linked with **`?run=<id>`** on that same
address (and `?step=<id>` inside it) — a query string, not a path segment, so one
address shape covers "the log" and "this run inside it".

**Tier:** Community. The section is gated on `automations` — the same mount as
Automations, Datatables and Forms — and `automations` is part of the free Community
core.

This is the only Studio section that is **about the past**. It has no *New* action (you
cannot make a run; you make a routine and it runs) and no colour of its own in the
rail, because a run is not one of the things you build. It does carry a count: your own
runs in the last 24 hours.

## "Log" means automation runs

Worth saying plainly, because the word promises more than the screen delivers. Bee Flow
has several logs — the audit trail (Admin → Compliance), agent conversations, app
action history, knowledge-base ingestion — and **none of them is here**. This section
holds automation runs and nothing else.

## Now running · last 24 hours

A strip above the table, on a fixed 24-hour window independent of the table's own range
chip. It distinguishes three answers that are easy to conflate:

- **Nothing has run in the last 24 hours** — read successfully, nothing there.
- **Could not read what is running** — explicitly *not* "nothing is running".
- **This server did not report per-routine activity** — the strip has nothing to show;
  the runs below are unaffected.

## My runs / Organisation

The scope switch is the point of the screen.

- It opens on **My runs** every time, deliberately not remembered. A remembered scope
  is browser state that outlives a permission: someone demoted last week would land on
  an organisation view that then refuses, and the screen would have to explain a
  refusal for a choice nobody made this session.
- **Both buttons are always offered.** The organisation scope is a separate endpoint
  behind an explicit `manage_automations` check, and the server is the authority. A
  client-side guess would either hide the switch from someone who has the permission or
  predict a refusal they can do nothing about.
- **A refusal does not silently fall back.** The switch stays where you put it, and the
  server's own sentence appears with a **Show my runs** way back.
- In the organisation scope the list **does not update by itself** — refresh to see new
  runs — and only the person who started a run can open it.

## The table

Seven columns: **Outcome**, **What ran**, **What happened**, **Started**, **Took**,
**Started by**, and the row actions.

Filters above it:

- **Outcome chips** — All · Success · Failures · Running · Awaiting · Stopped.
- **Range** — 24h · 7d · 30d · All.
- **Live runs / Tests only / Live runs and tests.**
- **Filter by trigger**, **filter by automation**, and a box to **paste a run link or
  id** to jump straight to it.

"Started by" is written as a sentence, not a machine word: *On a schedule*, *Started by
hand*, *Test run*, *Someone filled in the form*, *An app event*, *Asked from chat*, *A
webhook — another system called this*.

## One run

A full-screen view: an execution bar on top, a step-by-step **timeline** beside the run
replayed on a read-only canvas. The timeline answers "in what order, and where did it
stop"; the canvas answers "where in the flow". Selecting a step in either selects it in
both, and in the URL.

While a run is live its steps stream in and the canvas tints in real time without
resetting your zoom or scroll.

From the bar: **Retry** on a failed run (it uses the routine as it is *now*),
**Stop it** on a running one, and **Approve** / **Reject** on a run waiting for a
decision. Retry and approve **open the run they start** rather than dropping you back
on the list to hunt for it. There is also a copy-link action that yields the `?run=`
address of the run you are looking at.

## Where to next

- [Features → Automations](../features/automations.md) — the routines that produce
  these runs.
- [Studio → Approvals](approvals.md) — the decisions a paused run is waiting on.
