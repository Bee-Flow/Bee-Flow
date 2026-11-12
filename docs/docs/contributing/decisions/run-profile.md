---
title: "0013: One run profile decides what a run may do"
description: Why every automation run carries one stored record, decided when it starts, that says which copy runs, whether its writes are real, who decides its approvals, how its pauses are answered, who is notified, where form answers go and where a partial run stops.
---

# 0013: One run profile decides what a run may do

**Status:** accepted, in effect. **Code:** `server/core/automationModel/runProfile.mts`
(`profileFor`, `profileOfRun`), stored as `automation_runs.run_profile`
(`server/migrations/automation-run-profile-2026-11.js`), approval output in
`server/core/automationModel/approvalOutput.mts`. **Enforced by:**
`server/core/automationModel/runProfile.test.mjs` (the presets, the legacy derivation and
the agreement with `isTestRun` for every mode, trigger kind and test flag),
`server/core/automationModel/approvalOutput.parity.test.js` and the readers' own tests
(`approvalLifecycle.sandbox.test.js`, `runFinalizeEffects.testApproval.test.js`,
`runHeartbeat.testMarker.test.js`, `resume.dryRun.test.js`,
`execApproval.synthesise.test.js`, `stores/automationStore/runs.profile.test.js`).

## Context

An automation can be started many ways: by its trigger, from the builder as a dry run or a
live test, one step at a time, through a form's test link, by a form scenario or a golden
replay, from the AI builder, over MCP, from the mobile app and over the API. Each of these
needs a different answer to the same questions: which copy runs (the working copy or the
published one), whether sends and writes are real, who decides an approval and who is told
about it, whether an approval or form page pauses for a person or is answered without one,
whether a form submission lands in the answers table, and where a partial run stops.

Without one record, every surface works these answers out for itself from three loose
facts on the run row (`mode`, `is_test`, `trigger_kind`), and a run that continues after a
pause works them out again from whatever its row holds. The answers then drift apart: a
partial run loses its stop point at a pause, and a test run behaves like a production run
in some places and not in others.

## Decision

- **One record, decided once.** `profileFor(facts)` turns what is known when a run starts
  into a profile: `kind` (production, test, dry), `copy` (live, working), `effects` (real,
  simulated), `pauses` (real, synthesise, harness), `approverSeat` (the configured
  approvers, or the tester), `notify` (outcome, approvers, tester), `answers` (production,
  none), `stopAfterStepId`, `holdsMarker`, `pauseTtlMs` and `origin`. It is stored on the
  run row; a continuation after a pause reads it back with `profileOfRun` and never changes
  its kind.
- **Three presets.** A production run uses the configured approvers, notifies as
  configured, writes form answers and holds the automation's running marker. A test run has
  real effects, sends every approval to the tester alone (the sandbox seat), tells only the
  tester, writes no answers and holds no marker. A test run of the live copy (an automation
  managed by a Solution stage) keeps the configured approvers and notifies them: the seat
  is for tests of the working copy. A dry run simulates its writes, notifies
  nobody, and pauses for real only when the caller asks for it (the web builder); otherwise
  it synthesises the answers and marks them, or takes them from a scenario or a replayed run.
- **Readers follow the profile, not the facts.** Approval routing, notifications, the
  running marker, the answers table, pause handling and the stop point of a partial run
  each read one field of the profile. `copy` is still decided by `definitionForRun` and
  recorded in the profile.
- **Legacy rows.** A run without a stored profile derives the one that reproduces the
  behaviour it was started with, so a run that paused before the profile existed continues
  as it would have.
- **One approval output.** Every producer of an approval step's output (a person, a dry
  run's synthesis, a replay) hands on `{ approved, by, reason, decidedAt, answers, votes }`,
  so downstream bindings and the rejected branch read the same in every kind of run.

The user-facing side is the run modes table in
[Testing automations](../../features/automation-testing.md#run-modes).

## Consequences

- A new way to start a run is a new set of facts for `profileFor`, not a new set of checks
  spread over the runner; the presets are tested in one file.
- The run modes table in the documentation is written by hand from the presets. A change to
  a preset changes that table in the same pull request.
- `awaiting_confirm` and the one-time confirmation before a draft's first live run are not
  part of the profile. Rows with that status are still read and shown, as legacy.
- A stored profile is versioned (`v: 1`); a profile that is not readable falls back to the
  legacy derivation rather than failing the run.
