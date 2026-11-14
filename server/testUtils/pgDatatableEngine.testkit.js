// @typecheck
'use strict';

/**
 * One datatable scope on a real Postgres (PGlite), behind the surface of
 * stores/datatableDbStore that the mirror sources, the datatable tools and
 * the App Studio linked tables call: `query`, `exec`, `batch` and `scopeKey`.
 *
 * The physical tables are laid down by the REAL migration planner, and the
 * statement runners are the REAL ones of stores/lib/pgAppEngine
 * (makeStatements: `?` placeholders, `{ rows }` / `{ changes }`, a batch in one
 * transaction, `expectChanges`); only the transaction wrapper is local: one
 * PGlite session, no ownership registry.
 *
 *   const dt = await pgDatatableEngine([{ id: 'tbl_fac', key: 'facturen', fields }]);
 *   installResolveStub({ '../../stores/datatableDbStore': dt.store });
 *   await dt.insert('facturen', { id: '7', leverancier: 'Acme' });
 *   (await dt.rows('facturen'))   // what the table holds
 *   after(dt.close);
 */

const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');
const { makeStatements } = require('../stores/lib/pgAppEnginePartsTx');
const { newPglite } = require('./pgliteTemplate');
const { insertRow } = require('./pgliteSeed');

/** @param {Array<{ id: string, key: string, fields: any[] }>} tables */
async function pgDatatableEngine(tables) {
    const pg = newPglite();
    await pg.exec("SET TIME ZONE 'UTC'");
    for (const sql of migrationPlan({ modelVersion: 1, tables: [] }, { modelVersion: 1, tables }, { dialect: 'pg' })) await pg.exec(sql);

    /** Every call, with the scope it was addressed to. */
    const calls = /** @type {Array<{ fn: string, ownerId: string, entityId: string, sql?: string, statements?: number }>} */ ([]);
    /** @param {string} _o @param {string} _a @param {{ readOnly?: boolean }} opts @param {(client: any) => Promise<any>} fn */
    const withAppTx = (_o, _a, opts, fn) => pg.transaction(async (tx) => {
        if (opts && opts.readOnly) await tx.query('SET TRANSACTION READ ONLY');
        return fn({
            query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
                const r = await (params && params.length ? tx.query(sql, params) : tx.exec(sql).then((x) => x[x.length - 1]));
                // node-postgres names a statement by its verb; a CTE that reads is a SELECT.
                const verb = String(sql).trim().split(/\s+/)[0].toUpperCase();
                const command = verb === 'WITH' && r.fields && r.fields.length && !r.affectedRows ? 'SELECT' : verb;
                return { rows: r.rows, fields: r.fields, rowCount: r.affectedRows ?? r.rows.length, command };
            },
        });
    });
    const runners = makeStatements({ withAppTx });

    const store = {
        scopeKey: (/** @type {{ kind: string, id: string }} */ scope) => `${scope.kind}:${scope.id}`,
        orgScopeKey: (/** @type {string} */ id) => `org:${id}`,
        query: (/** @type {string} */ o, /** @type {string} */ a, /** @type {string} */ sql, /** @type {unknown[]} */ params) => { calls.push({ fn: 'query', ownerId: o, entityId: a, sql }); return runners.query(o, a, sql, params); },
        exec: (/** @type {string} */ o, /** @type {string} */ a, /** @type {string} */ sql, /** @type {unknown[]} */ params) => { calls.push({ fn: 'exec', ownerId: o, entityId: a, sql }); return runners.exec(o, a, sql, params); },
        batch: (/** @type {string} */ o, /** @type {string} */ a, /** @type {any[]} */ statements) => { calls.push({ fn: 'batch', ownerId: o, entityId: a, statements: statements.length }); return runners.batch(o, a, statements); },
    };

    return {
        pg,
        store,
        calls,
        /** @param {string} key @param {Record<string, unknown>} row */
        insert: (key, row) => insertRow(pg, `"${key}"`, row),
        /** @param {string} key */
        rows: async (key) => (await pg.query(`SELECT * FROM "${key}" ORDER BY id`)).rows,
        close: () => pg.close(),
    };
}

module.exports = { pgDatatableEngine };
