// @typecheck strict
'use strict';
// Put the screens in a new order (builderTools/structureTools.mts).
module.exports = {
    name: 'app_reorder_screens',
    since: 3,
    description: 'Put the app\'s screens in a new order (the order of the menu when it has no groups). screenIds lists EVERY screen id exactly once, in the new order; a refusal gives the current order. The home screen stays the home screen. A grouped menu keeps its own order per group (app_set_nav_groups).',
    schema: {
        type: 'object',
        properties: { screenIds: { type: 'array', items: { type: 'string' }, description: 'Every scr_… id of the app, in the new order.' } },
        required: ['screenIds'],
    },
    apply: (/** @type {Parameters<typeof import('../structureTools.mts').applyReorderScreens>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../structureTools.mts').applyReorderScreens(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_reorder_screens', en: 'Reordered the screens' },
};
