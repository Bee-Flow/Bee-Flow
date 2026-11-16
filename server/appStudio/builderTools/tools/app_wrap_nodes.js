// @typecheck strict
'use strict';
// Put components that share a parent into one new card or container (builderTools/wrapTools.mts).
module.exports = {
    name: 'app_wrap_nodes',
    since: 3,
    description: 'Group components that sit side by side under one parent into ONE new card (default) or container, placed where the first of them was. Their ids, wiring and props stay; they keep their order and their spans, now on the box\'s own 12-column grid. One call instead of a new card plus an app_move_node per component: the way to regroup a screen by task. The ids must share a parent (move a stray one there first with app_move_node). Returns the new box\'s id as containerId; give it a title here or later with app_update_component.',
    schema: {
        type: 'object',
        properties: {
            ids: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'The cmp_… ids to group, all under the same section or container.' },
            type: { type: 'string', enum: ['card', 'container'], description: 'card = a visible surface with an optional title (default); container = a grouping without chrome.' },
            props: {
                type: 'object',
                description: 'Props of the new box: title and description (card), look (card or container, values from the catalog).',
                properties: { title: { type: 'string' }, description: { type: 'string' }, look: { type: 'string' } },
            },
            style: { type: 'object', description: 'Style of the new box; span 1-12 in its parent (12 when absent).', properties: { span: { type: 'integer', minimum: 1, maximum: 12 } } },
        },
        required: ['ids'],
    },
    apply: (/** @type {Parameters<typeof import('../wrapTools.mts').applyWrapNodes>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../wrapTools.mts').applyWrapNodes(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_wrap_nodes', en: 'Grouped components' },
};
