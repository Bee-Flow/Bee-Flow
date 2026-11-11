// @typecheck strict
/**
 * The key lookup behind a connector sync's upsert: which incoming key values
 * already have a record. connectorSync.js asks it once per grain.
 */

'use strict';

// Key values per existing-record lookup. Matches the query compiler's bound-
// variable cap; a 500-row sync therefore costs three small indexed queries.
const KEY_LOOKUP_CHUNK = 200;

// The owner sees the whole table — a sync is the owner's own refresh of their
// own feed. Passed explicitly so the compilers stay un-callable unscoped
// (every row, and every column of a table with column rights).
const { OWNER_ACCESS: OWNER_FILTER } = require('../core/dataEngine/accessFilter');

/**
 * Which of THESE key values already have a record, as (key → record id).
 *
 * Scoped to the incoming batch rather than the whole table: a full-table read is
 * capped by the storage engine at 10k rows, so a bigger table would hand back a
 * partial map and every unmatched row would be re-inserted as a duplicate on
 * every single sync. Chunked because a bound `IN (…)` list has a hard limit.
 * @param {{ id: string, userId: string }} app
 * @template T  the table meta, handed through to the compiler as is
 * @param {T} table
 * @param {string} keyColumn
 * @param {unknown[]} keys
 * @param {KeyLookupDeps<T>} deps
 * @returns {Promise<Map<string, unknown>>}
 */
async function existingKeyMap(app, table, keyColumn, keys, deps) {
    /** @type {Map<string, unknown>} */
    const map = new Map();
    const wanted = [...new Set(keys.filter((k) => k !== null && k !== undefined && k !== '').map(String))];
    for (let i = 0; i < wanted.length; i += KEY_LOOKUP_CHUNK) {
        const chunk = wanted.slice(i, i + KEY_LOOKUP_CHUNK);
        const { sql, params } = deps.compileKeyIndex(table, keyColumn, chunk, OWNER_FILTER);
        const result = await deps.query(app.userId, app.id, sql, params);
        // The storage engine answers { rows, columns, truncated }; a stub in a
        // test may hand back the bare array.
        /** @type {Array<{ k?: unknown, id?: unknown }>} */
        const rows = Array.isArray(result) ? result : (/** @type {{ rows?: Array<{ k?: unknown, id?: unknown }> } | null} */ (result)?.rows || []);
        for (const r of rows) {
            const k = r?.k;
            if (k === null || k === undefined || k === '') continue;
            if (!map.has(String(k))) map.set(String(k), r.id);
        }
    }
    return map;
}

module.exports = { existingKeyMap, OWNER_FILTER, KEY_LOOKUP_CHUNK };

/**
 * @template T
 * @typedef {{
 *   compileKeyIndex: (table: T, keyColumn: string, keys: string[], filter: { where: string, params: unknown[] }) => { sql: string, params: unknown[] },
 *   query: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<unknown>,
 * }} KeyLookupDeps
 */
