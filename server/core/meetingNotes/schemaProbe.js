// @typecheck strict
/**
 * Schema probes for readers that must answer on a database that may not have
 * every table or column yet (core/meetingNotes/meetingUsage.js): "could not
 * check" is false, never a throw.
 */

const { pool } = require('../../db');

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} Queryable */

/**
 * @param {string} name
 * @param {Queryable | null} [client]
 */
async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return false;
    }
}

/**
 * Does `table` have `column` on THIS database?
 *
 * Via `pg_attribute` keyed on `to_regclass`, not `information_schema.columns`
 * filtered by name: the latter matches a same-named table in any schema on
 * the search path, so it can answer "yes" about a table this connection will
 * never read. Both a missing table and a missing column answer false, and so
 * does a probe that throws — every one of those is "I could not check", which
 * the caller records as `partial`.
 * @param {string} table
 * @param {string} column
 * @param {Queryable | null} [client]
 */
async function columnExists(table, column, client) {
    try {
        const r = await (client || pool).query(
            `SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass($1) AND attname = $2
                AND attnum > 0 AND NOT attisdropped
              LIMIT 1`,
            [table, column],
        );
        return (r.rows || []).length > 0;
    } catch (_) {
        return false;
    }
}

module.exports = { tableExists, columnExists };
