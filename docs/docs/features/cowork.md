---
title: Cowork
description: Recurring work that Bee Flow does for you, on a schedule or when something happens, with a plan you approve and as much independence as you give it.
---

# Cowork

Cowork does recurring work for you: "every weekday at 07:30, read the supplier mail and tell me which
orders are late". You write what you want in one sentence; Cowork turns it into a task with a
schedule, and runs it as you, with your connected apps, while you do something else.

:::info[Free in Community]

Tasks for yourself are free, and so is sharing them with colleagues. Fixed steps need a licence with
automations, and letting a task ask you first needs one with approvals. See [Tiers](../licensing/tiers.md).

:::

## Start

On your first visit, Bee demonstrates a weekly digest using example data. You can select a step, read the sample result, or jump straight to **Choose my view**. Select **Chat with the orb**, **Chat only**, or **Advanced**. Cowork remembers your choice for this account in this browser. To change it later, open **Advanced** and select **Default view**.

1. Open **Cowork** and tell Bee what should happen and when. You can also ask Bee to show your tasks or find a template.
2. Bee asks for any missing details and shows the current step while it sets up and tests the task. If you request delivery, you can review the recipients.
3. When setup finishes, the task opens automatically. Review the test result and approve the steps before the first real run.

The orb shows the task’s steps in execution order. It draws app icons as coloured networks. As each step starts, its icon moves forward and the previous step recedes. With reduced motion enabled, the current step appears in a still frame.

Choose **Advanced** before starting to select a model or add a specific step. **Preview task** lets you review and edit the name, schedule, apps and requested recipients. Workspaces without fixed steps use a preview and ask before starting the task.

Choose **Advanced** on the home screen for the full task list, shared tasks, **Teamwork** and your **Cowork preferences**. Administrators can also open **Admin rules**.

A task always has one of these states: Done, Failed, Needs you, Scheduled, Running, Testing, Paused or
Nothing to do.

## A task

A task opens with Bee and an input field. On desktop the steps appear beside the orb. Select one or more steps and ask Bee to explain or change them. Ask for the latest result or an earlier run to read it alongside the conversation on a wide screen.

You can also ask Bee to change the schedule, share the task or pause it. Bee shows the details for confirmation when the action needs your approval. Choose **Advanced** to work directly with **Result**, **Settings**, **Steps**, **People** and **History**.

### Settings: What, When, Uses, Sends to

Everything about one task is under the same four questions the card asked at the start.

- **What**: its name, the sentence, and a **target to track**.
- **When**: its schedule, or what starts it: by hand, on a new mail, after another task, on a webhook,
  when a row is added to a table, or when a file lands in a folder. Text that arrives from outside (a
  mail, a webhook, a file) can fill the content of what Cowork writes, never who receives it or where
  it goes.
- **Uses**: the apps, how it works (the AI each time, an agent, or fixed steps), **what it remembers**
  between runs, and its **spending limit**.
- **Sends to**: who receives the result, and one choice for when it asks you:
  **Ask me before every change or message**, **Show me each message first**, or **Don't ask** (offered
  after ten good runs). After you let the same message to the same recipient through five times, Cowork
  offers to let that one go on its own; one stop takes that away again.

### Steps: fixed steps instead of AI every time

Work that is the same every time does not need an AI to work it out again. Cowork drafts fixed steps
from your sentence (read the mail, filter, look up the order table, write a draft), with an AI step only
where judgement or writing is needed. Before you see them, Cowork tests the steps itself and repairs
what it can, such as a step that would run before the step it reads from.

- The first time, you see **what the test produced** and who each sending step reaches, in plain words,
  and you choose **Approve** or **Change something**. Steps that later want to do more ask again.
- **Test, sends nothing** runs the steps on today's data without changing or sending anything.
- **Compare with last month** runs changed steps on what the earlier runs read. It touches no app at
  all, shows per run whether the outcome is the same, and says so plainly when a run could not be
  compared.
