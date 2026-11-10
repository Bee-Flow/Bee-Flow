/**
 * putCache with `maxEntries` (a dataset with parameters) on a real Postgres
 * (PGlite): expired rows of the dataset are pruned first, and nothing is
 * written once the dataset holds that many live rows. Without `maxEntries`
 * the store behaves as it always did (the characterisation golden pins that).
 *
 * Run: cd server && node --test stores/studioAppData/datasets.paramCache.pg.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { installResolveStub } = require('../../testUtils/stubRequire');

const { pg } = pgliteDb();
const first = (r) => (r.rows && r.rows[0]) || null;
const restore = installResolveStub({
    '../../db': {
        run: (sql, params) => pg.query(sql, params),
        getOne: async (sql, params) => first(await pg.query(sql, params)),
        getAll: async (sql, params) => (await pg.query(sql, params)).rows,
        withTransaction: (fn) => pg.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) })),
    },
    './schema': { initDB: async () => {} },
});
const store = require('./datasets');

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
        CREATE UNIQUE INDEX uq_cache ON studio_app_dataset_cache(dataset_id, viewer_scope_key, params_hash);
    `);
});
test.after(async () => { restore(); await pg.close(); });

const put = (hash, extra = {}) => store.putCache('ds-1', { viewerScopeKey: 'v', paramsHash: hash, dataVersion: 1, result: { rows: [hash] }, rowCount: 1, ttlSeconds: 60, ...extra });
const count = async () => Number(first(await pg.query('SELECT COUNT(*) AS n FROM studio_app_dataset_cache WHERE dataset_id = $1', ['ds-1'])).n);

test('without maxEntries every value set is written', async () => {
    await pg.exec('DELETE FROM studio_app_dataset_cache');
    for (const h of ['a', 'b', 'c', 'd']) await put(h);
    assert.strictEqual(await count(), 4);
});

test('with maxEntries the dataset stops growing at the cap; a replaced tuple still writes', async () => {
    await pg.exec('DELETE FROM studio_app_dataset_cache');
    assert.deepStrictEqual((await put('a', { maxEntries: 2 })).ok, true);
    assert.deepStrictEqual((await put('b', { maxEntries: 2 })).ok, true);
    assert.deepStrictEqual(await put('c', { maxEntries: 2 }), { ok: false, full: true });
    assert.strictEqual(await count(), 2);
    assert.strictEqual((await put('a', { maxEntries: 2 })).ok, true, 'the same tuple replaces itself');
    assert.ok(await store.getCache('ds-1', 'v', 'a', 1));
    assert.strictEqual(await store.getCache('ds-1', 'v', 'c', 1), null);
});

test('expired rows are pruned before the count', async () => {
    await pg.exec('DELETE FROM studio_app_dataset_cache');
    await put('old1', { ttlSeconds: -5 });
    await put('old2', { ttlSeconds: -5 });
    await pg.query('INSERT INTO studio_app_dataset_cache (id, dataset_id, viewer_scope_key, params_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() - INTERVAL \'1 minute\')', ['other', 'ds-2', 'v', 'x']);
    assert.strictEqual((await put('fresh', { maxEntries: 2 })).ok, true);
    assert.strictEqual(await count(), 1, 'the two expired rows of ds-1 are gone');
    const other = first(await pg.query('SELECT COUNT(*) AS n FROM studio_app_dataset_cache WHERE dataset_id = $1', ['ds-2']));
    assert.strictEqual(Number(other.n), 1, 'another dataset is not touched');
});
