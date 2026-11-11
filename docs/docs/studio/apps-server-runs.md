---
title: Server runs and triggers in apps
---

# Server runs and triggers in apps

Most actions run when a person clicks. This page covers actions that run on the server: one that
keeps going when the page closes or waits for days, and one that starts by itself, with nobody at
the page, on a schedule, when a row changes or when another system calls the app. The basics of
background actions are in [App Studio](./apps.md#long-running-actions).

## Run an action on the server

An action runs on the server in two ways, both set on the action:

- **Run the whole action on the server** (`runOn: "server"`). The page sends one request and
  waits for the result. The action finishes even when the connection drops halfway. Messages and
  refreshes show when it ends.
- **Keep running when the page is closed** (`background: true`). The page does not wait: it shows
  progress and, when you come back, the result.

Only steps that need no page may be in either: no navigate, open a link, dialogs, reset a form or
download, and a confirmation only as the first step. A public page and the phone app walk the
steps themselves, as if the option were off.

### Wait

The **Wait** step pauses the action.

- In the browser a wait lasts 1 to 30 seconds. The person can keep using the screen meanwhile, and
  leaving the app ends the wait and the rest of the action.
- In a run on the server a wait can last up to 30 days (`seconds`, at most 2,592,000), or until a
  moment you give (`until`, a formula such as `vars.remindAt`). The run is put **on hold** and
  goes on by itself at that time. Nobody has to keep the page open.
- Give exactly one of `seconds` and `until`. A wait does not fit inside a parallel branch or a
  mailbox hook. A test run (`app_run_action`, a saved test) skips it.

### Wait for an approval

The **Wait for approval** step (`await_approval`) asks for an approval and goes on with the
decision. It makes the same request as the *Request approval* step, with the same fields (a prompt, details, questions for
the approver, who decides, stages, reminders, attachments), and the same deciders use the Approvals
inbox. The result holds the decision (it can be `expired` or `cancelled` as well as approved or
rejected), the reason and the answers to the questions.

- `timeoutHours` (1 to 720) closes the request after that long and the step goes on with `expired`.
- A request that is withdrawn gives `cancelled`. Cancelling the run withdraws its open request.
- It only works in a run on the server. Not on a public page, from a mailbox hook, or inside a
  parallel branch. In a test run nobody is asked: the step goes on as approved, and a mock can
  give another decision.

### Runs on hold and cancelling

A run that waits shows as **On hold** with what it waits for: a time, an approval, or to be
continued. You can close the page. The run goes on by itself when the time comes or the decision
lands.

A run can be **cancelled** with **Cancel run** in the run log or on the page's progress tray, by the
person who started it or the app owner. A run on hold ends as cancelled at once. A running one
stops before its next step. Steps that already ran are not undone.

A run on hold survives a server restart: it is kept in the database and goes on at its time, or
when its decision lands, as if nothing happened. A run that was running when the server restarts
ends as interrupted and does not continue, because its steps may already have written rows or
sent mail.

On self-hosted, the limits are environment variables (`STUDIO_APP_PAUSE_MAX_MS`,
`STUDIO_APP_PAUSED_PER_APP`, `STUDIO_APP_PAUSE_STATE_MAX_BYTES` and the wake job settings; see
`server/.env.example`). `0` means unlimited where the variable says so.

## Triggers

A **trigger** starts an action on the server by itself. Add triggers in the Logic tab, or ask the
AI builder to set one. There are three kinds, at most 20 per app. Each names the action it runs.

A trigger only runs once the app is **published**. In a draft it does nothing, and a change to a
trigger goes live with the next publish. The panel says when a trigger is not armed yet, or when
the published app still runs the old one. A trigger can be switched off without removing it.

The action a trigger starts reads what started it as `trigger.kind` (`record` or `webhook`; a
schedule run has no `trigger` value) and the details under `trigger.record` or `trigger.webhook`.

### Runs as the owner

**An action started by a trigger runs as the owner of the app, whoever or whatever caused it.** Nobody is at
the page, so it has no visitor and no role of its own. It reads and writes everything the owner can, sends e-mail from the mailbox the owner connected, starts the owner's
automations and files approvals in the owner's name. In a row rule or formula, `viewer.*` is the owner.

Because of that:

- Only the owner can publish a trigger, and a draft arms nothing.
- Whoever changed the row, or called the webhook, gets none of the owner's rights. They only decide when the owner's steps run.
- Each time a trigger fires, the server checks again that the app is still published, that it still belongs to
  the same active account, that the owner still has App Studio, and that the trigger is exactly what was published. If not, it does not run.
- Every step still applies its own checks: row access for the owner, the AI budget, the daily limit of the mailbox, and the privacy check on anything that leaves Bee Flow. Personal data still leaves Bee Flow only by e-mail.

### What the action may hold

Because nobody is at the page, the action and every action it calls may hold only steps that run
unattended: set a variable, condition, switch, loop, while, try, parallel, run another action,
return, raise error, add, change or delete a row, all or nothing, dataset query, the AI steps and
knowledge-base query, run code, the document and file steps, read a document, send e-mail (never in a loop), run an automation,
request an approval, wait, wait for approval, and call a web service (through a REST connector,
not in a webhook run).

These are refused, and saving the app names the step in the way: navigate, open a link, dialogs,
confirm, toast, refresh, reset a form, download a file, focus, scroll, clipboard, form and
interface steps, AI browsing, copy a document and the knowledge-base log steps. If a button also
runs the action, keep the page steps in the button's action and let it run the shared part with
*Run another action*.

### On a schedule

A schedule runs an action at set times. Give either:

- **At set times**: five fields (minute, hour, day of month, month, day of week), for example
  `0 8 * * 1-5` for weekdays at 08:00, with the **time zone** they are read in (required with
  a cron); or
- **Every … minutes**: a fixed interval.

The panel shows whether the trigger is armed, the last run and its outcome, and the next run. The
shortest time between two runs of one trigger is 60 seconds by default
(`STUDIO_APP_TRIGGER_MIN_INTERVAL_SECONDS`).

### When a record changes

A **record trigger** runs an action when a row of a table is added, changed or deleted. You choose
the table, the events (added, changed, deleted), optionally that only some fields changed, and
optionally an *Only if* formula over `trigger.record`.

The action reads `trigger.record.event`, `.tableId`, `.id`, `.row` (for a delete the row as it was), `.before`, `.changed`,
`.by` (`member`, `owner`, `public`, `trigger` or `webhook`) and `.depth`.

**What starts one.** Every row that a person changes in the app, one change per row:

- an edit in a grid or a form;
- an add, change or delete step, whether it works on one row by id or on all rows matching a filter;
- the add, change and delete steps by id inside *All or nothing*, once the whole step is saved (if
  it is rolled back, nothing starts);
- the rows that *Read a document* and a *Query a dataset* write-back write, also when they update
  or add by key or replace rows (the replaced rows count as deleted);
- a delete that follows a delete rule onto related records: each related row that is deleted with
  it counts as deleted, and each one whose link is emptied counts as changed.

The same steps in the action of another trigger start one too.

**What does not start one:**

- rows the AI builder writes, whether through the builder tools or over MCP, and test runs
  (`app_seed_records`, `app_update_records`, `app_run_action`, `app_run_tests`);
- imports, template installs and connector sync;
- the mailbox hook (and every step of the action it runs) and file intake;
- a change or delete step with a filter inside *All or nothing*: the rows are chosen while the step
  is being saved, so they cannot be recorded one by one;
- the log row of a sent e-mail and an approval's own record update;
- a table linked to a Studio datatable, which cannot be a trigger table at all.

**Many rows at once.** A step that changes 200 rows records 200 changes, and the trigger handles
them one at a time. The limits below decide how many runs that gives, and what is left over is
skipped and shown on the trigger. One write that is about to change more than 1,000 rows of tables
with a record trigger records none of them (`STUDIO_APP_RECORD_TRIGGER_MAX_ROWS_PER_WRITE`, 0 for no
limit), and the trigger shows *Skipped: too many rows in one write*: it never starts for only a part
of such a write. At most 1,000 changes of one app wait for their run
(`STUDIO_APP_RECORD_TRIGGER_MAX_PENDING`); changes beyond that are dropped. If someone else changes
the same rows while a write of several rows is being saved, that write records nothing and the
trigger says so.

**Visitors of a public page.** If visitors can write the table, a record trigger needs **Also start
on changes by visitors of a public page** (`allowPublicWrites`), and then its action may hold no
send e-mail, run an automation, request an approval, delete a row or call a web service step. Anyone who can reach the public page
can start that action. The table counts, not only the writer: a table strangers can write is treated this
way for every writer.

**Loops end by themselves.** A trigger never starts on a row its own run wrote. A chain of trigger
runs that start each other stops after 3 (`STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH`). One writer starts
at most 30 runs of one app a minute (`STUDIO_APP_RECORD_TRIGGER_WRITER_BURST`); all visitors of a
public page count as one writer. The limit counts runs, so rows: a step that changes many rows
starts no more runs than this. Beyond a limit the change is skipped and the trigger shows why.

**A chain keeps the rules of what started it.** A run started by a visitor's write, or by a
trigger that allows visitor writes, writes as a visitor again, so the next trigger in the chain
needs the same permission and the same stricter step list. A run started by a webhook, and every run its
writes start, may not call a web service. A second trigger is never a way around these rules.

### When another system calls

A **webhook trigger** runs an action when another system sends a signed `POST` with a JSON body to the
trigger's address. The action reads `trigger.webhook.body` (the parsed JSON), `.headers`,
`.deliveryId` and `.receivedAt`.

The address and the signing secret are made when the app is published. They are not part of the
app. The owner sees them in the trigger's panel: the secret is shown once (**Show the secret
(once)**, then **I saved it, hide it**) and after that only a new one can be made (**Make a new
secret**). The old secret keeps working for a short while (one hour by default,
`STUDIO_APP_WEBHOOK_ROTATION_OVERLAP_SECONDS`), so you can move the sender over.

