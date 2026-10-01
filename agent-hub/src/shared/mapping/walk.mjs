/**
 * The v2 walker: reading a Source path (structured segments, no grammar) in a
 * run, tolerant of the shape the data turns out to have.
 *
 *   - A KEY on a list maps over its elements implicitly ("Product" of
 *     "Orderregels" is the product of every line). Nesting and holes are
 *     kept: a row without the key is a hole in its own position, so table
 *     rows stay aligned and a list inside a list stays a list.
 *   - A NUMBER indexes a list (and reads the key "3" of an object).
 *   - A string that starts with `{` or `[` is parsed as JSON, but only when a
 *     deeper segment is asked for, only up to MAX_JSON_TEXT, and once per
 *     run when the caller passes a memo.
 *   - Only own properties are read, and REFUSED_KEYS never are: a path can
 *     not reach a prototype, and `length` is not a field anybody picked.
 *
 * The legacy grammar (`[*]`, REF_RE) lives in legacy.mjs and is frozen; this
 * file is what pick bindings read with. A walk that crossed a list returns a
 * Many (an internal marker, see below) so fit.mjs can tell "a list the
 * value is" from "a list the walk made"; walk() hands back plain arrays.
 *
 * Isomorphic and dependency-free, like the rest of this directory.
 */

/** Keys a walk never reads, whatever the value holds. */
export const REFUSED_KEYS = Object.freeze(['length', '__proto__', 'constructor', 'prototype']);

/** The longest text a walk will parse as JSON (1 MB). */
export const MAX_JSON_TEXT = 1024 * 1024;

/** How many parsed texts one memo keeps (oldest out first). */
const MEMO_MAX = 64;

/**
 * The result of a key read on a list: one entry per element, in order, holes
 * (undefined) included. Frozen marker class so a value from the run can never
 * pass for one.
 */
class Many {
    constructor(list) { this.list = list; Object.freeze(this); }
}

/** Did the walk map over a list to get here? */
export function isMany(result) {
    return result instanceof Many;
}

function ownValue(container, seg) {
    if (container === null || typeof container !== 'object') return undefined;
    if (typeof seg === 'string' && REFUSED_KEYS.includes(seg)) return undefined;
    if (typeof seg !== 'string' && !(typeof seg === 'number' && Number.isSafeInteger(seg) && seg >= 0)) return undefined;
    const key = String(seg);
    return Object.prototype.hasOwnProperty.call(container, key) ? container[key] : undefined;
}

/**
 * A JSON text as the object or list it holds, or undefined. `memo` is a Map
 * the caller keeps for one run (execution.js puts it on runState), so the same
 * 900 KB API answer is not parsed once per field that reads into it.
 */
export function parseJsonText(text, memo) {
    if (typeof text !== 'string' || text.length > MAX_JSON_TEXT) return undefined;
    const lead = text.trimStart()[0];
    if (lead !== '{' && lead !== '[') return undefined;
    if (memo && memo.has(text)) return memo.get(text);
    let value;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (value === null || typeof value !== 'object') value = undefined;
    if (memo) {
        if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
        memo.set(text, value);
    }
    return value;
}

function walkFrom(cur, path, i, memo) {
    if (i === path.length) return cur;
    if (typeof cur === 'string') {
        cur = parseJsonText(cur, memo);
        if (cur === undefined) return undefined;
    }
    if (cur === null || typeof cur !== 'object') return undefined;
    const seg = path[i];
    if (Array.isArray(cur) && typeof seg !== 'number') {
        return new Many(cur.map(el => walkFrom(el, path, i, memo)));
    }
    return walkFrom(ownValue(cur, seg), path, i + 1, memo);
}

/**
 * Walk `path` from `value`, keeping the lists the walk crossed as Many.
 * A path that is not an array, or holds a segment that is neither a string
 * nor a non-negative integer, reads nothing.
 * @param {unknown} value
 * @param {Array<string|number>} path
 * @param {{ memo?: Map<string, unknown> }} [opts]
 */
