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
 * How a computed field is kept. A read-time one says whether the record reads
 * evaluate it (queryCompilerComputed.mts), and why not when they do not.
 * @param {{ stored?: boolean, expr?: string }} c
 * @param {any} f
 * @param {unknown[]} tableFields  the other fields of its table
 */
function keptAs(c, f, tableFields) {
    if (c.stored === true) return 'stored';
    const refused = readTimeComputedError(f, { fields: /** @type {any} */ (tableFields) });
    return refused ? `read-time (not evaluated, reads empty: ${refused})` : 'read-time (evaluated on read, not filterable or sortable)';
}

/**
 * @param {{ type?: string, computed?: { stored?: boolean, type?: string, expr?: string } | null }} f
 * @param {boolean} withId
 * @param {unknown[]} [tableFields]  the fields of the table `f` belongs to
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

module.exports = { computedBits };
