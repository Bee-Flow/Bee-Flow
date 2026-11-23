/**
 * What Cowork runs cost, as the routes hand it out (./coworkCosts.mts). The store is handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkCosts.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { withRunCosts, monthCostOf, monthStartOf } = require('./coworkCosts.mts');

const RUNS = [{ id: 'r1', status: 'success' }, { id: 'r2', status: 'success' }];

test('each run carries its own cost, asked for this item\'s runs; a run without one carries null', async () => {
    const asked = [];
    const store = { costsOfRuns: async (scheduleId, ids) => { asked.push([scheduleId, ids]); return { r1: { byCurrency: { EUR: 0.04 }, calls: 3 } }; } };
    const runs = await withRunCosts('cw-1', RUNS, store);
    assert.deepStrictEqual(runs.map((r) => [r.id, r.cost]), [['r1', { byCurrency: { EUR: 0.04 }, calls: 3 }], ['r2', null]]);
    assert.deepStrictEqual(asked, [['cw-1', ['r1', 'r2']]]);
});

test('a cost that cannot be read never fails the history: every run carries null', async () => {
    for (const store of [{}, { costsOfRuns: async () => { throw new Error('relation "automation_runs" does not exist'); } }, { costsOfRuns: () => { throw new Error('sync'); } }]) {
        assert.deepStrictEqual((await withRunCosts('cw-1', RUNS, store)).map((r) => r.cost), [null, null]);
    }
});

test('the month\'s cost is this item\'s own; a month without a call is a measured zero; unreadable is null', async () => {
    let since = null;
    const store = { costsSince: async (userId, from) => { since = from; return { total: { byCurrency: { EUR: 0.62 }, calls: 7 }, byItem: { 'cw-1': { byCurrency: { EUR: 0.5 }, calls: 5 } } }; } };
    const now = new Date(2026, 10, 23, 9, 30);
    assert.deepStrictEqual(await monthCostOf('u1', 'cw-1', store, now), { byCurrency: { EUR: 0.5 }, calls: 5 });
    assert.deepStrictEqual(since, new Date(2026, 10, 1));
    assert.deepStrictEqual(await monthCostOf('u1', 'cw-quiet', store, now), { byCurrency: {}, calls: 0 });
    assert.strictEqual(await monthCostOf('u1', 'cw-1', {}, now), null);
    assert.strictEqual(await monthCostOf('u1', 'cw-1', { costsSince: async () => { throw new Error('down'); } }, now), null);
    assert.deepStrictEqual(monthStartOf(new Date(2026, 0, 31, 23, 59)), new Date(2026, 0, 1));
});
