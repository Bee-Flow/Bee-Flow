// @typecheck
/**
 * App Studio canonicalizer — the leaf helpers every canonicalize/ module
 * shares: the object/formula predicates, the JSON-semantics deep copy, string
 * truncation, and the recursion ceiling for the tree walk.
 */

'use strict';

// Recursion ceiling for the tree walk — far above LIMITS.MAX_DEPTH (which
// validate.js enforces properly); this only exists so a pathologically nested
// blob cannot blow the stack before validation ever runs.
const HARD_DEPTH_CAP = 32;

const { SCHEMA_VERSION_BASE } = require('../componentSpecs/ids');

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// JSON-semantics deep copy (functions/undefined dropped, depth-capped) so
// kept values never alias the caller's object graph.
/**
 * @param {number} [depth]
 */
function deepCopy(v, depth = 0) {
    if (v === null || typeof v !== 'object') {
        return typeof v === 'function' ? undefined : v;
    }
    if (depth > 64) return null;
    if (Array.isArray(v)) return v.map((x) => { const c = deepCopy(x, depth + 1); return c === undefined ? null : c; });
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        const c = deepCopy(val, depth + 1);
        if (c !== undefined) out[k] = c;
    }
    return out;
}

/**
 * @param {string} str
 * @param {number} maxLen
 * @param {string} path
 * @param {(arg0: string, path: string, arg2: string) => void} push
 */
function truncate(str, maxLen, path, push) {
    if (typeof str !== 'string' || str.length <= maxLen) return str;
    push('string.truncated', path, `String of ${str.length} chars truncated to the ${maxLen}-char limit.`);
    return str.slice(0, maxLen);
}

function isFormulaObj(v) { return isObject(v) && v.kind === 'formula'; }

/**
 * Cleans one optional key: the value to store, or undefined to leave the key out (after
 * pushing a repair when the value was given but not acceptable).
 * @typedef {(value: unknown, path: string, push: (code: string, path: string, message: string) => void) => unknown} OptionalKeyCleaner
 */

/**
 * Emit-when-present keys: for each key of `cleaners` (in the table's order) that `raw`
 * carries with a value other than undefined or null, write what its cleaner returns onto
 * `out`, unless that is undefined. An absent key stays absent, so an object that never used
 * the key canonicalizes to the bytes it had before the key existed. Returns `out`.
 * @template {Record<string, unknown>} T
 * @param {T} out
 * @param {Record<string, unknown>} raw
 * @param {Readonly<Record<string, OptionalKeyCleaner>>} cleaners
 * @param {string} path
 * @param {(code: string, path: string, message: string) => void} push
 * @returns {T}
 */
function emitOptionalKeys(out, raw, cleaners, path, push) {
    for (const [key, clean] of Object.entries(cleaners)) {
        const value = raw[key];
        if (value === undefined || value === null) continue;
        const cleaned = clean(value, `${path}.${key}`, push);
        if (cleaned !== undefined) /** @type {Record<string, unknown>} */ (out)[key] = cleaned;
    }
    return out;
}

/**
 * True for a spec entry (a prop, a step or action field) added after the frozen base: it
 * carries `since` above the base schema version. Such an entry is EMIT-WHEN-PRESENT: it is
 * cleaned when the definition carries it and left out otherwise, never filled with a default.
 * Filling it would write the key into every stored node or step of that type on its next
 * save, and raise that definition's schema version for something its author never used.
 * @param {unknown} spec
 */
function isLateEntry(spec) {
    const since = /** @type {{ since?: unknown } | null | undefined} */ (spec)?.since;
    return typeof since === 'number' && Number.isInteger(since) && since > SCHEMA_VERSION_BASE;
}

module.exports = { HARD_DEPTH_CAP, isObject, deepCopy, truncate, isFormulaObj, emitOptionalKeys, isLateEntry };
