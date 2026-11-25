---
title: "0033: Cowork drafts a plan with the automation builder's own tools; the plan check stays the gate"
description: Why the planner is a headless loop on the builder's tools instead of a second builder, what its menu is for, and why nothing it makes is approved or run by it.
---

# 0033: Cowork drafts a plan with the automation builder's own tools; the plan check stays the gate

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0030](./cowork-plan-closed-step-list.md) (what a plan may hold) and
[0031](./outside-text-informs-never-instructs.md) (where outside text may go).
**Code:** `server/usecases/coworkPlanner.mts` (the loop), `coworkPlannerPrompt.mts` (what the model
is told and offered), `coworkPlannerChat.mts` (its model call),
`server/routes/coworkPlannerRoutes.js` (the streamed route).
**Enforced by:** `server/usecases/coworkPlanner.test.js` (a scripted model on the builder's real
tools and validation), `coworkPlannerPrompt.test.js` and `server/routes/coworkPlannerRoutes.test.js`.

## Context

A plan had to be built in Studio first and then named on the Cowork item. That is the right path for
someone who knows the builder, and the wrong one for someone who typed one sentence about work they
want done every morning. Cowork has to be able to make the plan from the brief.

The automation builder already turns a request into a definition, with a model, through tools that
validate every step. Its conversational loop is tied to its own page (a session, work modes, a
stream of its own events). The flowlet agent is the same tools in a headless loop, held to one
sub-flow.

## Decision

- **The planner is a headless loop on the builder's tools.** The same dispatch every other surface
  uses (`applyToolCall`), the same validation, the same store call. What comes out is an ordinary
  automation of the owner's, open in Studio for anyone who wants to refine it by hand.
- **Its menu is narrow.** The batch step builder with its step types narrowed to Cowork's list, the
  tools that correct a step, and the read-only look at a tool's inputs. No trigger tool (the item's
  schedule starts a plan), no sub-flows, no creation of tables or documents, no finalize.
- **The menu is not the gate.** A call outside it is refused before it is carried out, and after
  every change the draft is judged by the builder's validation and by the plan check
  (`planChecks.mts`); both reports go back to the model. Whatever the model ends on, the card shows
  the findings of that same check, and a plan with a finding cannot be approved, tried or run.
- **Making a plan reads no data and calls no app.** The model sees the brief, the names and inputs
  of the owner's connected apps, and the reports about its own draft. The brief is quoted to it as
  the owner's text, not as rules.
- **Nothing is approved here.** The plan is stored and named on the item; its owner looks at it,
  can try it, and approves it. An item that already has a plan is left alone.
- **It is an automation feature.** The route stands behind the automation module, the owner needs
  the `automations` capability, a model call is booked as `cowork_planner` usage of the owner, and
  making a plan is limited per person and in time.

## Consequences

- A plan Cowork drafted appears among the owner's automations, inactive. Taking the plan off an item
  leaves that automation where it is.
- The planner cannot make a plan that needs a step outside the list (a script, a free web address).
  It builds what it can and says what it left out; the note is shown on the card once.
- How good a draft is depends on the model the workspace configured. The tests prove the loop, the
  menu and the gates with a scripted model, not the quality of a real model's plans.
- Changing a drafted plan with a follow-up sentence is not there yet: the owner edits it in Studio,
  or takes it off and makes it again.
