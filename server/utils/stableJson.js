// @typecheck
'use strict';

/**
 * Deterministic JSON text: object keys sorted, arrays in their own order, so
 * two structurally equal values give one string whatever order their keys
 * were written in. Used for cache keys, content hashes and "is this the same
 * call?" signatures.
 *
 * The server used to carry a private copy of this per module, and the copies
 * did NOT agree on the edges. The edges are explicit options here, and every
 * caller picks the variant that reproduces the text its old copy produced
 * (a stored hash or a cache key must not change underneath it).
 *
 * stableStringify(value, { undefined, toJSON })
 *   Keys ordered by Array#sort() (UTF-16 code units), text built by hand.
 *   `undefined` decides what a value JSON cannot hold becomes:
 *     'null' (default)  undefined -> null everywhere (a member stays, as
 *                       `"k":null`). Other leaves go through JSON.stringify
 *                       as they are.
 *     'drop'            JSON's own rule for undefined, functions and symbols:
 *                       the member is left out of an object, null in an
 *                       array, 'null' at the top level.
 *     'raw'             no special case: every leaf goes through
 *                       JSON.stringify, so an undefined member reads
 *                       `"k":undefined` and a top-level undefined returns
 *                       undefined (not a string).
 *   `toJSON: true` serialises an object with a toJSON() method (a Date) as
 *   what that method returns; without it a Date has no own keys and is `{}`.
 *
 * sortedKeysJson(value, { toJSON = true })
 *   JSON.stringify over a copy whose plain objects were rebuilt with their
 *   keys inserted in sorted order. Everything else is JSON.stringify's own
 *   behaviour, including the JS engine listing integer-like keys ("2", "10")
 *   first in numeric order, and returning undefined for a top-level
 *   undefined/function (callers decide what that becomes). With toJSON
 *   (default) a Date becomes its ISO string; with `toJSON: false` the copy is
 *   rebuilt before JSON.stringify sees it, so a Date is `{}`.
 *
 * Not covered on purpose (they keep their own serialiser): the evidence hash
 * in compliance/evidence/canonical.js (code-point key order after a JSONB
 * round trip), pollDiff's canonical() (depth-capped) and
 * stores/lib/managedParts.js stable() (every leaf as a string).
 */

/** @param {unknown} v */
const isSkippable = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * @param {unknown} value
 * @param {{ undefined?: 'null' | 'drop' | 'raw', toJSON?: boolean }} [opts]
 * @returns {string} (undefined only in 'raw' mode for a non-JSON top level)
 */
function stableStringify(value, opts) {
    const mode = (opts && opts.undefined) || 'null';
    const toJSON = !!(opts && opts.toJSON);
    if (mode !== 'null' && mode !== 'drop' && mode !== 'raw') {
        throw new TypeError(`stableStringify: unknown undefined mode ${JSON.stringify(mode)}`);
    }
    /** @type {(v: any) => string} */
    const walk = (v) => {
        if (mode === 'drop' ? isSkippable(v) : mode === 'null' && v === undefined) return 'null';
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (toJSON && typeof v.toJSON === 'function') return walk(v.toJSON());
        if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
        let keys = Object.keys(v);
        if (mode === 'drop') keys = keys.filter((k) => !isSkippable(v[k]));
        keys.sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
    };
    return walk(value);
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {Record<string, unknown>} v */
function sortObjectKeys(v) {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(v).sort()) sorted[key] = v[key];
    return sorted;
}

/**
 * @param {unknown} value
 * @param {{ toJSON?: boolean }} [opts]
 * @returns {string | undefined}
 */
function sortedKeysJson(value, opts) {
    const toJSON = !(opts && opts.toJSON === false);
    if (toJSON) {
        // JSON.stringify calls toJSON() before the replacer, so a Date
        // arrives here as its string already.
        return JSON.stringify(value, (_k, v) => (isPlainObject(v) ? sortObjectKeys(v) : v));
    }
    /** @type {(x: unknown) => unknown} */
    const sortDeep = (x) => {
        if (Array.isArray(x)) return x.map(sortDeep);
        if (isPlainObject(x)) {
            /** @type {Record<string, unknown>} */
            const out = {};
            for (const k of Object.keys(x).sort()) out[k] = sortDeep(x[k]);
            return out;
        }
        return x;
    };
    return JSON.stringify(sortDeep(value));
}

module.exports = { stableStringify, sortedKeysJson };
