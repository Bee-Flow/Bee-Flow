// @typecheck
'use strict';

/**
 * Key orders the key-order tests rebuild a definition in (appStudio/validate/keyOrder.test.js,
 * appStudio/canonicalize/keyOrder.test.js). Postgres JSONB hands a stored value back with its
 * object keys shorter first, then bytewise; `jsonb` is that order, `reversed` a second one.
 *
 *   rekey(value, order)  every object rebuilt with its keys in `order(keys)`; arrays keep theirs
 */

/** Rebuild every object with its keys in `order`; arrays keep their order. */
function rekey(value, order) {
    if (Array.isArray(value)) return value.map((v) => rekey(v, order));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(order(Object.keys(value)).map((k) => [k, rekey(value[k], order)]));
}

const reversed = (keys) => [...keys].sort().reverse();
// JSONB: shorter keys first, then bytewise.
const jsonb = (keys) => [...keys].sort((a, b) => (Buffer.byteLength(a) - Buffer.byteLength(b)) || Buffer.compare(Buffer.from(a), Buffer.from(b)));

module.exports = { rekey, reversed, jsonb };
