// @typecheck strict
'use strict';
// Remove a section with its components (builderTools/structureTools.mts).
module.exports = {
    name: 'app_remove_section',
    since: 3,
    description: 'Remove one section of a screen, with every component in it. A screen keeps at least one section (remove the screen with app_remove_screen instead). Returns removedComponents, and stillReferenced with a hint when an action, another component or an app setting still names a removed component: fix those next.',
    schema: {
        type: 'object',
        properties: { sectionId: { type: 'string', description: 'The sec_… id of the section (app_get_draft lists them).' } },
        required: ['sectionId'],
    },
    apply: (/** @type {Parameters<typeof import('../structureTools.mts').applyRemoveSection>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../structureTools.mts').applyRemoveSection(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_remove_section', en: 'Removed a section' },
};
