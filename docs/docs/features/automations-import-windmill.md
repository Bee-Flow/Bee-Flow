---
title: Import from Windmill
description: Convert Windmill flows into inactive Bee Flow automation drafts with a migration report, finish the open parts with the AI builder, and switch them on after a dry run.
---

# Import from Windmill

Bee Flow can convert flows built in [Windmill](https://www.windmill.dev/) (including the Windmill
that runs inside Nextcloud as the Flow app) into [automations](automations.md). Each flow becomes an
**inactive draft** with a **migration report**: what was converted, what still needs work, and what
to check before you switch it on.

This is an **Enterprise** feature (`automation_import`). Building automations yourself, and importing
a Bee Flow JSON export, stay available on every plan.

Open **Studio → Automations** and click the wind icon next to the import button.

## Where the flows come from

| Source | What you give | What is read |
|--------|---------------|--------------|
| **Upload an export** | A zip of a `wmill sync pull` folder, or one flow as JSON or YAML | Flows, the scripts they call, schedules and triggers (when the export has them) |
| **Read from a Windmill** | The https:// address, the workspace id and a read-only token | The workspace archive (secrets skipped), or the flows one by one when the instance does not offer it |

For a complete export, run:

```bash
wmill sync pull --include-schedules --include-triggers --skip-resources
```

and zip the folder. Without `--include-schedules` and `--include-triggers` the export has no
schedules or triggers, and the drafts start as manual until you pick a trigger.

For **Read from a Windmill**, create a token in Windmill that is read only, limited to one workspace
and short-lived. Bee Flow uses it for that one request: it is never stored, never logged and never
shown back. The Windmill must be reachable from the Bee Flow server over https on a public address;
otherwise upload the export instead.

In a Nextcloud organisation the dialog can also show **Found in this Nextcloud**: the Windmill flows
that listen to this Nextcloud, read by the connector without any Windmill credential. Use it to see
what there is to convert and, after the import, which Windmill triggers to switch off.

## Preview, then import

The preview converts everything without writing anything. Per flow you see:

- how many steps were converted, and how many are left for the AI builder or for you;
- a confidence: **high** (everything mapped), **medium** (a script runs as a code step, or an id
  has to be picked again), **needs work** (open items) or **not convertible as is**;
- the hosts the flow sends data to, so you can check them against your rules for outbound data;
- the connections to choose (no secret is ever carried over: a Windmill resource or variable becomes
  a connection you pick in Bee Flow);
- the things to read before switching it on, such as the change of identity (see below) and the
  reminder to switch the flow off in Windmill.

Select the flows you want and click **Import**. Each selected flow becomes its own inactive draft; a
flow that cannot be imported is reported and the rest go on.

## Complete with AI

A flow with open items (a script in a language Bee Flow does not run, a pattern the converter does
not know) gets a **placeholder step** on the canvas for each one, plus a checklist item in the report.
**Complete with AI** opens the [AI automation builder](automations.md) on that draft with a briefing
in the input box: the open items, the read-only source of each (with secrets removed) and what to do.
You read it and send it yourself.

The briefing goes to your organisation's own AI model, through the builder's usual gates. The
builder replaces the placeholders, runs a dry run and finalises the draft. It never switches an
automation on.

## Switching an imported automation on

An imported draft can only be switched on when:

1. every checklist item is **resolved** (the placeholder was replaced, or the step it pointed at was
   finished) or **marked as handled** by you in the report; and
2. a **dry run of the current version** finished without errors. Any change after that dry run asks
   for a new one.

Once it has been switched on, these checks are done for good.

**Switch the flow off in Windmill** once the automation runs in Bee Flow: otherwise every event runs
twice. For a flow on the Nextcloud Flow app, remove its "listen to event" step or archive the flow;
for a native Nextcloud trigger, disable the trigger; pause its schedules.

## What changes

- **Identity.** Windmill ran parts of a flow as the Nextcloud user who caused the event, or as an
  administrator. Bee Flow runs an automation with the connections of its owner, so what it may read
  and change follows the owner's rights.
- **Secrets.** None are imported. Pick the connections again in Bee Flow.
- **Code.** Code from the export is never run during the import. A plain TypeScript script may become
  a code step that runs in the isolated sandbox; Python, Bash and SQL become checklist items.
- **Run settings.** Concurrency, the time limit and the run-data retention are copied where Bee Flow
  has the same setting; the report lists the rest.

## Limits

The import has its own size and rate limits (`AUTOMATION_IMPORT_WINDMILL_*`), see
[environment variables](../self-hosting/env.md).
