/**
 * The read runner hands a dataset read's `params` to datasetCache.runDataset,
 * on the single read and in a batch, and passes on a refused value as a
 * per-read 400 (the runner itself decides nothing about parameters).
 *
 * Run: cd server && node --test appStudio/dataReadRunner.datasetParams.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const datasetCache = require('./datasetCache');
const studioAppDataStore = require('../stores/studioAppDataStore');
const dataReadRunner = require('./dataReadRunner');
const { readError } = require('./readError');

const MODEL = { tables: [{ id: 'tbl_t', key: 't', fields: [], access: { default: 'app' } }] };
const ctx = { app: { id: 'app-1', userId: 'owner-1' }, ownerScope: 'owner-1', model: MODEL, role: 'member', viewer: { id: 'u1', role: 'member' } };

const calls = [];
const realRun = datasetCache.runDataset;
const realGet = studioAppDataStore.getDataset;
test.before(() => {
    studioAppDataStore.getDataset = async (id) => ({ id, tableId: 'tbl_t', descriptor: {} });
    datasetCache.runDataset = async (app, model, ds, viewer, opts) => {
        calls.push(opts);
        if (opts.params && opts.params.bad) throw readError(400, 'Invalid value for dataset parameter "bad".');
        return { rows: [{ n: 1 }], columns: [], truncated: false, cached: false };
    };
});
test.after(() => { datasetCache.runDataset = realRun; studioAppDataStore.getDataset = realGet; });
test.beforeEach(() => { calls.length = 0; });

test('runSavedDataset passes params on', async () => {
    await dataReadRunner.runSavedDataset(ctx, 'ds-1', { params: { region: 'EU' } });
    await dataReadRunner.runSavedDataset(ctx, 'ds-1');
    assert.deepStrictEqual(calls, [{ refresh: false, params: { region: 'EU' } }, { refresh: false, params: undefined }]);
});

test('a batch dataset read carries its params; a refused value answers for that read alone', async () => {
    const results = await dataReadRunner.runBatch(ctx, [
        { id: 'r1', kind: 'dataset', datasetId: 'ds-1', params: { region: 'US' } },
        { id: 'r2', kind: 'dataset', datasetId: 'ds-1', params: { bad: 'x' } },
        { id: 'r3', kind: 'dataset', datasetId: 'ds-1' },
    ]);
    assert.deepStrictEqual(calls.map((c) => c.params), [{ region: 'US' }, { bad: 'x' }, undefined]);
    assert.strictEqual(results[0].ok, true);
    assert.deepStrictEqual(results[1], { id: 'r2', ok: false, status: 400, error: 'Invalid value for dataset parameter "bad".' });
    assert.strictEqual(results[2].ok, true);
});
