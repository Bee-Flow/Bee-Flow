---
title: "0042: A replay of a changed Cowork plan reads nothing live: every read comes from the past run's recording, and a miss is counted, never fetched"
description: Why "Replay on last month" runs a changed plan as a dry run whose reads are answered only from what the item's past runs read, what a read without a recording means, why the comparison is against the old plan on the same recording, and why runs older than the run history's retention cannot be replayed.
---

# 0042: A replay of a changed plan reads nothing live

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0030](./cowork-plan-closed-step-list.md) and [0041](./cowork-run-receipts.md).
**Code:** `server/core/automationRunner/recordedReads.mts` (recorded reads in the dry-run harness, looked
up before any dispatch), `server/stores/automationStore/persistedInput.mts` (the one form of a step's input
that the run history stores and the lookup hashes), `server/core/cowork/replay/recordingOf.mts`,
`replayRun.mts`, `replayCompare.mts`, `server/stores/coworkReplays.mts` (`cowork_replays`,
`cowork_replay_events`), `server/usecases/coworkReplay.mts`, `server/routes/coworkReplayRoutes.js`.
**Enforced by:** `server/core/cowork/replay/replay.engine.pg.test.js` (on the real engine: a plan that
reads, changes and sends runs live twice, then three replays dispatch nothing to any app and send no
notification; the same plan is the same, a changed mail differs at that step, a read that asks something
else is replayed in part; a live run ignores a harness with recorded reads),
`server/core/automationRunner/recordedReads.test.js`, `server/usecases/coworkReplay.test.js`,
`server/stores/coworkReplays.pg.test.js`.

## Context

An owner who changes a plan wants to know, before approving it, whether it still does what the old one
did. "Try it first" answers that for today, on live reads. It cannot say how the plan would have done on
last month's runs, and a try-out of twenty runs would read twenty times from the owner's apps.

## Decision

- **Nothing live.** A replay is the runner's dry run with `recordedReads.recordedOnly`. Every write and
  send is simulated as in a try-out. Every read (an integration read, a GET, a table read, an AI step
  with tools, an agent or skills) is answered from the past run's recording before any gate or dispatch
  runs; under a replay not even the permission catalog is asked. Outside a dry run the harness is
  dropped, so a live run can never be steered by it.
- **The key.** An integration read is looked up by step id, tool and the SHA-256 of its resolved input in
  the form the run history stores it (secrets masked, capped, canonical JSON). Another step that reaches
  outside is answered when its own definition is the same as then and every step before it handed on
  what it handed on then. A plain AI step asks the model when it changed, on the owner's account like a
  try-out.
- **A miss is counted, never fetched.** A read without a recording hands on its tool's empty shape marked
  `_noRecording`. The step is new, or asks something different than then. The past run is then "replayed
  in part", with the number of such steps; the headline counts only full replays.
- **The same recording on both sides.** Each past run is replayed twice: the plan as approved then (the
  baseline, which reproduces that run from its recording) and the plan as it is now. Both simulate the
  same way, so a run that would do the same comes out the same, input and output, step by step.
  Comparing with the live run itself would set a simulated send next to a real one.
- **Pinned to that run.** Its own trigger data (the `since` and `now` it ran with), its independence
  level and trusted steps, and the answers its questions got.
- **Counts and step ids only.** A replay keeps, per past run, its verdict, the reason it could not be
  replayed (a code), the number of steps without a recording and the ids of the steps that differ. One
  replay runs per item at a time.

## Consequences

- **Retention.** The recording is the run history: runs older than `AUTOMATION_RUN_RETENTION_DAYS` (90 by
  default) cannot be replayed, and neither can a run that followed no plan. A step output that was cut
  at 256 KB and had no full copy kept is no recording.
- A step that loops over items reads with each item's input, which the history does not keep per item:
  such reads count as having no recording.
- A step whose output depends on the clock or on chance (a timestamp, an AI step that is asked again)
  can make a replay differ although the plan did not change in meaning.
- A replay costs AI only where an AI step changed; that cost is the owner's, as for a try-out.
