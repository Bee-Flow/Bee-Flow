// @typecheck strict
'use strict';

// A hierarchical list (schema 3, package LK21b): the rows of `source` nested by a parent field
// (a self-relation, or any field holding the id of the parent row). The rows come through the
// normal data read, so the viewer's roles and row rules decide what is there; maxDepth and
// maxNodes bound what is drawn.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base list types only; a tree stays in the browser.' },
    parts: ['root', 'item', 'row', 'toggle', 'icon', 'title', 'subtitle', 'group', 'more'],
    label: 'Tree', category: 'Data',
    description: 'Rows nested under their parent row, with expand and collapse. '
        + 'parentKey names the field that holds the id of the parent row (a relation to the same table, or a plain id field); a row without one, or whose parent is not among the rows, is a top-level item. '
        + 'The top level starts expanded. onRowClick fires with the clicked row.',
    events: ['onRowClick'],
    props: {
        source: { type: 'binding', default: { kind: 'static', value: [] } },
        idKey: { type: 'string', maxLen: 120, default: 'id' },
        parentKey: { type: 'string', required: true, maxLen: 120, default: 'parent' },
        titleKey: { type: 'string', maxLen: 120, default: 'title' },
        subtitleKey: { type: 'string', maxLen: 120, default: null },
        icon: { type: 'icon', default: null },
        maxDepth: { type: 'int', min: 1, max: 10, default: 6, description: 'Levels drawn. Deeper rows are counted under their ancestor, not drawn.' },
        maxNodes: { type: 'int', min: 1, max: 1000, default: 500, description: 'Items drawn at most. The rest is counted in a line at the end.' },
        emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
    },
    styleKnobs: ['span', 'size', 'height'],
    defaultStyle: { span: 12 },
};
