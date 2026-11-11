// @typecheck strict
// English GUI defaults — namespace "studio_apps_h4": every key whose part before the first "." is "studio_apps_h4".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_h4.json. App Studio record triggers (schema 3): their form in the Logic tab, what started a run
// in the run log, and the builder's verb for app_set_record_trigger.
module.exports = {
    "studio_apps_h4.act_set_record_trigger": "Set a record trigger",
    "studio_apps_h4.panel.add": "Add a record trigger",
    "studio_apps_h4.panel.allow_public": "Also start on changes by visitors of a public page",
    "studio_apps_h4.panel.allow_public_hint": "Anyone who can reach the public page can then start this action. It may not send e-mail, start an automation, ask for an approval or delete rows.",
    "studio_apps_h4.panel.desc": "A record trigger runs an action on the server when a row of a table is added, changed or deleted. It only runs once the app is published.",
    "studio_apps_h4.panel.event_create": "Added",
    "studio_apps_h4.panel.event_delete": "Deleted",
    "studio_apps_h4.panel.event_update": "Changed",
    "studio_apps_h4.panel.events": "Start when a row is",
    "studio_apps_h4.panel.fields": "Only when one of these fields changed",
    "studio_apps_h4.panel.fields_any": "Any field",
    "studio_apps_h4.panel.fires_on": "It starts on a change someone makes in the app (in a grid or a form, or through an add, update or delete step for one row) and on such a step of another trigger. It does not start on imports, connector sync, rows the AI builder writes, test runs, or steps that change many rows at once.",
    "studio_apps_h4.panel.loops": "A trigger never starts on a row its own run changed, and a chain of triggers that start each other stops after a few runs.",
    "studio_apps_h4.panel.no_tables": "Add a table to the app first: a record trigger watches one of its tables.",
    "studio_apps_h4.panel.runs_as": "It runs as the owner of this app, whoever changed the row: with the owner’s access to every row, the owner’s mailbox and the owner’s automations.",
    "studio_apps_h4.panel.table": "Table to watch",
    "studio_apps_h4.panel.table_missing": "{table} (no longer in the app)",
    "studio_apps_h4.panel.title": "When a record changes",
    "studio_apps_h4.panel.when": "Only if (formula)",
    "studio_apps_h4.panel.when_hint": "For example trigger.record.row.status == \"done\". Read the row as trigger.record.row, the row before the change as trigger.record.before, and the event as trigger.record.event.",
    "studio_apps_h4.runs.by_member": "by a member",
    "studio_apps_h4.runs.by_owner": "by the owner",
    "studio_apps_h4.runs.by_public": "by a visitor",
    "studio_apps_h4.runs.by_trigger": "by another trigger",
    "studio_apps_h4.runs.by_webhook": "by a run a webhook started",
    "studio_apps_h4.runs.event_create": "Row added",
    "studio_apps_h4.runs.event_delete": "Row deleted",
    "studio_apps_h4.runs.event_update": "Row changed",
    "studio_apps_h4.runs.started_by": "Started by: {event} in {table}, row {row}",
};
