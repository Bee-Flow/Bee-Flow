// @typecheck strict
/**
 * App Studio canonicalizer — the keys of a data read that were added after the frozen base.
 *
 * The base grammar (bindings.js) copies the keys it knows and drops the rest. A key marked in
 * componentSpecs/keys/binding/ (a key of the binding) or as an entry key in
 * componentSpecs/keys/queryShape/ (a key of a groupBy or aggregates entry) is kept by this ONE
 * pass, with the mark's own `clean`, so a feature adds a file and never a line to bindings.js.
 *
 * Emit-when-present: an absent, null or undefined key stays absent, and so does one whose
 * `clean` answers undefined. With nothing marked the pass writes nothing, so a definition that
 * uses no marked key keeps its bytes. The marks are read at call time (a test adds one in place).
 */

'use strict';

const specs = require('../componentSpecs');
const { kindsOf } = require('../componentSpecs/queryMarks');
const { deepCopy } = require('./shared');

/** @typedef {(code: string, path: string, message: string) => void} Push */
/** @typedef {{ clean?: (value: unknown, ctx: { path: string, push: Push, kind?: string }) => unknown, kinds?: readonly string[], entryKey?: boolean }} Mark */

/**
 * Write the cleaned value of `key` onto `out` when `raw` carries one.
 * @param {Mark} mark
 * @param {string} key
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} out
 * @param {{ path: string, push: Push, kind?: string }} ctx
 */
function keep(mark, key, raw, out, ctx) {
    if (typeof mark.clean !== 'function' || !Object.hasOwn(raw, key) || Object.hasOwn(out, key)) return;
    const value = raw[key];
    if (value === undefined || value === null) return;
    // A copy with JSON semantics: what `clean` answers never aliases the caller's object graph.
    const cleaned = deepCopy(mark.clean(value, ctx));
    if (cleaned !== undefined && cleaned !== null) out[key] = cleaned;
}

/**
 * Keep the marked keys of one binding: those marked for its kind, in the registry's order,
 * after the base keys.
 * @param {Record<string, unknown>} raw  the authored binding
 * @param {Record<string, unknown>} out  the canonical binding so far (its `kind` is set)
 * @param {string} path
 * @param {Push} push
 */
function keepMarkedBindingKeys(raw, out, path, push) {
    const marks = /** @type {Record<string, Mark>} */ (specs.KEY_MARKS.binding);
    const kind = String(out.kind);
    for (const key of Object.keys(marks)) {
        if (kindsOf(marks[key]).includes(kind)) keep(marks[key], key, raw, out, { path: `${path}.${key}`, push, kind });
    }
}

/**
 * Keep the marked keys of one entry of a list the base grammar rebuilds (`groupBy`, `aggregates`).
 * @param {string} list  the key the list sits under
 * @param {Record<string, unknown>} raw  the authored entry
 * @param {Record<string, unknown>} out  the canonical entry so far
 * @param {string} path
 * @param {Push} push
 */
function keepMarkedEntryKeys(list, raw, out, path, push) {
    const marks = /** @type {Record<string, Mark>} */ (specs.KEY_MARKS.queryShape);
    const prefix = `${list}.`;
    for (const name of Object.keys(marks)) {
        if (marks[name].entryKey !== true || !name.startsWith(prefix)) continue;
        const key = name.slice(prefix.length);
        keep(marks[name], key, raw, out, { path: `${path}.${key}`, push });
    }
}

module.exports = { keepMarkedBindingKeys, keepMarkedEntryKeys };
