---
title: "0047: Cowork notices what a person repeats from hashes and weeks only, for that person, after they switch it on"
description: Why "it notices what you repeat" keeps the agent, a hash of the app tools a chat turn used, the weekday and the week, never the words; why it is off until the person switches it on and can be switched off for a whole organisation; and why it offers once.
---

# 0047: Cowork notices what a person repeats from hashes and weeks only

**Status:** accepted, in effect. **Supersedes:** no earlier record.
**Code:** `server/core/cowork/habits/habitSignals.mts` (`noteTurn`, `kindOfTurn`, `inARow`),
`server/stores/coworkHabits.mts`, `server/usecases/coworkHabits.mts`, `server/routes/coworkHabitRoutes.js`,
`server/core/agentRuntime/finalizeTurn.js` (`noticeRepeat`), `server/core/entitlements/coworkPolicy.mts`
(`habitsAllowed`), `agent-hub/src/components/cowork/CoworkHabitChip.tsx`, `CoworkHabitsSwitch.tsx`.
**Enforced by:** `server/core/cowork/habits/habitSignals.pg.test.js` (nothing is noted without the switch
or for a turn that used no app; four weeks in a row gives one offer, once; a row holds a hash, a weekday
and a week and never the question; switching off forgets everything; an organisation that does not allow
it cannot have it switched on), `agent-hub/src/components/cowork/CoworkHabitChip.test.tsx`.

## Context

People ask the same thing every Monday: "which supplier orders are open?". Cowork can take that over,
but only if it notices the pattern, and noticing means remembering what people ask in chat. Chat is the
most private thing in Bee Flow.

## Decision

- **No words are kept.** A turn is reduced to its agent and a sha256 of the app tools it used, with the
  weekday and the ISO week. Only a turn that used at least one app counts. The brief of the cowork that
  is offered comes from the message on the person's own screen, never from the server.
- **Per person, off by default.** Nothing is noted until the person switches it on in Cowork. Switching it
  off deletes everything noted. An organisation's administrators can switch it off for everyone; an
  unreadable policy counts as off.
- **One offer.** Four weeks in a row on the same weekday give one chip under the chat answer; it is never
  offered again for that kind of turn. Accepting opens Cowork with the brief filled in; nothing is created
  until the person confirms.
- **Kept eight weeks**, and removed with the person's account.

## Consequences

- Two different questions that use the same apps look the same; the offer then reads the latest message,
  and the person decides.
- Weekdays are counted in UTC, so a turn just after midnight local time can fall on the day before.
