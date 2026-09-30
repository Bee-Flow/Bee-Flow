/**
 * A real Postgres for a store test: @electric-sql/pglite, in-process, behind
 * the small `db` a store factory takes (`makeSharesStore(db)`,
 * `makeLifecycleStore(db)`, ...), so the store runs its own SQL with no
 * module mocking.
 *
 *   const { pg, db } = pgliteDb();
 *   const store = makeSharesStore(db);
 *   before(async () => { await pg.exec(DDL); });
 *   after(async () => { await pg.close(); });
 *
 * `db.query` answers `{ rows, rowCount }` the way node-postgres does;
 * `db.tx(fn)` runs `fn` inside a transaction with a client of that same shape.
 * `pg` is the PGlite handle itself, for seeding and reading back.
 */

'use strict';

const { PGlite } = require('@electric-sql/pglite');

/** PGlite's result in node-postgres's shape (rowCount from affectedRows for a write). */
function asPgResult(r) {
    const rows = r.rows || [];
    return { rows, rowCount: typeof r.affectedRows === 'number' ? r.affectedRows : rows.length };
}

// Parameters go along only when there are any: query(sql) otherwise.
const send = (conn, sql, params) => (params && params.length ? conn.query(sql, params) : conn.query(sql));

function pgliteDb(pg = new PGlite()) {
    const db = {
        async query(sql, params) {
            return asPgResult(await send(pg, sql, params));
        },
        async tx(fn) {
            return pg.transaction(async (t) => fn({
                query: async (sql, params) => asPgResult(await send(t, sql, params)),
            }));
        },
    };
    return { pg, db };
}

/**
 * The schema of a project-scoped store under test: a minimal `projects` table
 * holding `projectIds` (its rows' foreign-key target), then the store's `ddl`.
 *
 * @param {import('@electric-sql/pglite').PGlite} pg
 * @param {string} ddl
 * @param {string[]} [projectIds]
 */
async function createProjectScopedSchema(pg, ddl, projectIds = ['p1', 'p2']) {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(ddl);
    for (const id of projectIds) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'owner']);
}

module.exports = { pgliteDb, createProjectScopedSchema };
