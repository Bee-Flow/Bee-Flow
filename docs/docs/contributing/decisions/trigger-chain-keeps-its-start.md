---
title: "0024: A chain of trigger runs keeps the rules of what started it"
description: Why a record trigger fires only on declared writes, why a write by a visitor or a webhook run carries that origin through every later run in the chain, and how depth and burst limits end loops.
---

# 0024: A chain of trigger runs keeps the rules of what started it

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0023](./unattended-runs-act-as-the-owner.md). **Code:**
`server/appStudio/triggers/recordTriggerRule.mts` (the rule, one file read by the validator, the
arming, the write path and the fire), `server/appStudio/triggers/runTriggerCtx.mts` (what the server
hands a run: its chain), `recordOutbox.mts` and `recordDrain.mts` (the writes and the fire),
`kinds/` (what each trigger kind refuses), `recordTriggerLimits.mts`. **Enforced by:**
`server/appStudio/triggers/recordTriggers.test.js` (which writes fire and which do not, the public
table rule, the depth guard, the burst count, the origin kept down a chain),
`httpRequestTrigger.test.js` (a run that a webhook started cannot call out, nor can the runs its
writes start), `triggerSpec.test.js` and `unattendedIdentity.test.js`.

## Context

A record trigger runs the owner's steps when a row changes. The person who changed the row decides
WHEN the owner's steps run, and a second trigger can be started by the first. Without a rule, a
stranger's write on a public page could start a trigger whose action sends mail, and a second
trigger could be the way around any limit the first has.

## Decision

- **Only declared writes fire.** A write fires only when it says where it comes from: a person using
  the app (the record API and the one-row add, change and delete steps) or a trigger run. Writes by
  the AI builder and MCP tools, imports, template installs, connector sync, the mailbox hook, file
  intake, batch and filter writes, delete rules and retention sweeps name no origin and never fire.
- **The public-table rule.** A write by an anonymous visitor, or any write into a table the public
  role may write, fires a trigger only when the trigger says `allowPublicWrites` and its action (and
  every action that one calls) holds none of send e-mail, run an automation, request an approval,
  delete a row or call a web service. This is enforced at publish, when arming, and at every fire,
  reading the table's access at that moment.
- **A chain keeps its start.** A run that a stranger's write could start writes as a visitor again,
  so the next trigger needs the same permission and list. A run of a webhook trigger, and every run
  its writes start, may not call a web service. The start is read from what the server handed the
  run, never from a row value or a request.
- **Loops end by themselves.** A trigger never fires on a write of its own run. A chain stops after
  a fixed depth (default 3, `STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH`), and a run whose chain cannot be
  read writes at a depth beyond every limit. One writer starts a bounded number of runs of one app a
  minute, and all visitors of a public page count as one writer.

## Consequences

- A trigger on a table with public writes is possible, with a smaller set of steps. That is the
  trade the permission names.
- Some changes that look like "a row changed" do not start anything (a filter update, a batch
  create). The panel and the documentation list them so nobody relies on them.
- Rules 1 to 6 sit in one file with the reasons, so a new trigger kind or a new writer decides its
  place there rather than adding a check elsewhere.
