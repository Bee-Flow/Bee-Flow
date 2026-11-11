---
title: "0023: Unattended runs act as the app owner, and are armed only from a published definition"
description: Why an App Studio action that starts by itself (a schedule, a record change, a webhook) runs as the app's owner with a closed list of steps, why a draft never arms anything, and why every fire re-checks the owner, the app and the trigger.
---

# 0023: Unattended runs act as the app owner, and are armed only from a published definition

**Status:** accepted, in effect. **Supersedes:** no earlier record. **Code:**
`server/appStudio/triggers/unattendedIdentity.mts` (who an unattended run is, and the checks before
every fire), `server/appStudio/triggers/unattendedPolicy.mts` (the steps it may hold),
`server/appStudio/triggers/triggerSpec.mts` (the trigger and its fingerprint),
`server/appStudio/triggers/triggerSync.mts` and `deploySync.mts` (arming, from the published
definition), `server/appStudio/triggers/triggerKinds.mts` and `kinds/` (schedule, record, webhook),
`server/appStudio/backgroundRunIdentity.mts`. **Enforced by:**
`server/appStudio/triggers/unattendedIdentity.test.js`, `triggerFire.test.js`,
`triggerSpec.test.js`, `deploySync.test.js`, `server/appStudio/backgroundRunPolicy.test.js` and the
validator finding of `definitionKeys/triggers.js` (an action that holds a refused step cannot be
published as a trigger's action).

## Context

A click has a person: a session, a role, a page that shows what happens. A trigger has none of
that, and it fires long after the owner looked. Whoever caused it (a clock, a changed row, a call
from outside) has no right to anything the owner can do. Something still has to decide whose row
access, mailbox, automations and budget the run uses.

## Decision

- **The run is the owner.** Its viewer is the owner's account and its role is `owner`, resolved by the
  same resolver a request uses. `viewer.*` in a formula or a row rule is the owner's. Whoever or
  whatever caused the fire is never the run's identity and gets nothing of the owner's rights.
- **Armed only from a published definition.** A draft never arms a trigger. The trigger arms from
  the published copy, with a fingerprint of the trigger and of its action and every action that
  one calls. A published copy that changed without a publish arms nothing.
- **Every fire asks again.** From the database, not the armed row: the app exists and is published,
  it still belongs to the account the trigger was armed for and that account is active, the owner
  still has App Studio, the trigger is in the published definition, switched on and exactly what was
  armed, and every step may run unattended.
- **A closed list of steps.** An action started by a trigger, and every action it calls, may hold
  only steps whose catalogue row says they run unattended. Steps that need a page or a person,
  AI browsing, copying a document and the knowledge-base log steps are refused; a wait and a wait for
  approval put the run on hold, and the run continues as the owner.
- **The walls of every run stay.** Row access for the owner, quotas, the AI budget, the mailbox's
  daily limit, no send e-mail inside a loop, no free URL, and personal data leaving Bee Flow only by
  e-mail.
- **Only the owner can publish.** Publishing is the act that gives a trigger its authority, so it
  is the owner's.

## Consequences

- A trigger's action is powerful on purpose. The Studio panel says plainly that it runs with the
  owner's access, mailbox and automations.
- A deactivated or erased owner's triggers stop firing without anyone editing the app.
- The same pure function gives the validator's finding, the check before arming, the check before
  every fire and the step-by-step refusal inside the run, so the four cannot disagree.
- Documentation of this for builders is in the Studio page on server runs and triggers.
