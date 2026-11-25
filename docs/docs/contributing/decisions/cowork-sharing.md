---
title: "0039: A shared cowork stays its owner's: colleagues may see it, one may decide its questions, and a share ends with membership"
description: Why sharing gives colleagues of the same organisation sight and at most one the questions, never the item's credentials or the right to change it, and why every read checks current membership.
---

# 0039: A shared cowork stays its owner's

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0032](./cowork-plan-reaches-its-owner.md) and [0035](./plan-independence-levels.md).
**Code:** `server/stores/coworkShares.mts` (`LIVE_SHARES`: only active members of the owner's
organisation), `server/usecases/coworkShares.mts`, `server/routes/coworkShareRoutes.js`,
`server/core/cowork/plan/planIndependence.mts` (`questionFor`: the question is assigned to the
approver), `server/core/cowork/planRun.mts` and `planHeldDefinition.mts`.
**Enforced by:** `server/usecases/coworkShares.test.js`, `server/stores/coworkShares.pg.test.js` (a
share stops counting when its holder leaves, moves or is switched off),
`server/usecases/coworkShares.tenant.pg.test.js`, `server/tenantIsolation.matrix.test.js` (a share
row naming a member of another organisation gives nothing).

## Context

Work often belongs to a team: a colleague should see what the supplier radar found, and someone should
decide while the owner is on holiday. Sharing must not turn into lending credentials, and a share must
not outlive the reason it was given.

## Decision

- **Two roles.** A viewer sees the item and its last runs, read only. One approver also decides the
  questions its runs ask; those questions are assigned to them. There is at most one approver.
- **It stays the owner's.** The item runs as its owner, with the owner's connections; only the owner
  changes it, shares it or hands it over.
- **Same organisation, now.** A share can only name a colleague of the owner's organisation, and every
  read checks that the holder is still an active member of it. Someone who left, moved to another
  organisation or was switched off keeps the row until the owner changes the list, but sees nothing and
  decides nothing.
- **Recorded.** Changing the list is a change in the item's trail, with who got which role.

## Consequences

- A team that needs to change the item hands it over (the new owner approves the plan again) rather
  than sharing it.
- Desks (version 3.1) build hand-offs between owners on the same membership rule.
