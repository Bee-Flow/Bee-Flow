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
`usecases/coworkStart.mts`), `allowHandOffAhead` in `server/usecases/coworkDesks.mts`,
`POST /api/cowork/desks/helper/draft|apply` in `server/routes/coworkDeskRoutes.js`,
`agent-hub/src/components/cowork/CoworkTeamworkHelper.tsx`.
**Enforced by:** `server/usecases/coworkDeskHelper.test.js` (only the caller's coworks, coworks shared with them
within their organisation and active colleagues are offered; the model never receives an id or an e-mail address;
labels outside the lists are dropped and their words reported as not found; the budget is asked first),
`server/usecases/coworkDeskHelperApply.pg.test.js` (on the real stores: a colleague's cowork is only invited; a
hand-off from a colleague's cowork waits for their yes; the draft is checked again and refused before anything is
made), `server/routes/coworkDeskRoutes.test.js` (strict bodies, the named per-user limit, the budget's refusal).

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
  owner accepts; its owner chooses to start it after the cowork before it; the owner of a followed colleague's cowork
  allows the hand-off. The use cases write on their own, so there is no one transaction: a new desk that cannot be
  filled is removed again, and a hand-off that is refused is reported with its reason.
- **One yes may be said ahead.** When the caller asks for a colleague's cowork to start after one of the caller's own,
  "Set it up" is the caller's yes to that hand-off (`allowHandOffAhead`): the same row "Allow" writes, for that cowork
  and its owner of now, lapsing the same way. It moves nothing until the colleague accepts and chooses that start. A
  yes for someone else's cowork is never given.
- **It counts as Cowork AI.** Refused at the item's or the organisation's budget, booked in the usage ledger under
  Cowork, behind a named per-user limit.

## Consequences

- The result screen says what is done and what waits for whom, in plain words ("Ben has been asked to agree. It starts
  once they accept "Invoice check" and start it after "Answer supplier mails"."); the colleague gets a notice saying the
  same.
- When the caller's cowork should follow a colleague's that is only invited, its start cannot be chosen yet (a start
  after another cowork needs both on the desk); the helper says so, and running it again after the colleague accepted
  sets it.
- The helper sets up one role; more roles, "away until" and taking coworks off are under "All settings".
