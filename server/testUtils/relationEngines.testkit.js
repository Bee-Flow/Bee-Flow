// @typecheck
'use strict';

/**
 * Customers and the orders that point at them, on both engines (better-sqlite3 in memory,
 * Postgres through PGlite), for the tests that EXECUTE a read through a relation
 * (core/dataEngine/relationRead.exec.test.js, queryCompiler.aggregateExt.exec.test.js).
 * Each test keeps its own table access and order rows; the customers, the seeding and the
 * engines are shared.
 *
 *   const engines = {}; const seeded = []; const closers = [];
 *   await seedRelationEngines({ customers: CUSTOMERS, orders: ORDERS, orderRows, engines, seeded, closers });
 *   const rows = await engines.pg(sql, params);
 */

const qc = require('../core/dataEngine/queryCompiler');
const { ddlForTable } = require('../core/dataEngine/dataModel/ddl');
const { toDollarParams } = require('../stores/lib/pgAppEngine');

/** The customer table's columns (its id and access are the test's own). */
const CUSTOMER_FIELDS = Object.freeze([
    { id: 'c1', key: 'name', type: 'text' },
    { id: 'c2', key: 'segment', type: 'text' },
    { id: 'c3', key: 'staff', type: 'number', subtype: 'integer' },
]);

const CUSTOMER_ROWS = Object.freeze([
    { id: 'cus_a', name: 'Alpha', segment: 'retail', staff: 4 },
    { id: 'cus_b', name: 'Bravo', segment: 'retail', staff: 120 },
    { id: 'cus_c', name: 'Charlie', segment: 'wholesale', staff: 55 },
    { id: 'cus_d', name: 'Delta', segment: 'public', staff: 7 },
]);

const customerOf = (id) => CUSTOMER_ROWS.find((c) => c.id === id) || null;
/** The customer as a member may see it: retail only. */
const readableCustomer = (id) => { const c = customerOf(id); return c && c.segment === 'retail' ? c : null; };

/**
 * Create both tables on both engines and insert the customers (owned by u9) and the orders.
 * Fills `engines` ({ sqlite, pg }: (sql, params) => rows), `seeded` (every order as
 * { id, ...values, owner }) and `closers`; `onSql(dialect, sql, params)` sees every statement.
 */
/** @param {{ customers: { id: string, key: string, [k: string]: any }, orders: { id: string, key: string, [k: string]: any }, orderRows: any[], engines: Record<string, any>, seeded: Record<string, any>, closers: Array<() => unknown>, onSql?: (engine: string, sql: string, params?: unknown[]) => void }} world */
async function seedRelationEngines({ customers, orders, orderRows, engines, seeded, closers, onSql = () => {} }) {
    const Database = require('better-sqlite3');
    const lite = new Database(':memory:');
    closers.push(() => lite.close());
    const { newPglite } = require('./pgliteTemplate');
    const pg = newPglite();
    closers.push(() => pg.close());
    await pg.exec("SET TIME ZONE 'UTC'");
    engines.sqlite = async (sql, params) => {
        onSql('sqlite', sql, params);
        const stmt = lite.prepare(sql);
        return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
    };
    engines.pg = async (sql, params) => {
        onSql('pg', sql, params);
        return (await pg.query(toDollarParams(sql, params.length), params)).rows;
    };
    for (const table of [customers, orders]) {
        lite.exec(ddlForTable(table, { dialect: 'sqlite' }));
        await pg.exec(ddlForTable(table, { dialect: 'pg' }));
    }
    const inserts = [
        ...CUSTOMER_ROWS.map(({ id, ...values }) => ({ table: customers, values, id, owner: 'u9' })),
        ...orderRows.map((row, n) => ({ table: orders, values: row.values, id: `ord_${String(n).padStart(3, '0')}`, owner: row.owner })),
    ];
    for (const ins of inserts) {
        for (const dialect of ['sqlite', 'pg']) {
            const c = qc.compileInsert(ins.table, ins.values, { createdBy: ins.owner, orgId: 'o1', id: ins.id, dialect });
            await engines[dialect](c.sql, c.params);
        }
        if (ins.table === orders) seeded.push({ id: ins.id, ...ins.values, owner: ins.owner });
    }
}

module.exports = { CUSTOMER_FIELDS, CUSTOMER_ROWS, customerOf, readableCustomer, seedRelationEngines };
