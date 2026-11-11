/**
 * The AI builder and dataset parameters: app_upsert_dataset refuses a bad
 * declaration before anything is saved, its schema offers `params`, and the
 * data block names a dataset's params only when it declares some.
 *
 * Run: cd server && node --test appStudio/builderTools/datasetParamsTool.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('../builderTools');
const { renderDataBlock } = require('../builderPrompt');

const MODEL = { tables: [{ id: 'tbl_tasks1', key: 'tasks', name: 'Tasks', fields: [{ key: 'region', type: 'text' }], access: { default: 'app' } }] };

test('app_upsert_dataset refuses a bad params declaration before saving', async () => {
    const wrap = { userId: 'u1', appId: null, dataModel: MODEL, datasetIds: [], rowCounts: {} };
    const r = await applyToolCall('app_upsert_dataset', {
        name: 'By region', tableId: 'tbl_tasks1',
        descriptor: { aggregates: [{ fn: 'count', as: 'n' }], params: [{ name: 'r' }], filters: [{ field: 'region', op: 'eq', value: { param: 'zone' } }] },
    }, wrap);
    assert.ok(r.error && r.error.includes('"zone"'), JSON.stringify(r));
    assert.ok(r._fixHint.includes('{ param: "<name>" }'));
    assert.strictEqual(wrap.appId, null, 'nothing was persisted');
});

test('the app_upsert_dataset and app_query_data schemas accept params', () => {
    const fn = (name) => TOOL_SCHEMAS.find((t) => t.function.name === name).function;
    const upsert = fn('app_upsert_dataset');
    assert.strictEqual(upsert.parameters.properties.descriptor.properties.params.type, 'array');
    assert.ok(upsert.parameters.properties.descriptor.description.includes('{ param: "<name>" }'));
    assert.strictEqual(fn('app_query_data').parameters.properties.params.type, 'object');
});

test('the data block lists params only for a dataset that declares them', () => {
    const plain = renderDataBlock(MODEL, [{ id: 'ds_a', name: 'All' }], {});
    const withParams = renderDataBlock(MODEL, [{ id: 'ds_a', name: 'All' }, { id: 'ds_b', name: 'By region', params: ['region', 'since'] }], {});
    assert.ok(!plain.includes('params='));
    assert.ok(withParams.includes('ds_b "By region" params=region|since'), withParams);
    assert.ok(withParams.includes('ds_a "All",'), 'a dataset without params prints as before');
});
