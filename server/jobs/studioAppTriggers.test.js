'use strict';

/**
 * The job that fires App Studio triggers: one pass runs the feature's pass, its interval is the
 * operator's with a floor, its lock key is its own, and it mounts behind the apps gate. What a
 * pass does to a trigger is in appStudio/triggers/triggerFire.test.js.
 *
 * Run: cd server && node --test jobs/studioAppTriggers.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const job = require('./studioAppTriggers');
const wake = require('./studioAppRunWake');

test('a pass runs the feature\'s pass and answers what it did', async () => {
    let calls = 0;
    const done = { settled: 1, due: 3, fired: 2, skipped: 1, disarmed: 0 };
    assert.deepEqual(await job.firePass(async () => { calls += 1; return done; }), done);
    assert.equal(calls, 1);
});

test('the interval: 30 s by default, the operator\'s value, never under a second', () => {
    assert.equal(job.intervalMs({}), 30_000);
    assert.equal(job.intervalMs({ STUDIO_APP_TRIGGER_INTERVAL_MS: '5000' }), 5000);
    assert.equal(job.intervalMs({ STUDIO_APP_TRIGGER_INTERVAL_MS: '10' }), 1000);
    assert.equal(job.intervalMs({ STUDIO_APP_TRIGGER_INTERVAL_MS: 'often' }), 30_000);
});

test('its advisory lock key is its own', () => {
    assert.equal(job.LOCK_KEY, 0xBEEF117);
    assert.notEqual(job.LOCK_KEY, wake.LOCK_KEY);
});

test('start mounts the tick behind the apps module gate, once', () => {
    const gated = [];
    const gate = (moduleId, tick, name) => { gated.push({ moduleId, name, tick: typeof tick }); return async () => {}; };
    const pass = async () => ({ settled: 0, due: 0, fired: 0, skipped: 0, disarmed: 0 });
    job.start({ gate, pass });
    job.start({ gate, pass });
    job.stop();
    assert.deepEqual(gated, [{ moduleId: 'apps', name: 'studioAppTriggers', tick: 'function' }]);
});
