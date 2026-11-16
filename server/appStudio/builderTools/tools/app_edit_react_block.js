// @typecheck strict
'use strict';

module.exports = {
    name: 'app_edit_react_block',
    since: 3,
    description: 'Write the content of a react_block: its TSX source (one file with a default export), stylesheet, inputs and events. '
        + 'Use a react_block only for interactivity with its own state that the catalogue and custom_block cannot draw (a simulator, an interactive chart), never for data entry. '
        + 'Read the entry componentTypes react_block with app_inspect_catalog first. '
        + 'The component receives each input as a prop by name plus emit(event, value); it runs in a sealed frame without network, storage or navigation. '
        + 'Each key you pass replaces the stored one and null removes it; keys you leave out stay as they are. sourceEdits change the source by exact find/replace pairs instead of sending it whole. '
        + 'Every save compiles the source: the answer has compiled (true/false), compileError and diagnostics (line, column, text). Fix them and save again until compiled is true; a block that does not compile draws nothing.',
    schema: {
        type: 'object',
        properties: {
            nodeId: { type: 'string', description: 'The id of the react_block node.' },
            source: { type: ['string', 'null'], description: 'The whole TSX file. Imports only react, react/jsx-runtime, react-dom, react-dom/client. Default export: the component.' },
            sourceEdits: {
                type: 'array',
                description: 'Exact find/replace pairs on the stored source, applied in order; each find must occur exactly once. Not together with source.',
                items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] },
            },
            css: { type: ['string', 'null'], description: 'The stylesheet of this block alone. url() only with data:image/…; the app look is in --bf-* variables.' },
            inputs: { type: ['object', 'null'], description: 'name → binding (as on any component prop: { kind: "records", tableId }, { kind: "formula", expr }, { kind: "static", value }, …): the props the component receives. At most 20; not emit, children, key or ref.' },
            events: { type: ['object', 'null'], description: 'event name → action id (or null: not wired yet), for emit(name, value). At most 10; any other event is ignored.' },
        },
        required: ['nodeId'],
    },
    /**
     * @param {{ def: Record<string, unknown> }} draftWrap
     * @param {Record<string, unknown>} args
     */
    apply: (draftWrap, args) => require('../appEditReactBlock.mts').apply(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_react_block.act_edit_react_block', en: 'Edited the React block' },
};
