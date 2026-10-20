'use strict';

/**
 * The run-table ledger, run for real against PGlite: live-only reads, scoping to
 * the runs or the automation given, the per-run count, expiry order, deletion
 * and the expiry that only moves out.
 *
 * Run: cd server && node --test stores/automationStore/runTables.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const store = require('./runTables');

const pg = new PGlite();
const query = pgliteQuery(pg);
const db = {
    initDB: async () => {},
    run: query,
    getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await query(sql, params)).rows,
};
const COLS = [{ key: 'a', label: 'A', type: 'text' }];
const DAY = 86_400_000;
const T1 = `rtb_${'1'.repeat(32)}`;
const T2 = `rtb_${'2'.repeat(32)}`;
const T3 = `rtb_${'3'.repeat(32)}`;

// `rows` and `bytes` go in as the ledger's row count and stored size.
const record = (fields, rows, bytes) => {
    const rowCount = rows;
    const size = bytes;
    return store.recordRunTable({ ...fields, columns: COLS, rowCount, size }, db);
};

before(async () => {
    // The same columns as migrations/automation-run-tables-2026-10.js, without the foreign keys.
    await pg.exec(`
        CREATE TABLE automation_run_tables (
            id TEXT PRIMARY KEY, run_id TEXT, automation_id TEXT, step_id TEXT,
            storage_key TEXT NOT NULL, name TEXT NOT NULL, columns JSONB NOT NULL,
            row_count BIGINT NOT NULL DEFAULT 0, size_bytes BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
        );
    `);
    await record({ id: T1, runId: 'r1', automationId: 'a1', stepId: 's1', storageKey: 'k/1', name: 'One', ttlMs: 7 * DAY }, 3, 120);
    await record({ id: T2, runId: 'r2', automationId: 'a1', storageKey: 'k/2', name: 'Two', ttlMs: 7 * DAY }, 1, 10);
    await record({ id: T3, runId: 'r1', automationId: 'a1', storageKey: 'k/3', name: 'Gone', ttlMs: -DAY }, 0, 0);
});
after(async () => { await pg.close(); });

test('a row comes back with the documented fields', async () => {
    const row = await store.getRunTableForRuns(T1, ['r1'], db);
    assert.deepStrictEqual(Object.keys(row).sort(), ['automationId', 'columns', 'createdAt', 'expiresAt', 'id', 'name', 'rowCount', 'runId', 'size', 'stepId', 'storageKey']);
    assert.strictEqual(row.runId, 'r1');
    assert.strictEqual(row.stepId, 's1');
    assert.strictEqual(row.rowCount, 3);
    assert.strictEqual(row.size, 120);
    assert.deepStrictEqual(row.columns, COLS);
    assert.ok(new Date(row.expiresAt) > new Date());
});

test('getRunTableForRuns answers only for the runs given', async () => {
    assert.strictEqual(await store.getRunTableForRuns(T1, ['r2'], db), null);
    assert.strictEqual(await store.getRunTableForRuns(T1, [], db), null);
    assert.strictEqual(await store.getRunTableForRuns('', ['r1'], db), null);
    assert.strictEqual((await store.getRunTableForRuns(T2, ['r1', 'r2'], db)).name, 'Two');
});

test('an expired row reads as absent in every live read', async () => {
    assert.strictEqual(await store.getRunTableForRuns(T3, ['r1'], db), null);
    assert.strictEqual(await store.getRunTableForAutomation(T3, 'a1', db), null);
    assert.strictEqual(await store.countRunTablesForRun('r1', db), 1);
});

test('getRunTableForAutomation fences the id to one automation', async () => {
    assert.strictEqual((await store.getRunTableForAutomation(T2, 'a1', db)).id, T2);
    assert.strictEqual(await store.getRunTableForAutomation(T2, 'a2', db), null);
    assert.strictEqual(await store.getRunTableForAutomation(T2, '', db), null);
});

test('countRunTablesForRun counts live rows of one run', async () => {
    assert.strictEqual(await store.countRunTablesForRun('r2', db), 1);
    assert.strictEqual(await store.countRunTablesForRun('none', db), 0);
    assert.strictEqual(await store.countRunTablesForRun('', db), 0);
});

test('listLiveRunTableIdsForRuns lists the live tables of the given runs only', async () => {
    assert.deepStrictEqual((await store.listLiveRunTableIdsForRuns(['r1'], db)).sort(), [T1]);
    assert.deepStrictEqual((await store.listLiveRunTableIdsForRuns(['r1', 'r2'], db)).sort(), [T1, T2].sort());
    assert.deepStrictEqual(await store.listLiveRunTableIdsForRuns([], db), []);
    assert.deepStrictEqual(await store.listLiveRunTableIdsForRuns(['none'], db), []);
});

test('listExpiredRunTables lists only expired rows, oldest first, within the limit', async () => {
    const list = await store.listExpiredRunTables(200, db);
    assert.deepStrictEqual(list.map(r => r.id), [T3]);
    assert.deepStrictEqual(await store.listExpiredRunTables(0, db), []);
});

test('listExpiredRunTables also lists orphans, whose run or automation was deleted', async () => {
    const orphan = `rtb_${'4'.repeat(32)}`;
    const noAutomation = `rtb_${'5'.repeat(32)}`;
    await record({ id: orphan, runId: 'r9', automationId: 'a1', storageKey: 'k/4', name: 'Orphan', ttlMs: 60 * DAY }, 1, 1);
    await record({ id: noAutomation, runId: 'r9', automationId: 'a9', storageKey: 'k/5', name: 'Orphan 2', ttlMs: 60 * DAY }, 1, 1);
    await query('UPDATE automation_run_tables SET run_id = NULL WHERE id = $1', [orphan]);
    await query('UPDATE automation_run_tables SET automation_id = NULL WHERE id = $1', [noAutomation]);
    const ids = (await store.listExpiredRunTables(200, db)).map(r => r.id);
    assert.deepStrictEqual(ids.sort(), [T3, orphan, noAutomation].sort());
    // an orphan can never be read back, however long it has left
    assert.strictEqual(await store.getRunTableForRuns(orphan, ['r9'], db), null);
    assert.strictEqual(await store.getRunTableForAutomation(noAutomation, 'a9', db), null);
    await store.deleteRunTables([orphan, noAutomation], db);
});

test('extendRunTableExpiry moves the expiry out, never in, and ignores a null deadline', async () => {
    const before2 = (await store.getRunTableForRuns(T2, ['r2'], db)).expiresAt;
    assert.strictEqual(await store.extendRunTableExpiry([T2], new Date(Date.now() + DAY), db), 1);
    assert.strictEqual(new Date((await store.getRunTableForRuns(T2, ['r2'], db)).expiresAt).getTime(), new Date(before2).getTime());
    const later = new Date(Date.now() + 30 * DAY);
    await store.extendRunTableExpiry([T2], later, db);
    assert.strictEqual(new Date((await store.getRunTableForRuns(T2, ['r2'], db)).expiresAt).getTime(), later.getTime());
    assert.strictEqual(await store.extendRunTableExpiry([T2], null, db), 0);
    assert.strictEqual(await store.extendRunTableExpiry([], later, db), 0);
});

test('deleteRunTables removes the rows given', async () => {
    assert.strictEqual(await store.deleteRunTables([], db), 0);
    assert.strictEqual(await store.deleteRunTables([T3], db), 1);
    assert.deepStrictEqual(await store.listExpiredRunTables(200, db), []);
});
