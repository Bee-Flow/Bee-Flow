// @typecheck strict
/**
 * The collection functions of the expression language: sort, reverse, slice,
 * groupBy, keys, values, merge and range. Plain functions (they join FUNCTIONS
 * in functions.mjs through lists.mjs's LIST_FUNCTIONS); reduce() is a special form in the engine, like
 * map/filter, and only its doc entry lives here.
 *
 * Every name here was an "Unknown function" before it existed, so no stored
 * formula changes meaning. Pure, null-safe and deterministic like the rest:
 * nothing reads a locale (text is ordered by its lower-cased code units, then
 * by the text itself), an input is never changed (every result is a new
 * list or object), and range() is the only one that makes items out of
 * nothing, so it has a fixed ceiling (limits.mjs MAX_RANGE_ITEMS).
 */
import { ExprLimitError, MAX_RANGE_ITEMS } from './limits.mjs';

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The value under `key` (own property only), or undefined.
 * @param {unknown} el @param {string} key
 */
function ownField(el, key) {
    return el !== null && typeof el === 'object' && Object.prototype.hasOwnProperty.call(el, key) ? /** @type {Record<string, unknown>} */ (el)[key] : undefined;
}

/** @param {unknown} v */
const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/** Numbers first, then text, then true/false, then lists and objects. @param {unknown} v */
function typeRank(v) {
    if (typeof v === 'number') return 0;
    if (typeof v === 'string') return 1;
    if (typeof v === 'boolean') return 2;
    return 3;
}

