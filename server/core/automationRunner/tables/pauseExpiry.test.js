'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extendJourneyTablesForPause, RESUME_MARGIN_MS } = require('./pauseExpiry');

function fakeStore(over = {}) {
    const calls = { extend: [], live: [] };
    return {
        calls,
        getRunsInChain: async () => [{ id: 'root' }, { id: 'leg2' }],
        listLiveRunTableIdsForRuns: async (ids) => { calls.live.push(ids); return ['t1', 't2']; },
        extendRunTableExpiry: async (ids, until) => { calls.extend.push({ ids, until }); return ids.length; },
        ...over,
    };
}

test('the live tables of the whole journey are pushed out to the pause deadline plus a margin', async () => {
    const store = fakeStore();
    const deadline = new Date('2030-01-31T10:00:00Z');
    const n = await extendJourneyTablesForPause(store, { id: 'leg2', rootRunId: 'root' }, deadline);
    assert.equal(n, 2);
    assert.deepEqual(store.calls.live[0].sort(), ['leg2', 'root']);
    assert.deepEqual(store.calls.extend[0].ids, ['t1', 't2']);
    assert.equal(store.calls.extend[0].until.getTime(), deadline.getTime() + RESUME_MARGIN_MS);
});

test('the run itself counts even when the chain does not list it yet', async () => {
    const store = fakeStore({ getRunsInChain: async () => [] });
    await extendJourneyTablesForPause(store, { id: 'solo' }, '2030-01-01T00:00:00Z');
    assert.deepEqual(store.calls.live[0], ['solo']);
});

test('no deadline, no tables, or a failing store: nothing extended and no throw', async () => {
    const a = fakeStore();
    assert.equal(await extendJourneyTablesForPause(a, { id: 'r' }, null), 0);
    assert.equal(a.calls.extend.length, 0);
    const b = fakeStore({ listLiveRunTableIdsForRuns: async () => [] });
    assert.equal(await extendJourneyTablesForPause(b, { id: 'r' }, '2030-01-01T00:00:00Z'), 0);
    assert.equal(b.calls.extend.length, 0);
    const c = fakeStore({ getRunsInChain: async () => { throw new Error('db down'); } });
    assert.equal(await extendJourneyTablesForPause(c, { id: 'r' }, '2030-01-01T00:00:00Z'), 0);
});
