---
title: "Chat signals"
description: "Optional counts that show whether the Privacy Shield works in chat: what is counted, what is never kept, the preconditions, the notice people see, how they can object, and how long counts are kept."
---

# Chat signals

:::caution[Not legal advice]

This page describes what Bee Flow does. It is not legal advice. Your organisation is
the controller: you decide whether you may switch chat signals on and on which legal
basis, you carry out the DPIA, you get works-council consent where it applies, and you
tell people before counting starts. Check with your data protection officer (DPO) or a
lawyer before you switch it on.

:::

Chat signals answer one question: **does the Privacy Shield work in chat?** For each
message a person sends to an AI in a chat type you select, Bee Flow counts how the
Privacy Shield handled it (for example protected, blocked or sent anyway) and,
optionally, which kinds of personal data it found. The purpose is checking the
effectiveness of a security measure (GDPR Art. 32(1)(d)). The counts are never used to
evaluate employees, their performance, absence or health.

Chat signals are **optional and off by default**. They are part of the Compliance Hub
(the same licence and the same `compliance_hub_gdpr` capability, see
[Audit & compliance](audit-and-compliance.md)). Path: **Compliance → Settings → Chat
signals**, a card of its own below the other settings, with its own Save button.

## How counting works

Nothing new is scanned. The Privacy Shield (and DLP, where it runs) already decides
what happens to each message before it reaches the model. Chat signals turn that
decision into a counter **inside the same request**. The message is not stored, not
read again, and no classifier runs on it.

A message is counted only when all of these hold:

