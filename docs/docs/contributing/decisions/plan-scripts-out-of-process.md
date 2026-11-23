---
title: "0036: A Cowork plan's script runs outside the API process, with no network, no apps and no secrets"
description: Why a plan may hold a code step only as a pure calculation, run in a child process of its own around the isolated-vm sandbox, marked so by the run copy and never by its author.
---

# 0036: A Cowork plan's script runs outside the API process, with no network, no apps and no secrets

**Status:** accepted, in effect. **Supersedes:** no earlier record. It extends the step list of
[0030](./cowork-plan-closed-step-list.md) by one type.
**Code:** `server/automation/codeSandboxProcess.js` and `codeSandboxChild.js` (the child process),
`server/core/cowork/plan/planRunCopy.mts` (`withIsolatedScripts`), `server/core/automationRunner/execCode.js`
(the `isolated` branch), `server/core/cowork/plan/coworkStepList.mts`.
**Enforced by:** `server/automation/codeSandboxProcess.escape.test.js` (escape tests),
`server/core/automationRunner/execCode.isolated.test.js`, `server/core/cowork/routine.engine.pg.test.js`
(a plan's script on the real engine), `server/core/cowork/planRun.test.js`.

## Context

Automation code steps run in an isolated-vm isolate inside the API process, with bridges to the web, to the
owner's apps and (one day) to secrets. That is one wall: a flaw in the isolate is a flaw in the server that holds
every organisation's keys. A plan runs unattended on its owner's behalf, so "make it routine" needed scripts for the
calculations fixed steps cannot do, without that exposure.

## Decision

- **A plan's script is a calculation.** It gets its inputs from earlier steps and returns a result; it has no
  network, no app and no secret. Everything a plan reaches, it reaches through its own steps, which the plan card
  shows and the owner approves. In the plan view a script therefore changes and sends nothing.
- **It runs in a child process of its own.** One process per script, started with an environment that holds only
  what Node needs to start (no database address, no keys), its own heap limit, and the isolated-vm sandbox inside
  it: two walls. It is killed when its time is up or when it ends without an answer; the API process only ever sees
  an answer or an error.
- **The run copy decides, not the author.** Every run and every try-out marks the plan's code steps `isolated`,
  inside loops too; a value the author wrote is overwritten. The approved plan and its fingerprint are unchanged.
- The static code checks of every code step still run first.

## Consequences

- A script in a plan cannot fetch or send; a plan that needs that uses a connected app's step.
- Starting a process per script costs tens of milliseconds; a plan's scripts are few and short.
