// @typecheck
/**
 * How much data does a user own, across EVERY table that can hold it?
 *
 * Used by the operator scripts that decide whether a user row is "empty" and
 * safe to drop (cleanupAzureDuplicates.js). A hand-kept list of four tables
 * went stale the moment a feature added its own per-user table: deleteUser
 * erases notebooks, the PII vault, connections and agents, none of which the
 * old check looked at. So the tables are discovered from the catalog instead:
 *
 *   - every base table in the current schema with a column whose NAME marks it
 *     as the owning user (USER_COLUMNS), and
 *   - every column with a foreign key to users(id), whatever its name.
 *
 * Fail-closed: a discovery that fails or finds nothing throws, and a table
 * whose count fails is recorded under `errors`, which makes
 * isSafeToDelete() answer false. An unknown is never a zero.
 */

'use strict';

/**
 * Column names that hold the id of the user a row belongs to. Audit-style
 * references (actor_id, updated_by, invited_by) are deliberately left out: they
 * record who touched a row, not whose data it is.
 */
const USER_COLUMNS = Object.freeze([
    'user_id', 'userId',
    'owner_id', 'ownerId', 'owner_user_id', 'ownerUserId',
    'created_by', 'createdBy',
    'author_user_id', 'uploaded_by',
]);

const DISCOVER_SQL = `
    SELECT c.table_name AS table_name, c.column_name AS column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = current_schema()
       AND t.table_type = 'BASE TABLE'
       AND c.table_name <> 'users'
       AND c.column_name = ANY($1::text[])
    UNION
    SELECT rel.relname::text AS table_name, att.attname::text AS column_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      JOIN pg_class ref ON ref.oid = con.confrelid
      CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f'
       AND ns.nspname = current_schema()
       AND ref.relname = 'users'
       AND ref.relnamespace = ns.oid
       AND rel.relname <> 'users'
     ORDER BY 1, 2`;

/** @param {string} name */
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * @typedef {{ table: string, columns: string[] }} UserTable
 * @typedef {{ counts: Record<string, number>, total: number, errors: Record<string, string> }} Footprint
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 */

/**
 * Every table (with its user columns) that can hold a user's data.
 * Throws when the catalog cannot be read or names no table at all.
 *
 * @param {Db} db
 * @returns {Promise<UserTable[]>}
 */
async function discoverUserTables(db) {
    const { rows } = await db.query(DISCOVER_SQL, [USER_COLUMNS]);
    /** @type {Map<string, Set<string>>} */
    const byTable = new Map();
    for (const { table_name: table, column_name: column } of rows) {
        if (!byTable.has(table)) byTable.set(table, new Set());
        /** @type {Set<string>} */ (byTable.get(table)).add(column);
    }
    if (byTable.size === 0) {
        throw new Error('userDataFootprint: found no table with user data in the current schema; refusing to treat any user as empty');
    }
    return [...byTable.entries()].map(([table, columns]) => ({ table, columns: [...columns].sort() }));
}

/**
 * Row counts per table for one user. A failing count lands in `errors`.
 *
 * @param {Db} db
 * @param {string} userId
 * @param {UserTable[]} tables  from discoverUserTables
 * @returns {Promise<Footprint>}
 */
async function userDataFootprint(db, userId, tables) {
    /** @type {Record<string, number>} */
    const counts = {};
    /** @type {Record<string, string>} */
    const errors = {};
    let total = 0;
    for (const { table, columns } of tables) {
        const where = columns.map((c) => `${quoteIdent(c)}::text = $1`).join(' OR ');
        try {
            const { rows } = await db.query(
                `SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)} WHERE ${where}`,
                [userId],
            );
            const n = Number(rows[0]?.n) || 0;
            if (n > 0) counts[table] = n;
            total += n;
        } catch (e) {
            errors[table] = e instanceof Error ? e.message : String(e);
        }
    }
    return { counts, total, errors };
}

/**
 * Only a footprint that is known to be empty is safe to delete.
 *
 * @param {Footprint} footprint
 */
function isSafeToDelete(footprint) {
    return footprint.total === 0 && Object.keys(footprint.errors).length === 0;
}

module.exports = { USER_COLUMNS, DISCOVER_SQL, discoverUserTables, userDataFootprint, isSafeToDelete };
