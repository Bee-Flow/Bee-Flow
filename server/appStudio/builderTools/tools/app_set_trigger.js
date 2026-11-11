// @typecheck strict
'use strict';
// definition.triggers (schema 3): add or replace one server trigger. Logic in ../triggerTools.mts.
module.exports = {
    name: 'app_set_trigger',
    since: 3,
    description: 'Add a trigger to the app, or replace the one with the same id: it starts one action on the server by itself, with nobody at the page. '
        + 'kind "schedule" (the default) runs actionId at set times: pass schedule { cron, tz } (five fields: minute hour day-of-month month day-of-week, e.g. "0 8 * * 1-5" with tz "Europe/Amsterdam") or schedule { everyMinutes }. '
        + 'The action must exist (app_set_action first) and may hold only steps that run unattended; a refused call names the step. '
        + 'Read the full rules with app_inspect_catalog {keys:["triggers"]}. '
        + 'This changes the draft only: the trigger runs once a person PUBLISHES the app, as the app owner. Say so to the user. '
        + 'Returns the trigger as stored and the ids of all triggers.',
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The trigger id (a letter, then letters, digits, _ or -, at most 40). Pass an existing id to replace that trigger; leave it out for a new one.' },
            kind: { type: 'string', description: 'The trigger kind. "schedule" when left out.' },
            actionId: { type: 'string', description: 'The action the trigger starts.' },
            schedule: {
                type: 'object',
                description: 'For kind "schedule": { cron, tz } or { everyMinutes }.',
                properties: {
                    cron: { type: 'string', description: 'Five fields: minute hour day-of-month month day-of-week. "0 8 * * 1-5" is weekdays at 08:00.' },
                    tz: { type: 'string', description: 'IANA time zone the cron is read in, e.g. "Europe/Amsterdam". Required with cron.' },
                    everyMinutes: { type: 'integer', description: 'A fixed interval in minutes (1 to 525600), instead of cron.' },
                },
            },
            enabled: { type: 'boolean', description: 'false keeps the trigger in the app without arming it at a publish. Leave out for a trigger that is on.' },
        },
        required: ['actionId'],
    },
    apply: (/** @type {{ def: Record<string, unknown> }} */ draftWrap, /** @type {Record<string, unknown>} */ args) => require('../triggerTools.mts').applySetTrigger(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_schedule.act_set_trigger', en: 'Set a trigger' },
};
