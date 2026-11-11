// @typecheck strict
/**
 * App Studio catalog: the item template of a `list` and a `kanban` (schema 3, package LK20).
 *
 * Both types became slot containers after the base: their `children` are an optional template,
 * ordinary nodes drawn once per row (a list row, a kanban card) with `item` and `index` in scope,
 * the way a repeater draws its children. `childrenSince` is the mark: a node of the type that
 * holds children needs schema version 3 (schemaSince.mts), the AI builder's base catalogue still
 * shows the type as it was (catalogTiers.mts), and the extension index lists `<type>.children`.
 * As a slot container the canonical form writes `children` only when there are some, so every
 * list and kanban stored before keeps its bytes.
 */

'use strict';

/**
 * The spec fields that make `type` an item-template host.
 * @param {'list' | 'kanban'} type
 */
function itemTemplateHost(type) {
    const row = type === 'kanban' ? 'card' : 'row';
    return {
        container: true,
        slotContainer: true,
        childrenSince: 3,
        childrenDescription: `Child components drawn per ${row} in place of the built-in ${row} body. `
            + `Inside them item is the ${row}'s record and index its position, as in a repeater: bind with computed or formulas such as item.title. `
            + `The ${row} keeps its click${type === 'kanban' ? ' and drag' : ''} behaviour, so keep buttons out of a clickable ${row}. `
            + 'No children means the built-in body (titleKey and the other keys). The phone draws the built-in body.',
    };
}

/** The longest column template: a formula, so the formula ceiling. */
const MAX_COLUMN_TEMPLATE_LEN = 500;

/** The `template` key of a table or data_grid column (schema 3): what a `format: 'template'` column writes. */
function columnTemplateSpec() {
    return {
        type: 'string', maxLen: MAX_COLUMN_TEMPLATE_LEN, since: 3,
        description: 'For format template: a formula whose result is the cell text. '
            + 'item is the row and value the cell\'s own value, e.g. item.first + " " + item.last or concat(item.city, ", ", item.country). '
            + 'The result is plain text, never markup. Sorting and filtering still use the value under key.',
    };
}

module.exports = { itemTemplateHost, columnTemplateSpec, MAX_COLUMN_TEMPLATE_LEN };
