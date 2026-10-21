'use strict';

/**
 * The typical-duration hint on the public poll: every `working` answer carries
 * `typicalSeconds` once the automation has at least three recent legs, and no
 * other state ever does.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/session.typicalDuration.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PAGE_2, state, resetState, putRun, getSession, makeRes, makeReq, startSession, awaitingRun } = require('./formPublic.testkit');
const { _resetForTests } = require('../../../automation/formTypicalDuration');

// The testkit's store mock has no history reads (its file is at its size ceiling),
// so this file adds the one it needs onto the same mock object.
const legDurations = {};
require('../../../stores/automationStore').recentLegDurations = async (id) => legDurations[id] || [];

beforeEach(() => {
    resetState();
    _resetForTests();
    for (const k of Object.keys(legDurations)) delete legDurations[k];
});

async function poll(sid) {
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    return res.body;
}

test('a working answer carries the median of the recent legs, in seconds', async () => {
    legDurations.auto1 = [2000, 4000, 9000];
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();
    putRun('runA', 'running');
    const body = await poll(sid);
    assert.strictEqual(body.state, 'working');
    assert.strictEqual(body.typicalSeconds, 4);
});

test('every working branch carries it: no run row yet, queued, approval gate, lost race', async () => {
    legDurations.auto1 = [5000, 5000, 5000];
    const sid = await startSession();
    // The session has no run yet.
    state.sessions.get(sid).runId = null;
    assert.strictEqual((await poll(sid)).typicalSeconds, 5);
    // The run row is not written yet.
    state.sessions.get(sid).runId = 'ghost';
    assert.strictEqual((await poll(sid)).typicalSeconds, 5);
    // Queued and behind an approval gate.
    state.sessions.get(sid).runId = 'run1';
    putRun('run1', 'queued');
    assert.strictEqual((await poll(sid)).typicalSeconds, 5);
    putRun('run1', 'awaiting_approval');
    assert.strictEqual((await poll(sid)).typicalSeconds, 5);
    // Lost to the per-automation concurrency check.
    putRun('run1', 'cancelled').error = 'Skipped: automation already running';
    const body = await poll(sid);
    assert.strictEqual(body.state, 'working');
    assert.strictEqual(body.typicalSeconds, 5);
});

test('fewer than three samples: no field at all', async () => {
    legDurations.auto1 = [5000, 6000];
    const sid = await startSession();
    putRun('run1', 'running');
    const body = await poll(sid);
    assert.strictEqual(body.state, 'working');
    assert.ok(!('typicalSeconds' in body));
});

test('a form, a done answer and an error never carry it', async () => {
    legDurations.auto1 = [5000, 5000, 5000];
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();

    awaitingRun('runA', 'fp1', PAGE_2);
    let body = await poll(sid);
    assert.strictEqual(body.state, 'form');
    assert.ok(!('typicalSeconds' in body));

    putRun('runA', 'success', { steps: [] });
    body = await poll(sid);
    assert.strictEqual(body.state, 'done');
    assert.ok(!('typicalSeconds' in body));

    putRun('runA', 'error', { steps: [] });
    body = await poll(sid);
    assert.strictEqual(body.state, 'error');
    assert.ok(!('typicalSeconds' in body));
});

test('a store failure leaves the poll working, without the field', async () => {
    const sid = await startSession();
    putRun('run1', 'running');
    const store = require('../../../stores/automationStore');
    const original = store.recentLegDurations;
    store.recentLegDurations = async () => { throw new Error('db down'); };
    try {
        const body = await poll(sid);
        assert.strictEqual(body.state, 'working');
        assert.ok(!('typicalSeconds' in body));
    } finally {
        store.recentLegDurations = original;
    }
});
