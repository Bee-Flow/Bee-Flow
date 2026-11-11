// @typecheck strict
'use strict';
// definition.triggers (schema 3): take one server trigger out. Logic in ../triggerTools.mts.
module.exports = {
    name: 'app_remove_trigger',
    since: 3,
    description: 'Remove a trigger from the app by its id (see app_get_draft or the result of app_set_trigger for the ids). '
        + 'This changes the draft only: a published app keeps running the trigger until a person publishes again. '
        + 'Returns the ids of the triggers that are left.',
    schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id of the trigger to remove.' } },
        required: ['id'],
    },
    apply: (/** @type {{ def: Record<string, unknown> }} */ draftWrap, /** @type {Record<string, unknown>} */ args) => require('../triggerTools.mts').applyRemoveTrigger(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_schedule.act_remove_trigger', en: 'Removed a trigger' },
};