- Work that **starts on a new mail** can have fixed steps too. It saves a draft answer to the sender in
  your mailbox; you read it and send it. It never sends an answer by itself.
- When setting up the steps does not work, Cowork does not quietly switch to another way of working.
  A card under **Needs you** says so and gives you the choice: **Try setting up again**, or **Let the AI
  work it out every run**, which you can undo.

### When something goes wrong

Open the task or ask Bee what needs your attention. Bee explains the cause when it is known and offers a next step, such as signing in again or retrying. The **Advanced** overview also lists tasks under **Needs you**.
What Cowork can repair without widening what the task may do, it repairs itself, tests, and reports with
**Undo**. The raw message is under **Technical details**.

### A target to track

Give a task a target in one sentence, such as "every supplier mail gets an answer within two working
days". Cowork drafts a small check for it, made of steps that only read and count; you approve the check,
and after every run the task shows how it stands ("46 of 49 this week"), on its row and in the morning
e-mail. Public holidays count as working days.

### Spending limit

Give a task a monthly AI limit in euros; at the limit it pauses itself and tells you. Testing, comparing
and having steps made count against the limit too.

### People

- **Share** a task with colleagues of your organisation: they can see it and its runs, and one of them
  can decide its questions. It keeps running as you, and only you change it.
- **Send each result to a colleague's task**: the colleague accepts once; their task then starts after
  yours, as them, with their own connections. Only the result goes on, and at most three tasks in a row
  pass work along. **Teamwork** on the Cowork home sets this up for several people at once from one
  description ("When my supplier mails are done, Ben checks the invoices. Questions go to purchasing:
  Ben, or Lena when he is away."). It only proposes: a colleague's task joins when they accept it.
- **Save as template / Export as file**: a template lets colleagues start from your task under **Start
  from a template**. The file is signed and can be added on another Bee Flow: the signature is checked,
  what its steps may do is worked out again, and the new task starts paused, waiting for approval.
- **Give this task away**: a colleague becomes its owner and approves its steps again before it runs
  as them.

### History

- **Runs**: every run, with what it did in plain words.
- **Changes**: every change to the task, with **Restore** for an earlier version of its steps.
- **Proof of each run**: every finished run leaves a receipt of which steps it ran, what it was allowed
  to do, who approved it and what it did, in names and counts, never what it read or wrote. Receipts are
  signed and chained, so a missing or changed one shows; you can download the chain for an audit.
- **Delete this task** is at the very bottom.

## Cowork preferences

Everything about you, for all your tasks:

- **E-mail me each morning what needs me**.
- **Suggest a task when I repeat a question**: when you ask the same kind of thing in chat on the same
  weekday four weeks in a row, Cowork offers once to do it for you. It keeps only which apps a chat used
  and on which weekday, never what you asked; switching it off forgets it all.

## For administrators

**Admin rules** on the Cowork home holds what applies to every task of the organisation:

- **Read-only mode**: tasks read and write drafts, but change and send nothing, until you switch it off.
- **Automatic fixes**: Cowork repairs a broken step by itself when the fix needs no new permission. The
  owner sees it and can undo it.
- **Apps tasks may use without asking**: an app that is off here is left out of every run nobody watches.
- **Monthly spending limit** for all tasks together: everyone sees a notice from 80%, and at 100% new
  runs are refused until you raise it or the month ends.
- **Allow "Suggest a task when I repeat a question"**: switch it off to stop it for everyone. Each person
  still has to turn it on, and you never see what it noticed.
- **Proof of each run**: check that no receipt of any task was changed or removed, and export the audit
  file.

How much a task may do without asking, and the trail of every change to a task (without what the work
says), are under **Security → Privacy Shield → Processing**.

## Privacy

A task runs as its owner and reaches only what its owner connected. What it sends without a send step
reaches its owner alone. The Privacy Shield is on for prompt runs. The morning e-mail goes only to the
owner, and the trail records who changed what, never the content of the work.
