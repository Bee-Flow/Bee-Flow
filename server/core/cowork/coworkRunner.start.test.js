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

test('while the organisation has made Cowork read-only, a start runs nothing: the run closes as failed, with the reason', async () => {
    const item = { id: 's2', userId: 'u1', title: 'Supplier radar', prompt: 'Summarise.', repeatInterval: 'hourly', nextRunAt: new Date().toISOString() };
    mock.method(coworkStore, 'markRunning', async () => 'run-ro');
    /** @type {unknown[]} */
    const errors = [];
    mock.method(coworkStore, 'markError', async (/** @type {string} */ _id, /** @type {string} */ message, /** @type {unknown} */ close) => { errors.push([message, close]); });
    mock.method(coworkStore, 'advanceSchedule', async () => null);
    mock.method(coworkStore, 'getSchedule', async () => item);
    const readOnly = async () => ({ ceiling: /** @type {const} */ ('on_its_own'), readOnly: true, unattendedApps: null, monthlyBudget: null });
    await runner.executeCowork(item, { due: true }, { policyOf: readOnly });
    assert.equal(errors.length, 1);
    assert.match(String(/** @type {any[]} */ (errors[0])[0]), /read-only/);
});

test('the apps the organisation lets run while nobody watches travel with the run, so no runner reads the policy again', async () => {
    const item = { id: 's3', userId: 'u1', title: 'Mail desk', prompt: 'Answer.', repeatInterval: 'hourly', nextRunAt: new Date().toISOString() };
    /** @type {any[]} */
    const started = [];
    const policyOf = async () => ({ ceiling: /** @type {const} */ ('on_its_own'), readOnly: false, unattendedApps: ['gmail'], monthlyBudget: null });
    await runner.executeCowork(item, { manual: true }, { policyOf, budgetRefusal: async () => null, orgRefusal: async () => null, executeTask: /** @type {any} */ (async (/** @type {any} */ task) => { started.push(task); }) });
    assert.deepEqual(started.map((t) => [t.id, t.unattendedApps]), [['s3', ['gmail']]]);
});

test('a follow-up after a review is refused like any start: by a read-only organisation and by a spent budget, closing its own row', async () => {
    const item = { id: 's4', userId: 'u1', title: 'Mail desk', prompt: 'Answer.', repeatInterval: 'hourly', nextRunAt: new Date().toISOString() };
    /** @type {any[]} */
    const errors = [];
    mock.method(coworkStore, 'markError', async (/** @type {string} */ _id, /** @type {string} */ message, /** @type {unknown} */ close) => { errors.push([message, close]); });
    mock.method(coworkStore, 'markRunning', async () => { throw new Error('a follow-up holds its own row and claims none'); });
    mock.method(coworkStore, 'advanceSchedule', async () => null);
    mock.method(coworkStore, 'getSchedule', async () => item);
    /** @type {any[]} */
    const started = [];
    const executeTask = /** @type {any} */ (async (/** @type {any} */ task) => { started.push(task); });
    const open = async () => ({ ceiling: /** @type {const} */ ('on_its_own'), readOnly: false, unattendedApps: null, monthlyBudget: null });
    const readOnly = async () => ({ ceiling: /** @type {const} */ ('on_its_own'), readOnly: true, unattendedApps: null, monthlyBudget: null });
    await runner.executeCowork(item, { trigger: { runId: 'follow-1' } }, { policyOf: readOnly, budgetRefusal: async () => null, executeTask });
    await runner.executeCowork(item, { trigger: { runId: 'follow-2' } }, { policyOf: open, orgRefusal: async () => null, budgetRefusal: async () => 'This cowork reached its monthly budget.', executeTask });
    assert.equal(started.length, 0, 'nothing ran');
    assert.match(String(errors[0][0]), /read-only/);
    assert.deepEqual(errors[0][1].runId, 'follow-1');
    assert.match(String(errors[1][0]), /monthly budget/);
    assert.deepEqual(errors[1][1].runId, 'follow-2');
});

test('over the organisation\'s budget: the first due run of an item fails with the reason, a later due moment moves on quietly, a run by hand always says why', async () => {
    const item = { id: 's5', userId: 'u1', title: 'Digest', prompt: 'Summarise.', repeatInterval: 'hourly', nextRunAt: new Date().toISOString() };
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const advanced = [];
    mock.method(coworkStore, 'markRunning', async () => 'run-org');
    mock.method(coworkStore, 'markError', async (/** @type {string} */ _id, /** @type {string} */ message) => { errors.push(String(message)); });
    mock.method(coworkStore, 'advanceSchedule', async (/** @type {string} */ id) => { advanced.push(id); return null; });
    mock.method(coworkStore, 'getSchedule', async () => item);
    /** @type {any[]} */
    const started = [];
    const executeTask = /** @type {any} */ (async (/** @type {any} */ task) => { started.push(task); });
    const open = async () => ({ ceiling: /** @type {const} */ ('on_its_own'), readOnly: false, unattendedApps: null, monthlyBudget: 50 });
    const reason = "Your organisation's Cowork budget of €50.00 for this month is used up";
    let quiet = false;
    const orgRefusal = async () => ({ reason, quiet });
    await runner.executeCowork(item, { due: true }, { policyOf: open, orgRefusal, budgetRefusal: async () => null, executeTask });
    quiet = true;
    await runner.executeCowork(item, { due: true }, { policyOf: open, orgRefusal, budgetRefusal: async () => null, executeTask });
    await runner.executeCowork(item, { manual: true }, { policyOf: open, orgRefusal, budgetRefusal: async () => null, executeTask });
    assert.equal(started.length, 0, 'nothing ran');
    assert.equal(errors.length, 2, 'the first due run and the run by hand fail with the reason; the quiet one writes nothing');
    assert.ok(errors.every((m) => m.includes('budget of €50.00')));
    assert.ok(advanced.length >= 2, 'both due moments moved on');
});
