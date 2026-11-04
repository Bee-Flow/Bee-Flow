'use strict';

/**
 * The stale-run sweep job: one pass marks background rows nobody beats any more
 * interrupted, with the policy's stale window and a bounded batch; its lock key is its own.
 *
 * Run: cd server && node --test jobs/studioAppActionRuns.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const job = require('./studioAppActionRuns');

test('a pass sweeps with the policy stale window and a bounded batch', async () => {
    const calls = [];
    const store = { markStaleInterrupted: async (staleMs, limit) => { calls.push({ staleMs, limit }); return 2; } };
    assert.equal(await job.sweepStaleRuns({ store }), 2);
    assert.deepEqual(calls, [{ staleMs: 90_000, limit: job.PER_TICK }]);
    await job.sweepStaleRuns({ store, staleMs: 5000 });
    assert.equal(calls[1].staleMs, 5000);
});

test('its advisory lock key is 0xBEEF114', () => {
    assert.equal(job.LOCK_KEY, 0xBEEF114);
});
