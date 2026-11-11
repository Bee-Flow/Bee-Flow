// @typecheck strict
'use strict';
// definition.triggers (schema 3), kind "record": add or replace one record trigger. The same logic
// as app_set_trigger (../triggerTools.mts); this tool only names the fields of the record kind
// (triggers/kinds/record.mts), so the model reads them in a schema.
const { RECORD_TRIGGER_WRITES } = require('../../triggers/recordFiresText');

module.exports = {
    name: 'app_set_record_trigger',
    since: 3,
    description: 'Add a record trigger to the app, or replace the one with the same id: it starts one action on the server when a row of a table is created, updated or deleted, with nobody at the page. '
        + 'tableId is a table of the app itself (not one linked to a Studio table); on lists the events. fields narrows "update" to changes of those fields; when is a formula that must be true. '
        + 'The action reads the change under trigger.record (trigger.kind is "record"): trigger.record.event ("create" | "update" | "delete"), trigger.record.tableId, trigger.record.id (the row id), '
        + 'trigger.record.row (the row after the change; for a delete the row as it was), trigger.record.before (the row before an update or delete, else null), trigger.record.changed (the changed fields of an update), '
        + 'trigger.record.by ("member", "owner", "public" or "trigger"; never a name) and trigger.record.depth. '
        + RECORD_TRIGGER_WRITES
        + 'If visitors of a public page can write the table (the public role may create, update or delete in it), pass allowPublicWrites: true; the action may then hold no send_email, run_automation, request_approval, delete_record or http_request step. '
        + 'Loops end by themselves: a trigger never fires on a row its own run wrote, and a chain of trigger runs stops after 3. Runs come one at a time per trigger, in the order of the changes. '
        + 'The action must exist (app_set_action first) and may hold only steps that run unattended; a refused call names the step. '
        + 'This changes the draft only: the trigger runs once a person PUBLISHES the app, as the app owner (role owner, with the owner\'s access to every row). Say so to the user. '
        + 'Remove one with app_remove_trigger. Returns the trigger as stored and the ids of all triggers.',
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The trigger id (a letter, then letters, digits, _ or -, at most 40). Pass an existing id to replace that trigger; leave it out for a new one.' },
            actionId: { type: 'string', description: 'The action the trigger starts.' },
            tableId: { type: 'string', description: 'The id of the table whose rows are watched.' },
            on: { type: 'array', items: { type: 'string', enum: ['create', 'update', 'delete'] }, description: 'The events that start the action. At least one.' },
            fields: { type: 'array', items: { type: 'string' }, description: 'Optional, for "update": start only when one of these fields changed value.' },
            when: { type: 'string', description: 'Optional formula over the trigger root (and now, today) that must be true, e.g. trigger.record.row.status == "done" && trigger.record.before.status != "done".' },
            allowPublicWrites: { type: 'boolean', description: 'true lets a write by a visitor of a public page, or into a table such visitors can write, start the action. Leave out otherwise.' },
            enabled: { type: 'boolean', description: 'false keeps the trigger in the app without arming it at a publish. Leave out for a trigger that is on.' },
        },
        required: ['actionId', 'tableId', 'on'],
    },
    apply: (/** @type {{ def: Record<string, unknown> }} */ draftWrap, /** @type {Record<string, unknown>} */ args) => require('../triggerTools.mts').applySetTrigger(draftWrap, { ...args, kind: 'record' }),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_h4.act_set_record_trigger', en: 'Set a record trigger' },
};
