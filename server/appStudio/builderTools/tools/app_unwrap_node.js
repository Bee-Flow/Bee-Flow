// @typecheck strict
'use strict';
// Take a card or container away and keep its children in its place (builderTools/wrapTools.mts).
module.exports = {
    name: 'app_unwrap_node',
    since: 3,
    description: 'Remove a card, container or pane but keep its children: they take its place in its parent, in their order, with their ids, wiring and spans. The counterpart of app_wrap_nodes, for a box that only adds a frame. A form, tab, modal or repeater is refused (its children depend on it). Returns the ids of the children that moved up.',
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The cmp_… id of the card, container or pane.' },
        },
        required: ['id'],
    },
    apply: (/** @type {Parameters<typeof import('../wrapTools.mts').applyUnwrapNode>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../wrapTools.mts').applyUnwrapNode(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_unwrap_node', en: 'Ungrouped components' },
};
