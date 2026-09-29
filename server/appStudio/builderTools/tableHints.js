/**
 * A table id the model wrote that is not a table — but names one.
 *
 * Measured 2026-09-13: the small model planned its ids up front
 * (`tbl_suppliers_01`, `tbl_invoices_01`) and wrote actions and a relation
 * input against them before — or instead of — creating the tables. The
 * validator's did-you-mean (pickClosestId) is Levenshtein over `tbl_` + a
 * six-char hash, so an invented handle never comes within distance and the
 * refusal carried no suggestion. The handle itself is the table's key (or its
 * name slugged), which is a lookup, not a guess: strip the prefix and a
 * trailing counter, compare to every table's key and name-slug, accept only a
 * UNIQUE match. Zero or several → null; the caller keeps refusing.
 *
 * Pure.
 */

'use strict';

const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');

/** `tbl_suppliers_01` → `suppliers`; `Suppliers` → `suppliers`; `tbl_ab12cd` → `ab12cd`. */
function tableHandle(id) {
    return String(id == null ? '' : id)
        .trim()
        .replace(/^tbl_/i, '')
        .replace(/[_-]?\d+$/, '')
        .toLowerCase();
}

/**
 * The one table `id` can only mean, or null.
 * @param {string} id
 * @param {Array<{id:string,key?:string,name?:string}>} tables
 * @returns {{ table: object, via: 'id'|'key'|'name' } | null}
 */
function suggestTableId(id, tables) {
    if (typeof id !== 'string' || !id.trim() || !Array.isArray(tables) || !tables.length) return null;
    const exact = tables.find((t) => t && t.id === id);
    if (exact) return { table: exact, via: 'id' };
    const handle = tableHandle(id);
    if (!handle) return null;
    const byKey = tables.filter((t) => t && typeof t.key === 'string' && t.key.toLowerCase() === handle);
    if (byKey.length === 1) return { table: byKey[0], via: 'key' };
    if (byKey.length > 1) return null;
    const byName = tables.filter((t) => t && typeof t.name === 'string' && keyFromTitle(t.name, 0, new Set()) === handle);
    if (byName.length === 1) return { table: byName[0], via: 'name' };
    return null;
}

module.exports = { suggestTableId, tableHandle };
