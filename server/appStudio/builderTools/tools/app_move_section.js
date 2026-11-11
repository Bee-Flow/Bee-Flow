// @typecheck strict
'use strict';
// Move a section among the sections of its screen (builderTools/structureTools.mts).
module.exports = {
    name: 'app_move_section',
    since: 3,
    description: 'Move a section to another place among the sections of its own screen, components included. index counts the sections without the one that moves: 0 puts it at the top, a number past the end puts it last. Returns the new order of the screen\'s section ids.',
    schema: {
        type: 'object',
        properties: {
            sectionId: { type: 'string', description: 'The sec_… id of the section.' },
            index: { type: 'integer', minimum: 0, description: 'The new place, 0 = top.' },
        },
        required: ['sectionId', 'index'],
    },
    apply: (/** @type {Parameters<typeof import('../structureTools.mts').applyMoveSection>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../structureTools.mts').applyMoveSection(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_move_section', en: 'Moved a section' },
};
