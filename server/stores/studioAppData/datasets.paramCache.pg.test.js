/**
 * The cache cap of a dataset with parameters, on a real Postgres (PGlite):
 * roomForParamCacheRow (the step putCache runs when it is given `maxEntries`)
 * drops the dataset's expired rows first and then answers whether it holds
 * fewer than the cap. Without `maxEntries` putCache never runs it (the
 * characterisation golden pins that trace).
 *
 * Run: cd server && node --test stores/studioAppData/datasets.paramCache.pg.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { roomForParamCacheRow } = require('./datasets');

const { pg, db } = pgliteDb();

test.before(async () => {
    await pg.exec(`
        CREATE TABLE studio_app_dataset_cache (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            viewer_scope_key TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            data_version INTEGER NOT NULL DEFAULT 0,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_count INTEGER NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        );
    `);
});
test.after(async () => { await pg.close(); });

let n = 0;
const add = (datasetId, minutes) => pg.query(
    `INSERT INTO studio_app_dataset_cache (id, dataset_id, viewer_scope_key, params_hash, expires_at) VALUES ($1, $2, 'v', $1, NOW() + ($3 || ' minutes')::interval)`,
    [`c${++n}`, datasetId, String(minutes)],
);
const count = async (datasetId) => Number((await pg.query('SELECT COUNT(*) AS n FROM studio_app_dataset_cache WHERE dataset_id = $1', [datasetId])).rows[0].n);
const room = (datasetId, max) => db.tx((client) => roomForParamCacheRow(client, datasetId, max));

test('room until the dataset holds maxEntries live rows', async () => {
    await pg.exec('DELETE FROM studio_app_dataset_cache');
    assert.strictEqual(await room('ds-1', 2), true);
    await add('ds-1', 5);
    assert.strictEqual(await room('ds-1', 2), true);
    await add('ds-1', 5);
    assert.strictEqual(await room('ds-1', 2), false);
    assert.strictEqual(await count('ds-1'), 2, 'live rows are kept');
});

test('expired rows of the dataset are dropped before the count; another dataset is untouched', async () => {
    await pg.exec('DELETE FROM studio_app_dataset_cache');
    await add('ds-1', -1);
    await add('ds-1', -1);
    await add('ds-1', 5);
    await add('ds-2', -1);
    assert.strictEqual(await room('ds-1', 2), true);
    assert.strictEqual(await count('ds-1'), 1);
    assert.strictEqual(await count('ds-2'), 1);
});
