// @typecheck strict
'use strict';

module.exports = {
    name: 'app_edit_block',
    since: 3,
    description: 'Write the content of a custom_block: its HTML template, stylesheet, inputs and events. '
        + 'A block holds no script: the template is HTML from a closed list of elements with {{ formula }}, data-if and data-each in it, '
        + 'and a formula sees only the inputs you declare. Read the entry componentTypes custom_block with app_inspect_catalog first. '
        + 'Each key you pass replaces the stored one and null removes it; keys you leave out stay as they are. '
        + 'The answer echoes the block as stored: _hints lists what was left out of the template and on which line, '
        + 'problems lists what the template still needs (an undeclared input, an unwired event, a formula that does not parse).',
    schema: {
        type: 'object',
        properties: {
            nodeId: { type: 'string', description: 'The id of the custom_block node.' },
            template: { type: ['string', 'null'], description: 'The HTML template. No script, style, link, iframe, img, form or input element, no on* attribute, no href or src.' },
            css: { type: ['string', 'null'], description: 'The stylesheet of this block alone. url() only with data:image/…; the app look is in --bf-* variables.' },
            inputs: { type: ['object', 'null'], description: 'name → binding (as on any component prop: { kind: "records", tableId }, { kind: "formula", expr }, { kind: "static", value }, …): the values the template\'s formulas read. At most 20.' },
            events: { type: ['object', 'null'], description: 'event name → action id (or null: not wired yet), for <button data-emit="name">. At most 10.' },
        },
        required: ['nodeId'],
    },
    /**
     * @param {{ def: Record<string, unknown> }} draftWrap
     * @param {Record<string, unknown>} args
     */
    apply: (draftWrap, args) => require('../appEditBlock.mts').apply(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_block.act_edit_block', en: 'Edited the custom block' },
};
