// @typecheck
/**
 * The JSON helpers every store row mapper shares.
 *
 * Twelve stores each carried their own `parseJSON`. They agreed on everything
 * that matters — a jsonb column pg already hydrated passes through, a string is
 * parsed, a parse error becomes the fallback — and differed only in the tail,
 * for a column holding a bare scalar. That difference is a decision, not an
 * accident, so it is two functions here rather than one with a flag:
 *
 *   parseJSON        a scalar is data: `0` stays `0`
 *   parseJSONObject  a scalar is not the object/array this column should hold,
 *                    so it becomes the fallback
 */

/**
 * Parse a possibly-JSON value from a DB column.
 * - Already an array/object (jsonb hydrated by pg) → returned as-is.
 * - A string → JSON.parse, or `fallback` on parse error.
 * - null/undefined/other → `v ?? fallback`.
 * @param {*} v
 * @param {*} [fallback]
 */
function parseJSON(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return fallback; }
    }
    return v ?? fallback;
}

/**
 * As parseJSON, but a column that yields a bare scalar gets the fallback: the
 * caller asked for an object or an array and a number is not one.
 * @param {*} v
 * @param {*} [fallback]
 */
function parseJSONObject(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return fallback; }
    }
    return fallback;
}

/**
 * jsonb pass-through with null coalescing. Behaviourally pinned by
 * automationStore.runStepOutput.test.js — pg already hydrates jsonb, so this
 * only normalizes `undefined` → `null`.
 * @param {*} v
 */
function fromJsonb(v) {
    return v ?? null;
}

/**
 * Parse a JSON string, returning `fallback` on any error. Unlike parseJSON this
 * does NOT object/array-passthrough — it always attempts JSON.parse.
 * @param {string} s
 * @param {*} [fallback]
 */
function safeParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = { parseJSON, parseJSONObject, fromJsonb, safeParse };
