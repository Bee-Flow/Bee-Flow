// @typecheck strict
/**
 * Make a real table on a PGlite fail the way a production database does, for
 * a test of what the code does when a read goes wrong:
 *
 *   const restore = await failReads(pg, 'agents', '57014', 'canceling statement due to statement timeout');
 *   ... every statement that reads `agents` now fails with that SQLSTATE ...
 *   await restore();
 *
 *   const restore = await hideTable(pg, 'agents');   // 42P01, as on an install that never created it
 *
 * The table is renamed out of the way and a view of the same name stands in;
 * the view reads a set-returning function that raises (a function scan runs
 * even when the table is empty), so the error carries a real SQLSTATE and
 * `severity`, exactly as node-postgres would hand it over.
 */

'use strict';

/** @typedef {{ exec: (sql: string) => Promise<unknown> }} ExecDb */

let seq = 0;

/**
 * @param {ExecDb} pg
 * @param {string} table
 * @param {string} sqlstate  five characters, e.g. '57014'
 * @param {string} message
 * @returns {Promise<() => Promise<void>>} restore
 */
async function failReads(pg, table, sqlstate, message) {
    seq += 1;
    const aside = `${table}__test_aside_${seq}`;
    const fn = `test_fail_${seq}`;
    await pg.exec(`
        ALTER TABLE ${table} RENAME TO ${aside};
        CREATE FUNCTION ${fn}() RETURNS SETOF ${aside} LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '${message.replace(/'/g, "''")}' USING ERRCODE = '${sqlstate}'; END $$;
        CREATE VIEW ${table} AS SELECT * FROM ${fn}();
    `);
    return async () => {
        await pg.exec(`DROP VIEW ${table}; DROP FUNCTION ${fn}(); ALTER TABLE ${aside} RENAME TO ${table};`);
    };
}

/**
 * @param {ExecDb} pg
 * @param {string} table
 * @returns {Promise<() => Promise<void>>} restore
 */
async function hideTable(pg, table) {
    seq += 1;
    const aside = `${table}__test_hidden_${seq}`;
    await pg.exec(`ALTER TABLE ${table} RENAME TO ${aside}`);
    return async () => { await pg.exec(`ALTER TABLE ${aside} RENAME TO ${table}`); };
}

module.exports = { failReads, hideTable };