/** @param {string} a @param {string} b */
function compareText(a, b) {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * The order of two present values: by kind first, then within the kind.
 * Lists and objects have no order of their own (0: they keep their place).
 * @param {unknown} a @param {unknown} b
 */
function compareValues(a, b) {
    const ra = typeRank(a);
    const rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return /** @type {number} */ (a) - /** @type {number} */ (b);
    if (ra === 1) return compareText(/** @type {string} */ (a), /** @type {string} */ (b));
    if (ra === 2) return Number(a) - Number(b);
    return 0;
}

/** @param {unknown} key @returns {string | null} */
const keyName = (key) => (key == null || key === '' ? null : String(key));

/**
 * sort(list, key?, direction?): a sorted copy. Missing values go last in
 * both directions; equal values keep the order they had.
 * @param {unknown} list @param {unknown} [key] @param {unknown} [direction]
 */
export function sortOf(list, key, direction) {
    if (!Array.isArray(list)) return [];
    const k = keyName(key);
    const sign = typeof direction === 'string' && direction.trim().toLowerCase() === 'desc' ? -1 : 1;
    const rows = list.map((item, at) => ({ item, at, by: k == null ? item : ownField(item, k) }));
    rows.sort((x, y) => {
        const mx = isMissing(x.by);
        const my = isMissing(y.by);
        if (mx || my) return mx === my ? x.at - y.at : (mx ? 1 : -1);
        return sign * compareValues(x.by, y.by) || x.at - y.at;
    });
    return rows.map((r) => r.item);
}

/** A whole position from an argument; `fallback` when it is missing or not a number. @param {unknown} v @param {number} fallback */
function position(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * slice(list, start, end?): the items from start up to (not including) end;
 * a negative position counts from the end.
 * @param {unknown} list @param {unknown} start @param {unknown} [end]
 */
export function sliceOf(list, start, end) {
    if (!Array.isArray(list)) return [];
    return list.slice(position(start, 0), position(end, list.length));
}

/**
 * How groupBy() tells two keys apart: scalars strictly, lists and objects by
 * their JSON text. The two kinds never share a group (a text that happens to
 * spell an object's JSON is still a text), so each has its own table.
 * @param {unknown} v @returns {{ object: boolean, id: unknown }}
 */
function groupIdentity(v) {
    if (v !== null && typeof v === 'object') {
        try { return { object: true, id: JSON.stringify(v) }; } catch { return { object: false, id: v }; }
    }
    return { object: false, id: v === undefined ? null : v };
}

/**
 * groupBy(list, key): one `{ key, items }` per value under key, in the order
 * the values first occur. A missing value is the group with key null.
 * @param {unknown} list @param {unknown} key
 */
export function groupByOf(list, key) {
    if (!Array.isArray(list)) return [];
    const k = keyName(key);
    /** @typedef {{ key: unknown, items: unknown[] }} Group */
    /** @type {Map<unknown, Group>} */
    const scalars = new Map();
    /** @type {Map<unknown, Group>} */
    const objects = new Map();
    /** @type {Group[]} */
    const out = [];
    for (const item of list) {
        const value = k == null ? item : ownField(item, k);
        const { object, id } = groupIdentity(value);
        const table = object ? objects : scalars;
        let group = table.get(id);
        if (!group) { group = { key: value === undefined ? null : value, items: [] }; table.set(id, group); out.push(group); }
        group.items.push(item);
    }
    return out;
}

/**
 * merge(a, b, ...): one object with the keys of all of them; a later one
 * wins. Anything that is not an object is skipped.
 * @param {unknown[]} objects
 */
export function mergeOf(objects) {
    /** @type {Record<string, unknown>} */
    let out = {};
    // Spread defines own properties, so a "__proto__" key stays a key.
    for (const o of objects) if (isPlainObject(o)) out = { ...out, ...o };
    return out;
}

/** A finite number from an argument, or null. @param {unknown} v */
function finiteOf(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * range(n) is 0 … n-1; range(start, end, step?) runs from start up to (not
 * including) end. An unreadable argument or a step that never arrives gives [].
 * @param {unknown} a @param {unknown} [b] @param {unknown} [c]
 */
export function rangeOf(a, b, c) {
    const single = b === undefined || b === null;
    const start = single ? 0 : finiteOf(a);
    const end = finiteOf(single ? a : b);
    const step = c === undefined || c === null ? 1 : finiteOf(c);
    if (start == null || end == null || step == null || step === 0) return [];
    const count = Math.ceil((end - start) / step);
    if (!(count > 0)) return [];
    if (count > MAX_RANGE_ITEMS) throw new ExprLimitError(`range() makes at most ${MAX_RANGE_ITEMS} items`);
    const out = [];
    for (let i = 0; i < count; i++) out.push(start + i * step);
    return out;
}

/** The plain functions of this file, spread into LIST_FUNCTIONS (lists.mjs) and so into FUNCTIONS. */
export const COLLECTION_FUNCTIONS = {
    sort: (/** @type {unknown} */ list, /** @type {unknown} */ key, /** @type {unknown} */ direction) => sortOf(list, key, direction),
    reverse: (/** @type {unknown} */ list) => (Array.isArray(list) ? [...list].reverse() : []),
    slice: (/** @type {unknown} */ list, /** @type {unknown} */ start, /** @type {unknown} */ end) => sliceOf(list, start, end),
    groupBy: (/** @type {unknown} */ list, /** @type {unknown} */ key) => groupByOf(list, key),
    keys: (/** @type {unknown} */ o) => (isPlainObject(o) ? Object.keys(o) : []),
    values: (/** @type {unknown} */ o) => (isPlainObject(o) ? Object.values(o) : []),
    merge: (/** @type {unknown[]} */ ...objects) => mergeOf(objects),
    range: (/** @type {unknown} */ a, /** @type {unknown} */ b, /** @type {unknown} */ c) => rangeOf(a, b, c),
};

/** reduce(list, expr, start): a special form in the engine (the body reads `acc` and `it`). */
export const REDUCE_FN = 'reduce';

/**
 * The doc entries of the functions above and of reduce(). `since: 3` marks
 * vocabulary that arrived with schema version 3 of the app definition: the
 * byte-pinned builder catalogue leaves those out (formulaGuide.js).
 */
export const COLLECTION_FUNCTION_DOCS = [
    { name: 'sort', signature: 'sort(list, key?, "asc"|"desc"?)', description: 'A sorted copy: numbers by value, text alphabetically (ignoring upper/lower case); with key, by the value under key. Empty values go last.', since: 3 },
    { name: 'reverse', signature: 'reverse(list)', description: 'The list in the opposite order.', since: 3 },
    { name: 'slice', signature: 'slice(list, start, end?)', description: 'The items from position start (0 = first) up to, not including, end; a negative position counts from the end.', since: 3 },
    { name: 'groupBy', signature: 'groupBy(list, key)', description: 'One { key, items } per different value under key, in the order the values first occur.', since: 3 },
    { name: 'keys', signature: 'keys(object)', description: 'The names of the fields of an object, as a list.', since: 3 },
    { name: 'values', signature: 'values(object)', description: 'The values of the fields of an object, as a list.', since: 3 },
    { name: 'merge', signature: 'merge(a, b, …)', description: 'One object with the fields of all of them; a later one wins.', since: 3 },
    { name: 'range', signature: 'range(n) / range(start, end, step?)', description: 'The numbers 0 … n-1, or from start up to (not including) end. At most 10,000 numbers.', since: 3 },
    { name: 'reduce', signature: 'reduce(list, expr, start)', description: 'One value from a list: expr is worked out per item (it) with the result so far (acc), beginning at start. reduce(rows, acc + it.qty, 0).', since: 3 },
];
