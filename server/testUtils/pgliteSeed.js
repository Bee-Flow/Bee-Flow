// @typecheck strict
/**
 * Seed rows into a real table on a PGlite, named by column: the fixture side of
 * a test that runs the code's own SQL (testUtils/pglitePool.js) and needs rows
 * of another store's table to read.
 *
 *   const row = await insertRow(pg, 'iso_risks', { organization_id: 'org-a', title: 'x', score: 16 });
 *   row.id   // what the database filled in (RETURNING *)
 *
 * An object or array value goes in as JSON, for a jsonb column.
 */

'use strict';

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} QueryDb */

/** @param {unknown} v */
const asParam = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

/**
 * @param {QueryDb} pg
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @returns {Promise<Record<string, any>>}
 */
async function insertRow(pg, table, row) {
    const cols = Object.keys(row);
    const quoted = cols.map((c) => (/^[a-z_][a-z0-9_]*$/.test(c) ? c : `"${c}"`));
    const { rows } = await pg.query(
        `INSERT INTO ${table} (${quoted.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => asParam(row[c])),
    );
    return rows[0];
}

/**
 * @param {QueryDb} pg
 * @param {string} table
 * @param {Array<Record<string, unknown>>} rows
 */
async function insertRows(pg, table, rows) {
    const out = [];
    for (const row of rows) out.push(await insertRow(pg, table, row));
    return out;
}

module.exports = { insertRow, insertRows };
