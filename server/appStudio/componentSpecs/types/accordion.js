'use strict';

// Collapsible sections (schema 3). Child i is the body of items[i]; a child is an ordinary
// node (usually a container). Modelled on tabs, but the headers sit above their own body.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base layout types only; an accordion stays in the browser.' },
    parts: ['root', 'item', 'header', 'title', 'icon', 'panel'],
    label: 'Accordion', category: 'Layout',
    description: 'Collapsible sections. Child number i is the body of item number i.',
    container: true,
    slotContainer: true,
    props: {
        items: {
            type: 'list', maxItems: 30, default: [{ title: 'Section 1' }, { title: 'Section 2' }],
            itemShape: {
                title: { type: 'string', required: true, maxLen: 120 },
                open: { type: 'boolean', description: 'Open when the page loads. When no item says, the first one is open.' },
            },
        },
        multiple: { type: 'boolean', default: false, description: 'true lets several items stay open at once.' },
    },
    styleKnobs: ['span', 'gap', 'padding'],
    defaultStyle: { span: 12, gap: 3, padding: 0 },
};
