---
title: "0043: A cowork's goal is measured by a check of fixed, read-only steps that ends on met and total, run apart from the cowork's own run"
description: Why a Cowork goal is a sentence plus a separate check, why the check may only hold fixed steps that read and must end on a set step with met and total, why it is run as a dry run of the approved copy after the cowork's run and never as part of it, and why public holidays count as working days.
---

# 0043: A cowork's goal is measured by a fixed, read-only check

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0030](./cowork-plan-closed-step-list.md), [0033](./cowork-planner-builds-with-builder-tools.md) and
[0041](./cowork-run-receipts.md).
**Code:** `server/core/cowork/goals/goalCheck.mts` (what a check may be, and reading its count),
`goalMeasure.mts` (measuring after a run), `server/stores/coworkGoals.mts` (`cowork_goals`,
`cowork_goal_results`), `server/usecases/coworkGoals.mts`, `server/usecases/coworkGoalPlanner.mts` and
`coworkGoalPlannerPrompt.mts` (drafting the check), `server/usecases/coworkDraftLoop.mts` (the draft loop the
planner and the goal planner share), `server/routes/coworkGoalRoutes.js`, `server/shared/expr/workdays.mjs`
(`workdaysBetween`, `addWorkdays`).
**Enforced by:** `server/core/cowork/goals/goalCheck.test.js` (a change, a send, an AI step, a question or a
delivery is refused; the check ends on met and total), `goalMeasure.test.js` (the approved copy runs as a dry run,
two runs within fifteen minutes are measured once, a refused or failing check is a failed measurement and never an
error), `goalMeasure.engine.pg.test.js` (on the real engine: the check's run records zero writes and zero sends,
met and total are stored, a failing check leaves the cowork's run successful), `server/usecases/coworkGoals.test.js`
(refused at approval), `server/tenantIsolation.matrix.test.js` (the goal routes are the owner's).

## Context

A cowork reported whether it ran. Its owner wants to know whether the work is done well: "every supplier mail
gets an answer within two working days", and how close it comes this week. A run's own result cannot say that:
it is one run, written by the run, and the work of a prompt or an agent has no fixed shape to count.

## Decision

- **A sentence and a check.** A goal is the owner's sentence, a target share, and a CHECK: a small plan of its
  own, separate from the item's plan, so a prompt, an agent and a plan can all carry a goal.
- **The check cannot change anything, by its shape.** Every step is a fixed step (no AI step, no data extraction,
  no approval, no notification), every step only reads (by its type, by its tool, and a table step only with an
  operation known to read), it starts by hand, and it ends on one `set` step that writes `met` and `total` (and,
  optionally, `period`). The same rules are asked when the owner approves the check and again before every
  measurement.
- **Drafted, then approved.** The check is drafted from the sentence by the planner's builder loop on a read-only
  menu, stored as an ordinary automation of the owner's, and shown in plain words: its steps, what each does, and
  "reads only". The owner approves the fingerprint they read; a measurement runs the approved copy.
- **Measured apart from the run.** After a run of the cowork ends (`runEnded`), the approved check runs once as a
  dry run, with nobody to answer a pause. At most one measurement per item per fifteen minutes, claimed in the
  store so two servers agree. A check that is refused, fails or throws is kept as a failed measurement with a short
  reason; the cowork's run has already ended and is never touched.
- **Working days are Monday to Friday, and public holidays count as working days.** The expression engine is
  pure and deterministic; it has no calendar of a country or a region to ask. The goal card says so plainly; a
  check that should skip holidays says so in its own steps.

## Consequences

- A check only sees what its read-only steps can fetch; a goal about something no connected app can read cannot
  be measured, and the planner says so.
- Drafting a check is one request (at most two minutes), not a stream like making a plan.
- The daily mail lists the goals under what waits for the owner; goals alone do not send a mail.
- Runs that end within fifteen minutes of a measurement are not measured again; the next run after the window is.
