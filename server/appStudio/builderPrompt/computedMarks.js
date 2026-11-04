// @typecheck strict
/**
 * The marks a computed field carries in the data block (builderPrompt.js
 * renderDataField): `(read-only)` everywhere, and for app_get_data_model only
 * (withId) how it is kept and what it computes. The per-turn block (no ids)
 * stays byte-identical, because the prompt cache keys on it.
 */

'use strict';

/**
 * @param {{ type?: string, computed?: { stored?: boolean, type?: string, expr?: string } | null }} f
 * @param {boolean} withId
 * @returns {string[]}
 */
function computedBits(f, withId) {
    if (f.type !== 'computed') return [];
    const c = f.computed;
    if (!withId || !c || typeof c !== 'object') return ['(read-only)'];
    const out = ['(read-only)', c.stored === true ? 'stored' : 'read-time (not evaluated)'];
    if (typeof c.type === 'string' && c.type) out.push(`returns=${c.type}`);
    if (typeof c.expr === 'string') out.push(`expr=${JSON.stringify(c.expr)}`);
    return out;
}

module.exports = { computedBits };
