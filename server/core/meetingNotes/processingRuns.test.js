/**
 * The run tracker: a heartbeat on a timer while a meeting is processed, and
 * the list the shutdown fails at once.
 *
 * Run: cd server && node --test core/meetingNotes/processingRuns.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const runs = require('./processingRuns.mts');

function fakeStore({ held = true } = {}) {
    /** @type {{ beats: string[], failed: string[][] }} */
    const calls = { beats: [], failed: [] };
    return {
        calls,
        store: {
            heartbeatProcessing: async (id) => { calls.beats.push(id); return held; },
            failInterruptedRuns: async (ids) => { calls.failed.push(ids); return ids.length; },
        },
    };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('beats on a timer while tracked, not only between phases, and stops when told', async () => {
    const { calls, store } = fakeStore();
    const stop = runs.trackProcessing('n-beat', { intervalMs: 10, store });
    await tick(55);
    stop();
    const beats = calls.beats.length;
    assert.ok(beats >= 2, `expected several beats, got ${beats}`);
    await tick(30);
    assert.strictEqual(calls.beats.length, beats, 'no beat after stop()');
    assert.ok(!runs.inFlightIds().includes('n-beat'));
});

test('a lost claim stops the heartbeat', async () => {
    const { calls, store } = fakeStore({ held: false });
    const stop = runs.trackProcessing('n-lost', { intervalMs: 10, store });
    await tick(60);
    assert.strictEqual(calls.beats.length, 1, 'one beat found the claim gone, then quiet');
    stop();
});

test('a run that hangs past the cap stops beating so the reaper can reach it', async () => {
    const { calls, store } = fakeStore();
    let clock = 0;
    const stop = runs.trackProcessing('n-hang', { intervalMs: 10, maxMs: 100, store, now: () => clock });
    await tick(25);
    const before = calls.beats.length;
    clock = 1000;
    await tick(40);
    assert.strictEqual(calls.beats.length, before, 'no beat past the cap');
    assert.ok(runs.inFlightIds().includes('n-hang'), 'still on the shutdown list');
    stop();
});

test('failInFlight fails exactly the tracked runs, and does nothing without any', async () => {
    const { calls, store } = fakeStore();
    assert.strictEqual(await runs.failInFlight({ store }), 0);
    assert.deepStrictEqual(calls.failed, [], 'no database call with nothing in flight');

    const stopA = runs.trackProcessing('a', { store });
    const stopB = runs.trackProcessing('b', { store });
    stopB();
    assert.strictEqual(await runs.failInFlight({ store }), 1);
    assert.deepStrictEqual(calls.failed, [['a']]);
    stopA();
});

test('failInFlight is bounded by its time-out', async () => {
    const store = { heartbeatProcessing: async () => true, failInterruptedRuns: () => new Promise(() => {}) };
    const stop = runs.trackProcessing('slow', { store });
    const started = Date.now();
    // The time-out is unref'd (it must never hold the exit); the shutdown has
    // other handles open, a bare test does not.
    const keepAlive = setTimeout(() => {}, 1000);
    assert.strictEqual(await runs.failInFlight({ store, timeoutMs: 20 }), 0);
    clearTimeout(keepAlive);
    assert.ok(Date.now() - started < 1000);
    stop();
});
