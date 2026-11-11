/**
 * The dry run of a dataset binding with params: values resolve against the
 * synthetic scope and reach the runner; a formula reading a root the dry run
 * cannot populate skips the binding as dynamic; no params, no change.
 *
 * Run: cd server && node --test appStudio/appDryRunReads.datasetParams.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runDatasetBinding, syntheticScope } = require('./appDryRunReads');

function deps(runs) {
    return {
        getDataset: async (id) => ({ id, tableId: 'tbl_x', descriptor: {} }),
        runDataset: async (app, model, ds, viewer, opts) => { runs.push(opts); return { rows: [{ n: 1 }, { n: 2 }] }; },
    };
}
const base = { dataModel: { tables: [] }, app: { id: 'a', userId: 'o' }, viewer: { id: 'o', role: 'owner' }, appId: 'a', ownerId: 'o' };
const scope = syntheticScope({ id: 'o' }, [{ name: 'region', type: 'text', default: 'EU' }]);

test('params resolve against the synthetic scope', async () => {
    const runs = [];
    const res = await runDatasetBinding({ kind: 'dataset', datasetId: 'd', params: { region: { kind: 'formula', expr: 'vars.region' }, n: 2 } }, { ...base, deps: deps(runs), scope });
    assert.deepStrictEqual(res, { ok: true, rowCount: 2 });
    assert.deepStrictEqual(runs, [{ refresh: true, params: { region: 'EU', n: 2 } }]);
});

test('a formula on a live-only root is skipped as dynamic', async () => {
    const runs = [];
    const res = await runDatasetBinding({ kind: 'dataset', datasetId: 'd', params: { r: { kind: 'formula', expr: 'item.region' } } }, { ...base, deps: deps(runs), scope });
    assert.deepStrictEqual(res, { ok: true, skipped: 'dynamic' });
    assert.strictEqual(runs.length, 0);
});

test('without params the runner is called as before', async () => {
    const runs = [];
    await runDatasetBinding({ kind: 'dataset', datasetId: 'd' }, { ...base, deps: deps(runs), scope });
    assert.deepStrictEqual(runs, [{ refresh: true }]);
});
