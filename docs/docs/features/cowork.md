---
title: Cowork
description: Recurring work that Bee Flow does for you, on a schedule or when something happens, with a plan you approve and as much independence as you give it.
---

# Cowork

Cowork does recurring work for you: "every weekday at 07:30, read the supplier mail and tell me which
orders are late". You write what you want in one sentence; Cowork turns it into an item with a
schedule, and runs it as you, with your connected apps, while you do something else.

:::info[Free in Community]

Coworks for yourself are free. Sharing with colleagues, approvals by someone else and the
organisation settings need a licence with those features. See [Tiers](../licensing/tiers.md).

:::

## Start

1. Open **Cowork** and type what should happen, and when. Or choose **Start from a template** to begin
   from work your organisation already set up.
2. Check the proposal (title, schedule, apps) and confirm. The item runs at the next moment.

The home shows what **needs you** (a question, a review, a plan to approve), what runs **today**, the
coworks colleagues **shared with you**, and what Cowork cost in AI this month.

## An item

An item has a short header (status, **Run now**, **Pause**), its brief, and three tabs:

- **Runs**: every run with what it did, what it cost, and, for a plan, each step.
- **Plan**: the fixed steps the work follows (see below).
- **Settings**: how it starts, who it is shared with, its budget, and every change made to it.

### A plan: fixed steps instead of AI every time

Work that is the same every time does not need an AI to work it out again. **Make a plan** lets Cowork
draft fixed steps from your brief: read the mail, filter, look up the order table, write a draft. Only
where judgement or writing is needed is there an AI step. You see in plain words what the plan may
read, change and send, and you approve it. A plan that later wants to do more asks again.

- **Try it first** runs the plan on today's data without changing or sending anything.
- Work that **starts on a new mail** can have a plan too. It saves a draft answer to the sender in your
  mailbox; you read it and send it. A plan never sends an answer by itself.
- **Make it routine**: after a few runs, Cowork can propose a plan from what those runs did, and shows
  side by side that the plan finds the same items.

- **Replay on last month**: after you change a plan, replay it on what the earlier runs read. A replay
  touches no app at all; it shows per run whether the new plan comes out the same, and says so plainly when
  a run could not be replayed.

### A goal, measured every run

Give an item a goal in one sentence, such as "every supplier mail gets an answer within two working
days". Cowork drafts a small check for it, made of steps that only read and count; you approve the check,
and after every run the item shows how it stands ("46 of 49 this week"), on its row, in Today and in the
daily e-mail. Public holidays count as working days.

### How independent it may be

Choose per item: **ask me about everything**, **ask before anything leaves Bee Flow**, or **on its
own** (offered after ten good runs). A question waits under **Needs you**; the rest of the run waits
with it. After you let the same step to the same recipient through five times, Cowork offers to let
that one step go on its own. One stop takes that away again.

### How it starts

On a schedule, by hand, on a new mail, after another cowork, on a webhook, when a row is added to a
table, or when a file lands in a folder. Text that arrives from outside (a mail, a webhook, a file) can
fill the content of what Cowork writes, never who receives it or where it goes.

### Sharing and handing over

Under **Settings → People** you can share an item with colleagues of your organisation: they can see
it and its runs, and one of them can decide its questions. It keeps running as you, and only you change
it. **Hand over** gives the item to a colleague; they approve its plan again before it runs as them.

### Work together

Coworks of different people can hand their results to each other on a **desk**. The easiest way in is
the **Teamwork helper**: under **Settings → People**, choose **Help me set this up** (or **Set up
teamwork** on the Cowork home) and write what should happen, for example "When my supplier mails are
done, Ben checks the invoices. Questions go to purchasing: Ben, or Lena when he is away." The helper
proposes the desk in a few sentences; change any part with its dropdown, then choose **Set it up**.

The helper only proposes; setting up follows the desk's rules. A colleague's cowork joins only when
they accept it, it starts after yours only when they choose that, and a colleague's results reach your
cowork only once they allow it. At most three hand-offs in a row go from one person to another. Each
cowork keeps running as its own owner, with its own connections; only the result goes on. The result
screen says what is done and what waits for whom. Everything else (more roles, away until, taking a
cowork off) is under **All settings**.

### Budget

Give an item a monthly AI budget in euros; at the budget it pauses itself and tells you. Trying a plan,
replaying it and having one made count against the budget too.

### Receipts

Every finished run leaves a receipt: which plan it ran, what it was allowed to do, who approved it and
what it did, in names and counts, never what it read or wrote. Receipts are signed and chained, so a
missing or changed one shows. An opened run shows its receipt; **Settings → Changes** says whether the
chain holds and lets you download it for an audit.

### Templates and package files

**Save as template** (Settings → People) shares a cowork with your organisation; colleagues start from
it under **Start from a template**. A template can also be downloaded as a signed file and added on
another Bee Flow with **Add from a file**: the signature is checked, what its plan may do is worked out
again, and the new item starts paused, with its plan waiting for your approval.

### It notices what you repeat

Switch on **Notice what I ask again and again** at the foot of the Cowork home. When you ask the same
kind of thing in chat on the same weekday four weeks in a row, Cowork offers once to do it for you. It
keeps only which apps a chat used and on which weekday, never what you asked; switching it off forgets
it all.

## For administrators

Under **Security → Privacy Shield → Processing**, an organisation administrator sets, for every cowork
of the organisation:

- **Make every cowork read-only**: nothing runs, nothing changes, until switched off.
- **How independent a cowork may be**: a ceiling on the levels above.
- **Apps a cowork may use while nobody watches**: other apps are left out of every run.
- **Monthly AI budget for all coworks**: at it, coworks stop running until the next month; you are
  told once.
- **Let people switch on "notice what I repeat"**: switch it off to stop it for everyone.
- **Download the trail**: every change to a cowork in the organisation, without what the work says.

## Privacy

A cowork runs as its owner and reaches only what its owner connected. What it sends without a send step
reaches its owner alone. The Privacy Shield is on for prompt runs. The daily e-mail goes only to the
owner, and the trail records who changed what, never the content of the work.
