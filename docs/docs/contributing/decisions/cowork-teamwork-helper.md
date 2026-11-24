---
title: "0049: The Teamwork helper proposes a desk from plain words and creates nothing; setting it up goes through the desk's own rules"
description: Why desks get a helper that reads what a person writes, what the model sees (their words, cowork titles and colleagues' display names under local labels, never an id or an e-mail address), why it only proposes, and why setting the proposal up calls the desk's existing use cases so every consent and limit of 0045 applies unchanged.
---

# 0049: The Teamwork helper proposes a desk and creates nothing

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0045](./cowork-desks.md) (desks), [0031](./outside-text-informs-never-instructs.md) and
[0040](./cowork-budgets.md).
**Code:** `server/usecases/coworkDeskHelper.mts` (the proposal: the choices, the one model call),
`server/usecases/coworkDeskHelperModel.mts` (what the model is shown, its strict schema, reading the answer back),
`server/usecases/coworkDeskHelperApply.mts` (setting it up through `usecases/coworkDesks.mts` and
`usecases/coworkStart.mts`), `allowHandOffAhead`, `planStartAfter` and `acceptOnDesk` in
`server/usecases/coworkDesks.mts` (the invitation's planned start, column `planned_after_schedule_id` of
`cowork_desk_members` in `server/stores/coworkDesks.mts`),
`POST /api/cowork/desks/helper/draft|apply` in `server/routes/coworkDeskRoutes.js`,
`agent-hub/src/components/cowork/CoworkTeamworkHelper.tsx`.
**Enforced by:** `server/usecases/coworkDeskHelper.test.js` (only the caller's coworks, coworks shared with them
within their organisation and active colleagues are offered; the model never receives an id or an e-mail address;
labels outside the lists are dropped and their words reported as not found; the budget is asked first),
`server/usecases/coworkDeskHelperApply.pg.test.js` (on the real stores: a colleague's cowork is only invited; a
hand-off from a colleague's cowork waits for their yes; the draft is checked again and refused before anything is
made; accepting an invitation applies its planned start with one click; a planned start that became invalid is
refused with its reason while the acceptance holds), `server/usecases/coworkDesks.pg.test.js` (only the desk's maker
plans the start of an invitation, and only of a cowork that is still invited), `server/routes/coworkDeskRoutes.test.js` (strict bodies, the named per-user limit, the budget's refusal).

## Context

Desks (0045) work, but setting one up took six separate settings across two people's screens: members, "starts
after", roles, holders, stand-ins, hand-off consent. People describe teamwork in one sentence ("When my supplier mails
are done, Ben checks the invoices; questions go to Ben, or Lena when he is away"), not as that form.

## Decision

- **A helper, not a second way to make desks.** The Teamwork helper turns the person's words into a proposal: the
  desk's name, its coworks in order, and one question role with a stand-in. It is the first way in (Settings → People,
  and a quiet link on the Cowork home); the full desk settings stay under "All settings", so nothing that a desk can do
  is lost.
- **It proposes; it creates nothing.** Drafting makes one call on the fast tier with a strict schema and writes nothing
  but its usage row. The person changes the proposal with dropdowns that hold only what they may use, and "Set it up"
  is a separate request.
- **What the model sees.** The person's words (their own, through the Cowork Privacy Shield exactly as the composer's
  are), the titles of the coworks they may use and the display names of their colleagues, each under a short local
  label (C1, P1). Never an id, an e-mail address (a username that is one is shown as "A colleague"), a run's content or
  anything a connection read. Titles are marked as names of work, not instructions. The answer refers to labels only;
  a label outside the lists is dropped and the words it stood for are said back as "not found" next to a dropdown.
  Without a model, or when the model or the shield says no, the person gets the same screen empty, to fill by hand.
- **The choices are the desk's own.** The caller's own coworks, coworks a colleague of their organisation shared with
  them, and the active members of that organisation; a cowork on another desk is left out (one desk per item). An item
  of someone else, or of another organisation, is not found.
- **Setting it up goes through the existing use cases, as the caller.** The draft is checked again against what the
  caller may use now (never trusted), the three hand-offs between people in a row and the five coworks of a chain are
  refused before anything is made, and then `createDesk`, `addToDesk`, `setDeskRoles`, `setItemRole` and
  `chooseStart` run in that order, each with its own rules. A colleague's cowork is only invited and joins when its
  owner accepts; the owner of a followed colleague's cowork allows the hand-off.
- **Accepting is one click.** The invitation remembers the start it asks for (`planStartAfter`: start after the cowork
  before it on the desk; only the desk's maker sets it, only on a cowork that is still invited). Accepting applies that
  start once, as the accepting owner, through `chooseStart` with all its checks (the cowork before it still on the same
  desk and accepted, no circle, an agent or a plan to act on the event); the hand-off's consent rows and the chain
  limits of `core/cowork/afterCowork.mts` apply unchanged at run time. A start that is refused leaves the acceptance
  standing and the answer says why, so the owner can choose another start under How it starts. A colleague's cowork
  that is already on the desk keeps its start its owner's to choose, as before. The use cases write on their own, so there is no one transaction: a new desk that cannot be
  filled is removed again, and a hand-off that is refused is reported with its reason.
- **One yes may be said ahead.** When the caller asks for a colleague's cowork to start after one of the caller's own,
  "Set it up" is the caller's yes to that hand-off (`allowHandOffAhead`): the same row "Allow" writes, for that cowork
  and its owner of now, lapsing the same way. It moves nothing until the colleague accepts and chooses that start. A
  yes for someone else's cowork is never given.
- **It counts as Cowork AI.** Refused at the item's or the organisation's budget, booked in the usage ledger under
  Cowork, behind a named per-user limit.

## Consequences

- The result screen says what is done and what waits for whom, in plain words ("Ben has been asked to agree.
  Accepting puts "Invoice check" on the desk and starts it after "Answer supplier mails"."); the colleague gets a notice
  saying the same, and the accept button says what it does ("Accept, and start 'Invoice check' after Ann's 'Answer
  supplier mails'").
- When the caller's cowork should follow a colleague's that is only invited, its start cannot be chosen yet (a start
  after another cowork needs both on the desk); the helper says so, and running it again after the colleague accepted
  sets it.
- The helper sets up one role; more roles, "away until" and taking coworks off are under "All settings".