export function walkMany(value, path, { memo } = {}) {
    if (!Array.isArray(path)) return undefined;
    for (const seg of path) {
        if (typeof seg === 'string') continue;
        if (typeof seg === 'number' && Number.isSafeInteger(seg) && seg >= 0) continue;
        return undefined;
    }
    return walkFrom(value, path, 0, memo);
}

/** A walk result as plain data: every Many becomes an array, holes stay undefined. */
export function plain(result) {
    return result instanceof Many ? result.list.map(plain) : result;
}

/**
 * The items a walk result holds, as one flat list, and how many holes were
 * left out. A list the walk crossed is flattened into its elements; a value
 * that IS a list at the end of the path gives its elements (the "12" in
 * "Orderregels · 12"); a single value is a list of one; nothing (undefined,
 * or null at the end of a path that crossed no list) is none.
 * `count` and `all` both read this, so the count shown is the list sent.
 */
export function manyItems(result) {
    let holes = 0;
    const items = [];
    const add = (v, crossed) => {
        if (v instanceof Many) { for (const el of v.list) add(el, true); return; }
        if (v === undefined) { if (crossed) holes++; return; }
        // A field that is empty (null) holds no items; a null ROW inside a
        // list the walk crossed is one, like any other element.
        if (v === null && !crossed) return;
        if (Array.isArray(v)) { items.push(...v); return; }
        items.push(v);
    };
    add(result, false);
    return { items, holes };
}

/**
 * Walk `path` from `value` and return plain data: a key on a list maps over
 * it, nesting and holes kept (`[['a','b'], undefined, ['c']]`).
 * @param {unknown} value
 * @param {Array<string|number>} path
 * @param {{ memo?: Map<string, unknown> }} [opts]
 */
export function walk(value, path, opts) {
    return plain(walkMany(value, path, opts));
}

/** The keys of the trigger that are run metadata, readable through the `run` root. */
const RUN_ROOT_EXCLUDED = new Set(['output', 'headers']);

/**
 * Where a v2 Source starts in a run:
 *   steps   → runState.steps[id].output
 *   trigger → runState.trigger.output (the payload)
 *   run     → runState.trigger, for its metadata keys (id, kind, firedAt, …)
 *   vars    → runState.vars
 *   loop    → runState.loop[id] (a legacy loop / forEach item)
 *   item    → runState.item (the row a collection op or a list-mode set is on)
 * Secrets have no root: a pick can never read one.
 * @param {{ root: string, id?: string }} source
 * @param {object} runState
 */
export function sourceBase(source, runState) {
    if (!source || typeof source !== 'object' || !runState || typeof runState !== 'object') return undefined;
    switch (source.root) {
        case 'steps': return ownValue(ownValue(ownValue(runState, 'steps'), source.id), 'output');
        case 'trigger': return ownValue(ownValue(runState, 'trigger'), 'output');
        case 'run': {
            const first = Array.isArray(source.path) ? source.path[0] : undefined;
            return typeof first === 'string' && !RUN_ROOT_EXCLUDED.has(first) ? ownValue(runState, 'trigger') : undefined;
        }
        case 'vars': return ownValue(runState, 'vars');
        case 'loop': return ownValue(ownValue(runState, 'loop'), source.id);
        case 'item': return ownValue(runState, 'item');
        default: return undefined;
    }
}

/**
 * Walk a whole Source in a run (see sourceBase and walkMany).
 * @param {{ root: string, id?: string, path: Array<string|number> }} source
 * @param {object} runState
 * @param {{ memo?: Map<string, unknown> }} [opts]
 */
export function walkSource(source, runState, opts) {
    if (!source || !Array.isArray(source.path)) return undefined;
    return walkMany(sourceBase(source, runState), source.path, opts);
}
