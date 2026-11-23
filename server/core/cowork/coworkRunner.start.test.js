// @typecheck strict
/**
 * The cowork scheduler tick and its retention sweep run once boot calls start(),
 * not because the runner was required: the cowork routes require it for
 * executeCowork, and so does every script, generator and test that loads the app.
 * The store is the real module with its functions replaced per test.
 *
 * Run: node --test core/cowork/coworkRunner.start.test.js
 */

process.env.NODE_ENV = 'test';

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { useMockedTimers } = require('../../testUtils/mockedTimers');

// Before the runner loads: a timer it armed at require time would fire in the first test.
const timers = useMockedTimers();
const coworkStore = require('../../stores/coworkStore');
const runner = require('./coworkRunner');

const HOUR_MS = 60 * 60_000;
/** What the timers called, in order. */
/** @type {string[]} */
let calls = [];

beforeEach(() => {
    calls = [];
    mock.method(coworkStore, 'reapStaleRuns', async () => { calls.push('reap'); return 0; });
    mock.method(coworkStore, 'getDueSchedules', async () => { calls.push('due'); return []; });
    mock.method(coworkStore, 'deleteRunsOlderThan', async () => { calls.push('retention'); return 0; });
});

afterEach(() => {
    mock.restoreAll();
    runner.stop();
});

test('requiring the runner starts no tick and no retention sweep', async () => {
    await timers.advance(3 * HOUR_MS);
    assert.deepEqual(calls, []);
});

test('start() sweeps the due schedules after 10 s, prunes after 30 s, then ticks every minute', async () => {
    assert.equal(runner.start(), true);

    await timers.advance(9_999);
    assert.deepEqual(calls, []);

    await timers.advance(1);
    assert.deepEqual(calls, ['reap', 'due'], 'the first due-sweep, 10 s after the start');

    await timers.advance(20_000);
    assert.deepEqual(calls, ['reap', 'due', 'retention'], 'the first retention pass, 30 s after the start');

    await timers.advance(30_000);
    assert.deepEqual(calls, ['reap', 'due', 'retention', 'reap', 'due'], 'the 60 s tick');
});

test('start() is idempotent: a second call arms nothing', async () => {
    assert.equal(runner.start(), true);
    assert.equal(runner.start(), false);

    await timers.advance(10_000);
    assert.deepEqual(calls, ['reap', 'due'], 'one sweep, not one per call');
});

test('stop() calls every timer off, and start() arms them again', async () => {
    runner.start();
    runner.stop();
    await timers.advance(3 * HOUR_MS);
    assert.deepEqual(calls, []);

    assert.equal(runner.start(), true);
    await timers.advance(10_000);
    assert.deepEqual(calls, ['reap', 'due']);
});

test('the tick claims each due item as a due claim, and an item another replica claimed first runs nothing here', async () => {
    /** @type {unknown[]} */
    const asked = [];
    const due = { id: 's1', userId: 'u1', title: 'Supplier radar', prompt: 'Summarise.', repeatInterval: 'hourly', nextRunAt: new Date().toISOString() };
    mock.method(coworkStore, 'getDueSchedules', async () => [due]);
    // null: the other replica that read the same due row holds it.
    mock.method(coworkStore, 'markRunning', async (/** @type {string} */ id, /** @type {unknown} */ opts) => { asked.push([id, opts]); return null; });
    const completed = mock.method(coworkStore, 'markCompleted', async () => {});
    const failed = mock.method(coworkStore, 'markError', async () => {});
    const advanced = mock.method(coworkStore, 'advanceSchedule', async () => null);

    await runner.processDueCowork();

    assert.deepEqual(asked, [['s1', { triggerKind: 'schedule', due: true }]]);
    assert.equal(completed.mock.callCount() + failed.mock.callCount() + advanced.mock.callCount(), 0, 'nothing is written for a run that never started');
});

test('the reaper waits ten minutes longer than a run may take, and never less than thirty', async () => {
    /** @type {unknown[]} */
    const windows = [];
    mock.method(coworkStore, 'reapStaleRuns', async (/** @type {unknown} */ opts) => { windows.push(opts); return 0; });

    await runner.processDueCowork();
    process.env.COWORK_RUN_MAX_MINUTES = '45';
    try {
        await runner.processDueCowork();
    } finally {
        delete process.env.COWORK_RUN_MAX_MINUTES;
    }

    assert.deepEqual(windows, [{ olderThanMs: 30 * 60_000 }, { olderThanMs: 55 * 60_000 }]);
});
