'use strict';

/**
 * The run-table migration, run for real against PGlite: deleting a run or an
 * automation must leave the table's row behind (as an orphan the reaper can
 * find, so its blob is deleted too) instead of cascading it away.
 *
 * Run: cd server && node --test migrations/automation-run-tables-2026-10.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const migration = require('./automation-run-tables-2026-10');
const runTables = require('../stores/automationStore/runTables');

const db = {
    initDB: async () => {},
    run: (sql, params) => pg.query(sql, params).then((r) => ({ rowCount: r.affectedRows || 0, rows: r.rows })),
    getOne: async (sql, params) => (await pg.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await pg.query(sql, params)).rows,
};
const COLS = [{ key: 'a', label: 'A', type: 'text' }];

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY);
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY);
        INSERT INTO automations VALUES ('a1'), ('a2');
        INSERT INTO automation_runs VALUES ('r1'), ('r2');
    `);
    await migration.up();
    await migration.up(); // idempotent
});
after(close);

const record = (id, runId, automationId) => runTables.recordRunTable(
    { id, runId, automationId, storageKey: `k/${id}`, name: id, columns: COLS, rowCount: 1, size: 1, ttlMs: 30 * 86_400_000 }, db,
);

test('deleting a run leaves its table as an orphan the reaper can list', async () => {
    await record('t1', 'r1', 'a1');
    await pg.exec(`DELETE FROM automation_runs WHERE id = 'r1'`);
    const row = await db.getOne('SELECT run_id, automation_id, storage_key FROM automation_run_tables WHERE id = $1', ['t1']);
    assert.deepStrictEqual({ ...row }, { run_id: null, automation_id: 'a1', storage_key: 'k/t1' });
    assert.deepStrictEqual((await runTables.listExpiredRunTables(10, db)).map(r => r.id), ['t1']);
    await runTables.deleteRunTables(['t1'], db);
});

test('deleting an automation leaves its tables as orphans too', async () => {
    await record('t2', 'r2', 'a2');
    await pg.exec(`DELETE FROM automations WHERE id = 'a2'`);
    const row = await db.getOne('SELECT run_id, automation_id FROM automation_run_tables WHERE id = $1', ['t2']);
    assert.deepStrictEqual({ ...row }, { run_id: 'r2', automation_id: null });
    assert.deepStrictEqual((await runTables.listExpiredRunTables(10, db)).map(r => r.id), ['t2']);
});

test('a live table with both links is not listed', async () => {
    await record('t3', 'r2', 'a1');
    assert.ok(!(await runTables.listExpiredRunTables(10, db)).some(r => r.id === 't3'));
});
