/**
 * The schema-3 field types on Postgres (PGlite), through the real per-app engine
 * (stores/lib/pgAppEngine): an autonumber added to a populated table numbers the existing rows
 * in creation order, a new row gets the next number from the INSERT itself, a replayed plan
 * changes nothing, and json / user columns take what the compiler writes.
 *
 * Run: cd server && node --test core/dataEngine/dataModel/fieldTypesV3.pglite.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { usePgAppEngine } = require('../../../testUtils/pgAppEngine.testkit');
const { migrationPlan } = require('./migrationPlan');
const { compileInsert } = require('../queryCompilerWrite');

const OWNER = 'owner-v3';

const pgApp = usePgAppEngine(test);
const rawQuery = (sql, params) => pgApp.rawQuery(sql, params);

const TITLE = { id: 'fld_title1', key: 'title', type: 'text' };
const NO = { id: 'fld_no0001', key: 'no', type: 'autonumber', unique: true };
const DATA = { id: 'fld_data01', key: 'payload', type: 'json' };
const OWNER_F = { id: 'fld_owner1', key: 'owner', type: 'user' };
const model = (fields) => ({ modelVersion: 1, tables: [{ id: 'tbl_orders1', key: 'orders', fields }] });

async function insert(appId, fields, values, at) {
    const c = compileInsert({ key: 'orders', fields }, values, { dialect: 'pg' });
    await pgApp.engine.exec(OWNER, appId, c.sql, c.params.map((p, i) => (i === 1 || i === 2 ? at : p)));
}

test('an autonumber added later numbers the rows in creation order and counts on for a new row', async () => {
    const appId = 'v3-auto';
    await rawQuery(`INSERT INTO studio_apps (id, user_id, engine) VALUES ($1, $2, 'pg')`, [appId, OWNER]);
    await pgApp.engine.applyMigration(OWNER, appId, migrationPlan({ tables: [] }, model([TITLE]), { dialect: 'pg' }));
    await insert(appId, [TITLE], { title: 'second' }, '2026-01-02T00:00:00.000Z');
    await insert(appId, [TITLE], { title: 'first' }, '2026-01-01T00:00:00.000Z');

    const plan = migrationPlan(model([TITLE]), model([TITLE, NO, DATA, OWNER_F]), { dialect: 'pg' });
    await pgApp.engine.applyMigration(OWNER, appId, plan);
    await insert(appId, [TITLE, NO, DATA, OWNER_F], { title: 'third', no: 99, payload: { k: [1] }, owner: 'usr_1' }, '2026-01-03T00:00:00.000Z');

    const rows = async () => (await pgApp.engine.query(OWNER, appId, 'SELECT title, no, payload, owner FROM orders ORDER BY no')).rows
        .map((r) => [r.title, Number(r.no), r.payload, r.owner]);
    assert.deepEqual(await rows(), [['first', 1, null, null], ['second', 2, null, null], ['third', 3, '{"k":[1]}', 'usr_1']]);

    await pgApp.engine.applyMigration(OWNER, appId, plan);
    assert.deepEqual((await rows()).map((r) => r[1]), [1, 2, 3], 'a replayed plan renumbers nothing');
    await assert.rejects(pgApp.engine.exec(OWNER, appId, 'INSERT INTO orders (id, no) VALUES (?, ?)', ['dup', 2]));
});