**How the other system signs a delivery.** Send a `POST` with a JSON body of at most 64 KB
(`STUDIO_APP_WEBHOOK_BODY_MAX_BYTES`, 65,536 bytes by default). Sign the delivery id, a line break, the time in
seconds, a line break and the body, exactly as sent, with HMAC-SHA256 and the secret. The time may
be at most 300 seconds off (`STUDIO_APP_WEBHOOK_TOLERANCE_SECONDS`), and a delivery id is accepted once: sending the same
delivery again starts nothing. The panel shows the example with your address:

```sh
SECRET='<secret>'
BODY='{"hello":"world"}'
TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
SIG=$(printf '%s\n%s\n%s' "$NONCE" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST '<address of the trigger>' \
  -H 'Content-Type: application/json' \
  -H "X-BeeFlow-Timestamp: $TS" \
  -H "X-BeeFlow-Nonce: $NONCE" \
  -H "X-BeeFlow-Signature: sha256=$SIG" \
  --data "$BODY"
```

The nonce is the delivery id. The panel lists the last deliveries and what became of each:
accepted, refused because the signature did not fit, because the timestamp was too far from
now, because there were too many deliveries in a minute (120 a minute per trigger by default),
because the trigger was not armed, or because the body was not usable JSON; sent again (nothing
started); and not started because a run was still going.

Treat the body like a form a stranger filled in: it is untrusted input, so check what you use. What
the other system puts in a delivery is its choice. The run keeps it like any other value of a run,
and it leaves Bee Flow only the way a run may send things: by e-mail.

### Failing triggers

A trigger whose runs keep failing is paused and says why in the panel. By default it pauses after 5
failed runs in a row (`STUDIO_APP_TRIGGER_MAX_FAILURES`, 0 = never), and waits longer after each
failure before trying again. Fix the action, then switch the trigger on again. One app can have 5
trigger runs going at once and start 120 an hour by default (`STUDIO_APP_TRIGGER_RUNS_PER_APP`,
`STUDIO_APP_TRIGGER_FIRES_PER_HOUR`).

### Testing a trigger's action

Test the action of a record or webhook trigger with `app_run_action` and a `scope.trigger` that has the shape a real run reads, for example
`{ trigger: { kind: "record", record: { event, row, before, changed } } }`. A test never starts a
trigger.

Runs started by a trigger appear in the run log with what started them (for example *Row added in
Orders*, *by a visitor*, *by another trigger*). **Only runs a trigger started** filters the list.
