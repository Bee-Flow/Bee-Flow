---
title: "0045: Coworks of different owners hand each other data, never access"
description: Why a desk lets coworks of different owners in one organisation start after each other, why both owners say yes (the follower's owner by joining the desk, the followed cowork's owner by allowing the hand-off), why the follower runs as its own owner with only the result text marked as outside text, why a chain ends after three hand-offs between owners, and why a desk role's questions move to a stand-in after a working day and its users are told when it changes hands.
---

# 0045: Coworks of different owners hand each other data, never access

**Status:** accepted, in effect. **Supersedes:** no earlier record. It widens "after another cowork"
(until now one owner's own items only) and builds on [0023](./unattended-runs-act-as-the-owner.md),
[0031](./outside-text-informs-never-instructs.md) and [0039](./cowork-sharing.md).
**Code:** `server/stores/coworkDesks.mts` (desks, members, roles, the allowed hand-offs in
`cowork_desk_follows`; every read counts a person only as an active member of the desk's organisation), `server/core/cowork/afterCowork.mts` (the hand-off,
`MAX_CROSS_OWNER`), `server/usecases/coworkStart.mts` (choosing to start after a desk member; never
after itself), `server/core/cowork/deskQuestions.mts` (who a run's questions go to, decided as it
starts), `server/core/cowork/planQuestionDecider.mts` (who may decide, asked again at the decision),
`server/usecases/coworkDesks.mts` (`allowHandOff`, `withdrawHandOff`, the notice when a role changes hands),
`server/routes/coworkDeskRoutes.js` and `agent-hub/src/components/cowork/CoworkDeskChain.tsx` (the line under a follower).
**Enforced by:** `server/core/cowork/deskHandOff.engine.pg.test.js` (on the real engine: the follower
runs as its own owner, no credential or connection of the other owner is looked up, only the result
text comes along and the plan reads it as outside text; nothing goes along before the followed cowork's owner
allowed it; a follower in another organisation or of a member who left does not start),
`server/stores/coworkDesks.pg.test.js` and `server/usecases/coworkDesks.pg.test.js` (a hand-off across owners waits
for the yes of the followed cowork's owner and nobody else's, can be withdrawn, and is asked again when either cowork
changes hands or leaves the desk; the owners of coworks using a role are told when it changes hands), `server/core/cowork/afterCowork.test.js` (the fourth hand-off between
owners does not happen; no item starts twice in one chain), `server/usecases/coworkStart.test.js`
(following itself is refused on save), `server/core/cowork/deskQuestions.test.js` and
`server/core/cowork/deskQuestions.engine.pg.test.js` (stand-in while away, escalation after a working
day, a former holder cannot decide), `server/tenantIsolation.matrix.test.js` (kind `coworkDesk`).

## Context

Work in a team moves between people: one colleague's supplier radar finds the overdue orders, another
colleague's invoice intake takes them on. Each of those coworks runs unattended as its owner
(0023), with that owner's connections. "After another cowork" already chained items, but only the
owner's own: chaining across owners raises two questions at once. Whose access does the follower run
with, and what does it trust of the text it is handed?

## Decision

- **A desk** is a small set of coworks of different owners in one organisation. An owner puts their
  own cowork on a desk; the desk's maker may invite a colleague's cowork that is shared with them, and it
  joins only when its owner accepts. One desk per item.
- **Two owners say yes to a hand-off.** The receiving owner says yes by putting their cowork on the desk (or
  accepting the invitation) and choosing to start it after a colleague's cowork. That choice alone gives them
  nothing: the owner of the cowork it follows is told, and allows it once on the desk ("Allow"), for that cowork and
  its owner of now. Until then the follower does not start on a hand-off and receives nothing; the followed owner can
  withdraw the yes at any time, and it lapses when either cowork changes hands or leaves the desk. Following one's
  own cowork needs no yes.
- **A hand-off carries data, never access.** When a desk member ends well, the accepted members of the
  desk that chose to start after it run as a normal event run of **their own** owner, with their own
  connections and permissions. They receive only the result text of the run before them, not its title,
  its inputs or anything its owner's connections read. The start is marked as bringing outside text, so
  every rule of 0031 applies to it.
- **Only who counts now.** Every read of a desk counts a person only while they are an active member of
  the desk's organisation (the rule of 0039). An owner who left keeps their rows until someone changes
  them, but their coworks no longer hand work on or receive it, and they hold no role.
- **A chain ends by itself.** At most three hand-offs of one chain go from one owner to another, a chain
  is at most five items long, and an item never starts twice in a chain. A cowork never follows itself:
  that is refused when the start is saved.
- **Roles decide questions.** The desk's maker names roles (holder, stand-in, away until); an owner
  chooses per item which role decides its questions. When the maker gives a role another holder or stand-in, the
  owners whose coworks chose that role are told (the cowork's title and the role's name, nothing else), since their
  questions go to someone else from then on. The route is fixed as a run starts: to the stand-in
  while the holder is away, otherwise to the holder, moving to the stand-in when it is not answered
  within a working day, and the question says so. At the decision the current holder or stand-in may
  decide (besides the owner), never a former holder, though the approval row may still name them.

## Consequences

- Seeing a desk is not enough to read a colleague's results: without the yes of the followed cowork's owner, a
  follower never receives them, however its start is set (the start is checked when it is saved, the yes when the
  hand-off happens).
- Being on a desk adds no permission to anybody's cowork. A follower that needs something it cannot
  reach fails as its owner, the same as any other run of it.
- Across owners the follower does not learn the title of the item before it; its owner sees on the desk
  view which colleague's cowork it follows, and the last status of each cowork, never their runs.
- A working day is 24 hours that skip Saturday and Sunday in UTC; public holidays and working hours are
  not known, so a question asked before a holiday can move to the stand-in early.
- A desk goal (what the desk as a whole works towards) is not part of this decision; the desk view leaves
  room for it.