- chat signals are on for that chat type and the start date has passed;
- every precondition for that chat type still holds (see [Preconditions](#preconditions));
- the app the person used **showed the notice** for the current configuration (see
  [What people see](#what-people-see)). The app sends a short marker with the message
  that names the chat type and the version of the configuration it showed. A message
  without that marker, or with an outdated one, is not counted;
- the person has not chosen "Don't count my chat turns" (or, on a website, "Don't count
  my messages").

Counts are held in memory for up to a minute and then added to the stored totals. A
server crash can lose that minute, so the figures say "Counts are approximate."

## What is counted

### Chat types

| Chat type | Who | Notes |
|-----------|-----|-------|
| **Direct chat** | Employees and members | Including the Swarm tier and chats shared into a project. Only the web and desktop app count. |
| **Agent chat** | Members of the agent's own organisation | Someone from another organisation, and a system admin, is never counted in agent chat. |
| **Embedded agents** | Website visitors | Visitors who chat with an agent embedded on your website. A signed-in user in the embed is not counted. |
| Notebook chat | | Coming later. Shown disabled. |

**Messages between people are never counted**: project team chats, comment threads,
support conversations, Nextcloud Talk and mail. Neither are these AI surfaces, which
have no Privacy Shield result to reuse or show no notice: the **mobile app** (in this
release), voice, template chat, the webpage builder, the public webpage AI bridge, App
Studio AI chat, the Nextcloud Assistant, the learning coach, the component designer, the
builders, the meeting-notes assistant, non-streaming agent chat, the support responder
and attachments.

### What is counted for each message

**Privacy Shield outcomes** are always counted when chat signals are on. Each counted
message adds exactly one outcome:

| Outcome | Meaning |
|---------|---------|
| Clean | Scanned, nothing found. |
| Protected | Personal data was found and replaced before the model saw it. |
| Blocked | The message was stopped, by policy or by the person. |
| Sent anyway | Personal data was found and the person sent it unprotected. |
| Scan failed, sent | The scan could not run and the message went through. |
| Scan failed, stopped | The scan could not run and the message was held back. |
| Not scanned | The Shield did not scan this message (for example, it is off for this chat). |

Each outcome is stored with where the message went (an internal model, an external
model, or unknown) and the type of model provider (for example `mistral` or `local`).

**Kinds of personal data** are optional. When switched on, a message that was
protected, blocked or sent anyway adds one count per **kind** found: names, e-mail
addresses, phone numbers, addresses, dates of birth, bank and payment details, online
identifiers, identification numbers, secrets and passwords, and other personal data.
The count says that a kind was present, not how often. Your own data types and DLP
terms are counted as "other personal data"; their names are not kept. Organisation
names and URLs are not counted.

**Health data is never counted, in any form.** A health-related finding is dropped. It
is not counted as "other". The same goes for one of your own data types or DLP terms
whose name points to another special category (religion, ethnic origin, sexual
orientation, political opinion, trade-union membership, biometric or genetic data) or to
criminal data: it is dropped, so "other personal data" can never stand in for it.

Employee chats are stored **per week** (ISO weeks, Monday to Sunday, UTC). Embedded
agents are stored per day.

## What is never kept

Neither the counts nor anything else this feature writes ever contain:

- what anyone wrote, or the personal data that was found;
- who wrote it: no user, guest, conversation, agent, project or model identifier, and
  no agent name;
- IP addresses, user agents, positions in the text, token maps or hashes of any of
  these;
- figures per person, per agent or per conversation. There is no drill-down.

Server logs for this feature carry codes and numbers only.

**The counts are still personal data where few people contribute.** Your organisation
also holds the AI usage log and the Privacy Shield's own event log, both per user, so a
sparse figure could be linked to a person. The GDPR applies in full. Because the counts
hold no identifiers, an access request cannot select a person's rows (Art. 11(2)); the
processing-register entry says so.

## Reading the figures

Open the figures with **Show the figures** on the card, for the last 30 or 90 days.
Every time someone opens them, an entry is written to the access log
(**Compliance → ISO → Sign-in & access log**).

So that the figures do not point to individuals:

- an employee chat type is hidden when **fewer than 5 people** used it in the period,
  and its kinds of data are hidden below **10 people**;
- any count from 1 to 4 reads `<5`, and so does any percentage based on fewer than 5
  messages;
- when a single `<5` cell could be worked out from the others, one more cell is hidden;
- employee chats show only **complete weeks**, and embedded agents only complete days,
  so nobody can compare a growing week day by day;
- the 90-day view of an employee chat type is hidden too when the weeks it adds to the
  30-day view come from fewer than 5 people, so the difference between the two views
  cannot show what a small group did.

Even so, totals can still point to individuals in small groups. Address this in your
DPIA.

The number of people behind a chat type comes from the AI usage log, as a number only.
It includes people whose messages were not counted (mobile app users, people who
objected), so it can be higher than the number of people behind the counts.

## Preconditions

The card will not save while something is missing; it lists what is missing. The same
rules are checked again while chat signals run. If one stops holding (the DPIA expires,
the works council goes back to pending, the notice date is moved after the start), that
chat type **pauses**: counting and the notice in the chat stop together, the card shows
"Paused" with the reason, and the safeguards check fails.

**For every chat type:**

- a legal basis: legitimate interest (Art. 6(1)(f)), public task (Art. 6(1)(e)) or legal
  obligation (Art. 6(1)(c)). Public bodies cannot rely on legitimate interest for their
  tasks. For legitimate interest, confirm that the balancing test is documented;
- a retention of 30 to 90 days;
- when you switch on or count more: confirm that the published notice covers chat
  signals, and that you reviewed the processing-register entry shown on the card.

**For employee chats (direct chat, agent chat), also:**

- a current DPIA. Record it from the card (it is stored with the other DPIAs) or give the
  reference, date and risk level of a DPIA you keep outside Bee Flow. Without an end
  date, a DPIA counts as current for one year;
- if the DPIA finds a high risk: the date of the prior consultation with the supervisory
  authority (Art. 36(1));
- if a DPO is recorded in Compliance Settings: the date of the DPO's advice on the DPIA
  (Art. 35(2));
- the works council: consent obtained, or replacement consent from the court, with the
  date and what the consent covers (chat types, kinds of data, longest retention). Or
  "not applicable" with a reason: no works council, staff representation without a
  consent right, a collective agreement already regulates this, or outside the
  Netherlands. While consent is **pending**, employee chats cannot be counted (WOR
  art. 27(1)(l)). Counting more than the consent covers needs new consent with a newer
  date. Whether a works council applies depends on the headcount of your enterprise,
  not on how many people use Bee Flow;
- an https link to the staff notice and the date it was published, on or before the
  start date;
- a start date. It defaults to **seven days after saving**, so people are told first.
  An earlier date needs confirmation that people were informed before it.

**For embedded agents, also:** an https privacy notice for website visitors. A separate
notice link on the card is used when set, otherwise the privacy-notice URL from
Compliance Settings. Embedded agents start counting when you save.

**On an installation with organisations**, users without an organisation cannot be
counted in employee chats. On an installation without organisations, agents belong to
no organisation, so only direct chat can be counted there.

### Who can change what

Switching on, adding a chat type or a kind of data, a longer retention, a different
legal basis and a wider works-council scope all **count more**. Only an organisation
admin can do that. A DPO with access to the Compliance Hub can read the card, switch
chat signals off, count less and keep the records up to date.

Counting more while chat signals are on moves the start date forward, and all counting
pauses until the new start. People are told before anything new is counted.

## What people see

**In the web and desktop app**, above the message box of every counted chat type, a
line in neutral styling says what is counted, for example: "Your organisation counts
how the Privacy Shield handled messages here. The count does not keep what you wrote or
who wrote it." With kinds of data on, the line says so too. Before the start date it
says "From {date}, …". Next to it are a **Notice** link (your staff notice) and the
button **Don't count my chat turns**. A one-time banner announces each new
configuration; it closes with "Got it". The line itself is always there.

**In an embedded agent**, every visitor first sees "You are chatting with an AI
assistant, not a person." (EU AI Act Art. 50(1)), whether chat signals are on or not.
When chat signals count that embed, a line explains it, with a **Privacy notice** link
and a **Don't count my messages** checkbox.

The marker described under [How counting works](#how-counting-works) is what keeps
"announced" and "counted" the same: a screen that does not show the line sends no
marker, so its messages are not counted. After a change, an open page is not counted
until it has picked up the new configuration (about 30 seconds in the app; a reload for
an embed).

### The notice text

The card offers a notice text to copy into your staff privacy notice. It is filled in
from your settings: the organisation, the chat types, whether kinds of data are
counted, the legal basis (and, for legitimate interest, the interest), the retention,
the start date, your DPO contact and the link to the data-subject request form. It
also describes the Privacy Shield's own per-user event log, which exists separately
from chat signals, and how long that log is kept. Publish the notice before the start
date and check the wording with your DPO.

## Objecting

People can object to being counted (GDPR Art. 21):

- **Don't count my chat turns** (web and desktop). The choice is saved for the person
  and honoured on the next message, on every server within 30 seconds. Bee Flow stores
  only that this person does not want to be counted: no date and no history. It is read
  when that person sends a message and when they open their own choice, nowhere else.
  **There is no admin view, list or count of who objected.** It is removed when the
  account is deleted. "Count them again" undoes it.
- **Don't count my messages** (embedded agents). It lasts for that page only. Nothing
  is stored in the browser: no cookie and no local storage.

The mobile app does not show the notice yet, so its messages are not counted at all.

## Retention and deleting

- Counts are kept for the retention you set: 30 to 90 days, 90 by default. Whole weeks
  (days for embedded agents) are deleted by the retention job, which runs every hour,
  once all of the period is older than the retention. This purge always runs, also
  when `MONITORING_LOG_RETENTION_DAYS=0`.
- **Switching off** stops counting at once on the server that saved it and within 30
  seconds on the others. The counts already collected stay until their retention ends,
  unless you tick **Also delete the collected counts** or use **Delete collected
  counts**.
- Changes to the settings, and deleting counts, are recorded in the compliance evidence
  chain and the access log. Those records hold settings and dates, never the people
  involved in the counts. The evidence the checks write holds only figures that
  already passed the small-group rules. The evidence chain is never purged, which is
  why no small figure goes into it.

## Checks and the processing register

Three checks in the GDPR framework belong to this feature:

| Check | What it checks |
|-------|----------------|
| **The Privacy Shield covers chat messages** (Art. 32) | Per chat type, over 30 days: how often messages reached an external or unknown model without a completed scan, how often a failed scan stopped a message, and how often found personal data was sent anyway. It reads only the totals, with small figures hidden, and judges a chat type only with at least 25 messages and, for employee chats, a complete week and 5 people. |
| **Chat signals keep their safeguards** (Art. 35) | While chat signals are on: the DPIA, the works-council decision and its scope, the notice, the legal basis and the retention. It fails when a chat type is paused, and warns when the DPIA expires within 30 days, the notice link does not answer, the processing register was not reviewed since switching on, or a group is small. |
| **Per-person Privacy Shield views are assessed** (Art. 35) | Always on, whether chat signals are on or not, wherever the per-person views in Usage & Monitoring are available. Those views rank named people by Privacy Shield events, which makes them suitable for checking the behaviour or performance of staff (WOR art. 27(1)(l)). It warns until they are covered by a DPIA, works-council consent and your staff notice. |

While chat signals are on or scheduled, or counts are still stored, the processing
register holds an entry **"Chat signals: checking whether the Privacy Shield works"**
with the purpose, the data, the people concerned, the legal basis, the retention and
the security measures. The card shows the same entry before you save.

## Licence

Chat signals use the Compliance Hub licence; there is no separate feature. If the
licence or the Compliance module lapses, counting and the notice in the chat stop
together within 30 seconds. Your settings are kept.

## Where to next

- [Audit & compliance](audit-and-compliance.md): the Compliance Hub, its checks and the
  evidence chain.
- [Privacy Shield](../features/privacy-shield.md): the detection that decides each
  outcome.
