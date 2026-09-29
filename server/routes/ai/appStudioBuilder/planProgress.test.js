const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAppPlanProgress } = require('./planProgress');

const PLAN = [
    { text: 'Kies een thema en noem de app Facturen', done: false },
    { text: 'Koppel de tabel Facturen', done: false },
    { text: 'Vier tegels met totalen', done: false },
    { text: 'Grafiek totaal per maand', done: false },
    { text: 'Tabel met alle facturen en een filterbalk', done: false },
    { text: 'Detailscherm per factuur', done: false },
    { text: 'App afronden', done: false },
];

test('the Facturen build ticks item by item — in Dutch', () => {
    assert.deepEqual(inferAppPlanProgress(PLAN, { name: 'app_set_theme', args: { preset: 'cloud' }, result: { theme: {} } }), [0]);
    assert.deepEqual(inferAppPlanProgress(PLAN, { name: 'app_link_datatable', args: { name: 'Facturen' }, result: { table: { id: 'tbl_1', key: 'facturen', name: 'Facturen' } } }), [1]);
    assert.deepEqual(inferAppPlanProgress(PLAN, {
        name: 'app_add_components', args: {},
        result: { added: [{ id: 'c1', type: 'stat', label: 'Totaal excl. btw' }, { id: 'c2', type: 'chart', label: 'Totaal per maand' }] },
    }), [2, 3], 'stat → tegels/totalen, chart → grafiek/maand');
    assert.deepEqual(inferAppPlanProgress(PLAN, {
        name: 'app_add_components', args: {},
        result: { added: [{ id: 'c3', type: 'data_grid', label: 'Facturen' }, { id: 'c4', type: 'filter_bar', label: null }] },
    }), [4]);
    assert.deepEqual(inferAppPlanProgress(PLAN, { name: 'app_add_screen', args: { name: 'Factuur detail' }, result: { screenId: 's2' } }), [5]);
    assert.deepEqual(inferAppPlanProgress(PLAN, { name: 'app_finalize', args: {}, result: { finalized: true } }), [0, 1, 2, 3, 4, 5, 6]);
});

test('one shared word is not a match, done items and rejected calls tick nothing, never un-ticks', () => {
    const plan = [{ text: 'Add the orders table', done: false }, { text: 'Add a customers screen', done: false }];
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_add_screen', args: { name: 'Settings' }, result: { screenId: 's1' } }), [], '"screen" alone does not tick the customers screen');
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_add_screen', args: { name: 'Customers' }, result: { screenId: 's1' } }), [1]);
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_upsert_table', args: { key: 'orders' }, result: { error: 'nope' } }), []);
    const done = plan.map(t => ({ ...t, done: true }));
    assert.deepEqual(inferAppPlanProgress(done, { name: 'app_finalize', args: {}, result: { finalized: true } }), []);
    assert.deepEqual(inferAppPlanProgress([], { name: 'app_finalize', args: {}, result: { finalized: true } }), []);
    assert.deepEqual(inferAppPlanProgress(null, {}), []);
});

test('English plans tick too, and an action item ticks on a configured action', () => {
    const plan = [{ text: 'Pick a look for the app', done: false }, { text: 'Link the Facturen table', done: false }, { text: 'Wire the open-detail button', done: false }];
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_set_theme', args: {}, result: { ok: true } }), [0]);
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_link_datatable', args: { name: 'facturen' }, result: { table: { name: 'Facturen', key: 'facturen' } } }), [1]);
    assert.deepEqual(inferAppPlanProgress(plan, { name: 'app_set_action', args: { action: { kind: 'navigate', name: 'Open detail' } }, result: { actionId: 'act_1' } }), [2]);
});
