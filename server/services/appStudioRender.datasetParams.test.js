/**
 * The screenshot render and dataset parameters: a dataset binding's params
 * resolve against the render scope, reach the runner, and join the key exactly
 * as the browser's dataCacheKey writes it. A binding without params keeps the
 * `dataset:<id>` key.
 *
 * Run: cd server && node --test services/appStudioRender.datasetParams.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
const { _test } = require('./appStudioRender');

const OWNER = 'usr_owner01';
const APP = { id: 'app_1', userId: OWNER };

function defWith(binding) {
    return canonicalizeAppDefinition({
        meta: { name: 'Shot app' }, homeScreenId: 'scr_home01', theme: {},
        variables: [{ name: 'region', type: 'text', default: 'EU' }],
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_stat01', type: 'stat', props: { label: 'Total', value: binding } }] }],
        }],
        actions: {},
    }).def;
}

function args(def, runs) {
    return {
        definition: def, model: { tables: [] }, app: APP, screen: def.screens[0],
        roleArg: 'owner', viewer: { id: OWNER, role: 'owner' }, currentUser: { id: OWNER, name: 'Owner', email: null, roleKey: 'owner' },
        deps: {
            dbQuery: async () => ({ rows: [] }),
            getDataset: async (id) => ({ id, tableId: 'tbl_x', descriptor: {} }),
            runDataset: async (app, model, ds, viewer, opts) => { runs.push(opts); return { rows: [{ n: 3 }] }; },
        },
    };
}

test('dataset params resolve, reach the runner and join the key', async () => {
    const runs = [];
    const def = defWith({ kind: 'dataset', datasetId: 'ds_1', params: { region: { kind: 'formula', expr: 'vars.region' }, min: 5 } });
    const state = await _test.buildDataState(args(def, runs));
    assert.deepStrictEqual(Object.keys(state), ['dataset:ds_1:{"min":5,"region":"EU"}']);
    assert.deepStrictEqual(runs, [{ refresh: false, params: { region: 'EU', min: 5 } }]);
});

test('a binding without params keeps dataset:<id> and the old runner call', async () => {
    const runs = [];
    const state = await _test.buildDataState(args(defWith({ kind: 'dataset', datasetId: 'ds_1' }), runs));
    assert.deepStrictEqual(Object.keys(state), ['dataset:ds_1']);
    assert.deepStrictEqual(runs, [{ refresh: false }]);
    assert.strictEqual(_test.dataCacheKey({ kind: 'dataset', datasetId: 'ds_1', params: {} }), 'dataset:ds_1');
});

test('a param formula the render cannot resolve skips the binding', async () => {
    const runs = [];
    const def = defWith({ kind: 'dataset', datasetId: 'ds_1', params: { region: { kind: 'formula', expr: 'item.region' } } });
    const state = await _test.buildDataState(args(def, runs));
    assert.deepStrictEqual(state, {});
    assert.strictEqual(runs.length, 0);
});
