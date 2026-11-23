---
title: "0030: A Cowork plan is an automation held to a short list of steps, and may do only what its steps name"
description: Why a Cowork plan is stored and run as an automation instead of on an engine of its own, why it may hold only a closed list of step types, and why its permissions and its fingerprint are derived from the plan rather than from its owner's account.
---

# 0030: A Cowork plan is an automation held to a short list of steps, and may do only what its steps name

**Status:** accepted, in effect for the plan core; the routes and the runner that use it follow.
**Supersedes:** no earlier record. It builds on [0023](./unattended-runs-act-as-the-owner.md).
**Code:** `server/core/cowork/plan/coworkStepList.mts` (the list), `planChecks.mts` (the rules, one
pure function), `planPermissions.mts` (permissions, fingerprint, `widens`), `planView.mts` (the
plan as a person reads it), `planLookups.mts` (the registry, the side-effect map and the open-web
list behind them). **Enforced by:** `server/core/cowork/plan/coworkStepList.test.js` (every step
type the engine runs is allowed, refused with a reason, or an annotation: none is undecided),
`planChecks.test.js`, `planPermissions.test.js` (the layout keys are the automation diff's own)
and `planLookups.test.js` (the tool names the tests use are real).

## Context

A Cowork item was a sentence that a model carried out again at every run, with whatever its owner's
account could reach. Work that is the same every time (fetch the mail, update the table, send the
digest) was reasoned out again each run, and nothing said in advance what a run would touch.

Bee Flow already has an engine that runs fixed steps: the automation runner, with versions, a dry
run that reads for real and simulates writes, approvals and a step trace. A second engine for
Cowork would be a second thing to keep safe. But the automation grammar is far wider than a person
who typed one sentence should be handed: free web addresses, code, sub-flows, public forms.

## Decision

- **A plan is an automation definition.** Same grammar (`trigger`, `steps`, `edges`), same runner.
  Cowork adds no step type and no second engine.
- **A closed list.** A plan may hold only the step types in `coworkStepList.mts`. Every other type
  is refused with a sentence that can be shown as it is. A step type that the engine gains later
  is refused until someone decides: the test compares the list with the engine's own.
- **Four kinds, for the reader.** Each allowed type reads as fixed (done the same way every run),
  AI (a model reads, judges or writes), ask (a person decides) or deliver (the result reaches the
  owner). "5 fixed, 2 AI" is counted from the plan.
- **An AI step is offered tools by name.** Never the whole catalogue of its owner, never the grants
  of an agent. An item that should run as an agent runs as that agent as a whole, on the other
  engine.
- **Permissions come from the plan.** `permissionsOf` lists each app the steps touch, as reads,
  writes or sends, with the tool names behind it, whether a model is called and whether text from
  outside the workspace is read. That list is what a person approves.
- **A fingerprint says which plan was approved.** One SHA-256 over the plan without its layout. A
  run compares it with the plan of that moment.
- **Only a wider plan asks again.** `widens` names what a changed plan may do that the approved one
  may not: a new app, a stronger effect, a new tool, a first send to other people, a first model
  call, a first read of outside text. A plan that does less does not need approval again.
- **One function per question.** The same `checkPlan` answers when a plan is made, when it is
  turned on and before every run, so the three cannot disagree.

## Consequences

- What the automation engine can do and a plan cannot (a script, a free web address, a sub-flow, a
  wait) is a deliberate gap. Someone who needs it opens the plan in Studio, where it is an
  automation like any other and the automation rules apply.
- Scripts are refused for now. They arrive when the code sandbox runs outside the server process.
- Moving a step on a canvas does not change a fingerprint; anything else does, including a field
  this code has never heard of. A harmless change that is not layout therefore needs no approval
  only when it also does not widen the permissions.
- Tool names are the unit of a permission. A tool that does two things under one name is granted
  as a whole.
