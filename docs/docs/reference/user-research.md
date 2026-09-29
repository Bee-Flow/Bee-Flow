---
title: User research
---

# User research

Bee Flow occasionally runs usability research: sessions with a person using the
product while someone watches, short remote tasks, and diary studies. This page
is the contract for that work — what is collected, who may be asked, how long
anything is kept, and how to get out.

It exists for the same reason [Telemetry](./telemetry.md) exists. This product
ships an append-only consent ledger, a Records of Processing register it
generates for you, and a data-subject-request pipeline. It would be
indefensible to hold the product to a standard the research behind it does not
meet, so the research is written down in the same place and in the same terms.

:::info[Scope]

This page describes research run by Bee Flow (the vendor) with people who agree
to take part. It is **not** about what the software collects while you use it —
that is [Telemetry](./telemetry.md) — and it does not describe anything a
self-hosted operator does with their own installation.

:::

## Who gets asked

- **Never from the tenancy list.** People using Bee Flow inside a customer
  organisation are that organisation's data subjects, and Bee Flow is their
  processor. Reading a customer's user table to find research participants
  would be a processor using personal data for its own purposes, which is
  exactly the thing an Article 28 arrangement forbids.
- **Always through the customer's administrator.** The administrator decides
  whether to pass an invitation on. If they say no, that is the end of it, and
  Bee Flow is not told who declined.
- **Self-hosted installations cannot be approached at all**, because there is no
  channel to approach them through. A self-hosted install phones nobody; support
  tickets land in the operator's own database. Anyone who tells you what
  self-hosted users do with the mobile app is guessing.

## What a session collects

| Collected | Why | Kept |
|-----------|-----|------|
| A screen recording of the device during the session | The finding is usually *where someone paused*, which no note captures | 90 days |
| The observer's notes | The analysis | 90 days, then anonymised extracts only |
| First name and a contact address | To send the participant their own data, and to honour a withdrawal | 90 days |
| A consent record | To show the session was consented to | Kept with the study record |

Nothing else. Specifically **not** collected: the participant's real work, their
own account, their organisation's documents, or anything they typed outside the
session. Sessions run on a **fixture account on a device Bee Flow supplies**,
loaded with invented documents about invented companies — see
`server/scripts/research/fixtures/` in the repository. That is what makes a
screen recording safe to take at all.

Between sessions the fixture account is reset, so no participant ever sees the
previous participant's session.

## The participant sheet

Hand this to every participant before the session, on paper, and leave them a
copy. It is reproduced here so it cannot quietly diverge from what is published.

---

### Taking part in a Bee Flow session

**What this is.** We will ask you to use an app on a phone we provide and to
say what you are thinking while you do. We are testing the app, not you. There
are no right answers, and the more trouble you have, the more useful the session
is to us.

**How long.** About 45 minutes. You can stop at any moment, for any reason or
none, and you do not have to say why.

**What we record.** The phone's screen, and what you say. Not your face. The
phone is ours and is signed into a test account containing invented documents
about invented companies — no real information about anyone is on it, and
nothing you do reaches your own account or your employer's data.

**What we do with it.** Two or three people at Bee Flow watch the recording and
write down what went wrong in the app. Quotes may appear in an internal report
with your name removed.

**How long we keep it.** The recording and our notes are destroyed **90 days**
after the session. After that, only anonymised findings remain — sentences about
the product, with nothing that points back to you.

**Getting out.** Write to the address below at any time before the destruction
date and we will delete your recording and notes. You do not need a reason, and
nothing happens to you or to your employer as a result. After the destruction
date there is nothing left to delete.

**Your rights.** You can ask for a copy of your recording and notes, ask us to
correct our notes, or ask us to delete them. We answer within a month.

**Who to contact.** privacy@beeflow.nl

**Destruction date for this session:** ____________________
_(the session date plus 90 days — fill this in in front of the participant)_

**Signature** ____________________  **Date** ____________

---

## In the Records of Processing register

An installation that runs research sessions can have the activity appear in its
auto-generated RoPA by setting:

```bash
RESEARCH_STUDIES_ENABLED=true
```

It is off by default and must stay off on a customer's installation — the row
asserts that *this organisation* runs user research, and asserting that on
someone else's behalf is a false record, not a helpful default.

## What research may not do

- It may not read production data to answer a question a study is meant to
  answer. If a study needs to know how often something happens, that is a
  counting question for [aggregate usage data](./telemetry.md), not a reason to
  open somebody's conversation.
- It may not use the `conversation_snapshot` column. It stores the verbatim
  text of a conversation, and no study has ever needed it.
- It may not treat a support ticket as research material. A person writing to
  support is asking for help, not consenting to be studied.
