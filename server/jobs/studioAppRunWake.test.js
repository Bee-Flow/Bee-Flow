'use strict';

/**
 * The wake job of runs on hold: one pass asks the runner to continue the due runs, its interval
 * is the operator's with a floor, its lock key is its own, and it mounts behind the apps gate.
 * What a pass does to a run is in appStudio/backgroundRun.durable.test.js.
 *
 * Run: cd server && node --test jobs/studioAppRunWake.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const job = require('./studioAppRunWake');

test('a pass continues the due runs and answers what it did', async () => {
    let calls = 0;
    const out = await job.wakePass(async () => { calls += 1; return { due: 3, resumed: 2 }; });
    assert.deepEqual(out, { due: 3, resumed: 2 });
    assert.equal(calls, 1);
});

test('the interval: 30 s by default, the operator\'s value, never under a second', () => {
    assert.equal(job.intervalMs({}), 30_000);
    assert.equal(job.intervalMs({ STUDIO_APP_RUN_WAKE_INTERVAL_MS: '5000' }), 5000);
    assert.equal(job.intervalMs({ STUDIO_APP_RUN_WAKE_INTERVAL_MS: '10' }), 1000);
    assert.equal(job.intervalMs({ STUDIO_APP_RUN_WAKE_INTERVAL_MS: 'soon' }), 30_000);
    assert.equal(job.intervalMs({ STUDIO_APP_RUN_WAKE_INTERVAL_MS: '0' }), 30_000);
});

test('its advisory lock key is 0xBEEF116', () => {
    assert.equal(job.LOCK_KEY, 0xBEEF116);
});

test('start mounts the tick behind the apps module gate, once', () => {
    const gated = [];
    const gate = (moduleId, tick, name) => { gated.push({ moduleId, name, tick: typeof tick }); return async () => {}; };
    const wake = async () => ({ due: 0, resumed: 0 });
    job.start({ gate, wake });
    job.start({ gate, wake });
    job.stop();
    assert.deepEqual(gated, [{ moduleId: 'apps', name: 'studioAppRunWake', tick: 'function' }]);
});
