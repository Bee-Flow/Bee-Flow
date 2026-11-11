// @typecheck strict
'use strict';

/**
 * The entries of a list kept as authored, with their keys in one fixed order.
 *
 * Postgres JSONB hands a stored definition back with its object keys in its own order (shorter
 * keys first), so a list that canonicalize passes through would carry whichever order it was last
 * read in. A since-3 binding key whose entries are small objects (orderBy, expand, groupFilter)
 * uses this as its `clean`: every entry that is an object gets the declared keys first, in the
 * order given, and any other key after them, sorted. Values, the list order and entries that are
 * not objects stay exactly as written; the validator still judges the list.
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {readonly string[]} declared  the keys of an entry, in the order the shape names them
 * @returns {(value: unknown) => unknown}
 */
function entriesInKeyOrder(declared) {
    /** @param {Record<string, unknown>} entry */
    const ordered = (entry) => {
        const rest = Object.keys(entry).filter((k) => !declared.includes(k)).sort();
        const keys = [...declared.filter((k) => Object.hasOwn(entry, k)), ...rest];
        return Object.fromEntries(keys.map((k) => [k, entry[k]]));
    };
    return (value) => (Array.isArray(value) ? value.map((entry) => (isPlainObject(entry) ? ordered(entry) : entry)) : value);
}

module.exports = { entriesInKeyOrder };
