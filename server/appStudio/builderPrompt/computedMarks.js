// @typecheck strict
/**
 * The marks a computed field carries in the data block (builderPrompt.js
 * renderDataField): `(read-only)` everywhere, and for app_get_data_model only
 * (withId) how it is kept and what it computes. The per-turn block (no ids)
 * stays byte-identical, because the prompt cache keys on it.
 */

'use strict';

const { readTimeComputedError } = require('../../core/dataEngine/queryCompilerComputed.mts');

/**
 * @typedef {{ key?: string, type?: string, computed?: { stored?: boolean, type?: string, expr?: string } | null }} DataField
 */

/**
 * How a computed field is kept. A read-time one says whether the record reads
 * evaluate it (queryCompilerComputed.mts), and why not when they do not.
 * @param {{ stored?: boolean, expr?: string }} c
 * @param {DataField} f
 * @param {DataField[]} tableFields  the fields of its table
 */
function keptAs(c, f, tableFields) {
    if (c.stored === true) return 'stored';
    const refused = readTimeComputedError(f, { fields: tableFields });
    return refused ? `read-time (not evaluated, reads empty: ${refused})` : 'read-time (evaluated on read, not filterable or sortable)';
}

/**
 * @param {DataField} f
 * @param {boolean} withId
 * @param {DataField[]} [tableFields]  the fields of the table `f` belongs to
 * @returns {string[]}
 */
function computedBits(f, withId, tableFields = []) {
    if (f.type !== 'computed') return [];
    const c = f.computed;
    if (!withId || !c || typeof c !== 'object') return ['(read-only)'];
    const out = ['(read-only)', keptAs(c, f, tableFields)];
    if (typeof c.type === 'string' && c.type) out.push(`returns=${c.type}`);
    if (typeof c.expr === 'string') out.push(`expr=${JSON.stringify(c.expr)}`);
    return out;
}

/**
 * A field's rules (validation, dynamicDefault, format, display), on app_get_data_model only and
 * only when declared. Kept here next to the computed marks so builderPrompt.js stays small.
 * @param {Record<string, unknown>} f
 * @returns {string[]}
 */
function fieldRuleBits(f) {
    return [
        f.validation && typeof f.validation === 'object' ? `validation=${JSON.stringify(f.validation)}` : '',
        typeof f.dynamicDefault === 'string' ? `dynamicDefault=${f.dynamicDefault}` : '',
        typeof f.format === 'string' ? `format=${f.format}` : '',
        f.display && typeof f.display === 'object' ? `display=${JSON.stringify(f.display)}` : '',
    ].filter(Boolean);
}

module.exports = { computedBits, fieldRuleBits };
