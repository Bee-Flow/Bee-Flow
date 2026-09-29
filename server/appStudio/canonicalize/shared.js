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

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// JSON-semantics deep copy (functions/undefined dropped, depth-capped) so
// kept values never alias the caller's object graph.
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

function truncate(str, maxLen, path, push) {
    if (typeof str !== 'string' || str.length <= maxLen) return str;
    push('string.truncated', path, `String of ${str.length} chars truncated to the ${maxLen}-char limit.`);
    return str.slice(0, maxLen);
}

function isFormulaObj(v) { return isObject(v) && v.kind === 'formula'; }

module.exports = { HARD_DEPTH_CAP, isObject, deepCopy, truncate, isFormulaObj };
