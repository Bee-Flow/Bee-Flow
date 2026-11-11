---
title: "0021: An app may run its author's code, but only in the isolated code step, over named inputs"
description: Why App Studio has one place where an app's author can write JavaScript, what that place can reach and cannot reach, and why an app is otherwise still data.
---

# 0021: An app may run its author's code, but only in the isolated code step, over named inputs

**Status:** accepted, in effect. **Supersedes:** no earlier record. It replaces the stance written in
the header of `server/appStudio/componentSpecs.js` ("an app definition is a structured component
tree, never code"), which held for every app until this step existed. **Code:**
`server/appStudio/componentSpecs/steps/code.js` (the step), `server/appStudio/codeStepRules.mts`,
`server/appStudio/validate/codeStepChecks.mts`, `server/appStudio/actionExecutor/steps/code.mts`
(runs it in the automation code sandbox, `isolated-vm`). **Enforced by:**
`server/appStudio/validate/codeStepChecks.test.js` (a use of `ctx.http`, `ctx.integrations` or
`ctx.db` is a finding), `server/appStudio/actionExecutor/steps/code.test.js` (inputs resolved
before the sandbox starts under the viewer's row access, limits, no sandbox gives
`code_unavailable`), `server/appStudio/publicAccess.codeStep.test.js` (a visitor's browser never
gets the source or the input bindings) and the corpus app `v3-code-step-quote`.

## Context

Formulas are a closed language and the step list is a closed list. Some work does not fit: a loop
with running state, parsing a pasted text, a custom score over many rows. People worked around it
with automations or gave up. Letting an app run code anywhere (in a formula, in a component, in
the page) would put the author's code next to the viewer's session, and would make every other
rule of an app (row access, outbound privacy, the owner's rights) depend on that code being well
behaved.

## Decision

- **One place.** The `code` step is the only place an app runs its author's code. A formula is still
  a closed language, and nothing runs in the page.
- **Inputs only.** The code is `function main(inputs, ctx)`. Its `inputs` are named bindings that
  the server resolves BEFORE the sandbox starts, under the row access of the person running the
  action. The code sees plain values.
- **No reach.** The sandbox has no network, no database, no integrations and no secrets. `ctx.http`,
  `ctx.integrations` and `ctx.db` are refused. The only effect of the code is its return value; a
  write is an ordinary step after it, with every check an ordinary step has.
- **Bounded.** Source size, number of inputs, rows per input, result size, CPU and wall time, and a
  rate per viewer and app are limits with environment variables (0 = unlimited where it makes sense).
- **Same sandbox as automations.** The step reuses the automation code sandbox and its clamp, so
  there is one thing to keep safe.
- **The visitor of a public page never receives the code.** The public definition keeps the step's
  kind, result variable and error handling, not its source or inputs.

## Consequences

- An app is still a description plus, at most, small pure functions. Review of an app does not have
  to read arbitrary page scripts.
- Where the sandbox is not installed the step fails with a clear code, and an app that needs it does
  not run there.
- The AI builder and the validator both say what the step cannot do. A request for network access
  from code is answered with the REST connector and the `http_request` step, which carry the owner's
  credential and the outbound privacy check.
