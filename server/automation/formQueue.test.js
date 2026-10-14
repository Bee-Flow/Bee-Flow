'use strict';

/**
 * automation/formQueue.js: the lifecycle around the queue rather than the
 * routes (those are pinned in routes/automation/formPublic/*.test.js).
 *
 *   - shutdown takes nothing more off the queue and hands what is still waiting
 *     back with its lease lapsed, so another pod runs it at once;
 *   - work accepted during shutdown is persisted (and acked) but not started;
 *   - the sweep never runs work twice, gives up after MAX_RECOVERIES, and puts
 *     the page back up for a resume it gives up on;
 *   - a first submission that kept losing the cross-pod race goes back to the
 *     sweep instead of being dropped.
 *
 * Run: cd server && node --test automation/formQueue.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createFormQueue, MAX_RECOVERIES, RETRY_DELAYS_MS } = require('./formQueue');

let state;
function reset() {
    state = { sessions: new Map(), runs: new Map(), executions: [], resumes: [], released: [], gate: null, nextRuns: [], automation: { id: 'auto1', isActive: true, isDraft: false, definition: {} } };
}
reset();

const session = (id, extra = {}) => {
    const row = { id, automationId: 'auto1', runId: null, rootStepId: null, triggerHeaders: { form_page_id: 'tok' }, pendingWork: null, pendingAttempts: 0, leaseUntil: null, ...extra };
    state.sessions.set(id, row);
    return row;
};

// The store and the runner, injected through createFormQueue's seam.
const store = {
    setFormSessionPending: async (id, work, leaseMs) => {
        Object.assign(state.sessions.get(id), { pendingWork: JSON.parse(JSON.stringify(work)), pendingAttempts: 0, leaseUntil: Date.now() + leaseMs });
    },
    clearFormSessionPending: async (id) => { Object.assign(state.sessions.get(id), { pendingWork: null, pendingAttempts: 0, leaseUntil: null }); },
    renewFormSessionLeases: async () => {},
    releaseFormSessionLeases: async (ids, delayMs) => {
        state.released.push({ ids: [...ids], delayMs });
        for (const id of ids) state.sessions.get(id).leaseUntil = Date.now() + delayMs;
    },
    claimStaleFormSessionWork: async () => [...state.sessions.values()]
        .filter(r => r.pendingWork && (r.leaseUntil == null || r.leaseUntil < Date.now()))
        .map(r => { r.pendingAttempts += 1; r.leaseUntil = Date.now() + 120_000; return { ...r }; }),
    attachFormSessionRun: async (id, runId) => { state.sessions.get(id).runId = runId; },
    getAutomation: async () => state.automation,
    getRun: async (id) => (state.runs.has(id) ? { ...state.runs.get(id) } : null),
    updateRun: async (id, updates) => { if (state.runs.has(id)) Object.assign(state.runs.get(id), updates); return true; },
};
const runner = {
    executeAutomation: async (automation, opts) => {
        state.executions.push(opts);
        if (state.gate) await state.gate;
        return state.nextRuns.shift() || { id: `run${state.executions.length}` };
    },
    resumeFromStep: async (runId, stepId, opts) => {
        state.resumes.push({ runId, stepId, opts });
        return state.nextRuns.shift() || { id: `child${state.resumes.length}` };
    },
};

let formQueue;

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));
const submit = (id, payload = { email: 'a@b.nl' }) => formQueue.accept({
    automation: { id: 'auto1' }, session: state.sessions.get(id) || session(id), work: { kind: 'submit', payload, submitterId: null },
}, makeRes());

beforeEach(() => {
    reset();
    formQueue = createFormQueue({ store, runner, automationForRun: (stored) => ({ ...stored }) });
});

test('shutdown hands work still waiting back at once and starts nothing more', async () => {
    let release;
    state.gate = new Promise(r => { release = r; });
    await submit('s1');
    await submit('s2');
    await submit('s3');
    await flush();
    assert.strictEqual(state.executions.length, 1);

    const handedBack = await formQueue.stop();
    assert.strictEqual(handedBack, 2);
    assert.deepStrictEqual(state.released, [{ ids: ['s2', 's3'], delayMs: 0 }], 'released with no wait, for another pod to take');
    assert.ok(state.sessions.get('s2').pendingWork, 'the answers stay on the row until they have run');

    release();
    await flush();
    await flush();
    assert.strictEqual(state.executions.length, 1, 'nothing is started after the drain began');
    assert.strictEqual(state.sessions.get('s1').pendingWork, null, 'the one that was running finished normally');
    assert.strictEqual(await formQueue.recoverPending(), 0, 'a stopping pod does not claim work either');
});

test('work accepted during shutdown is persisted and acked, but left for another pod', async () => {
    await formQueue.stop();
    const res = makeRes();
    await formQueue.accept({ automation: { id: 'auto1' }, session: session('late'), work: { kind: 'submit', payload: { x: 1 }, submitterId: null } }, res, { sessionId: 'late' });
    await flush();
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { accepted: true, sessionId: 'late' });
    assert.ok(state.sessions.get('late').pendingWork);
    assert.ok(state.sessions.get('late').leaseUntil <= Date.now(), 'its lease is already lapsed');
    assert.strictEqual(state.executions.length, 0);
});

test('a persistence failure is a failure to accept: no 202, nothing queued', async () => {
    const original = store.setFormSessionPending;
    store.setFormSessionPending = async () => { throw new Error('db down'); };
    try {
        const res = makeRes();
        await assert.rejects(formQueue.accept({ automation: { id: 'auto1' }, session: session('x'), work: { kind: 'submit', payload: {} } }, res), /db down/);
        assert.strictEqual(res.body, null);
        await flush();
        assert.strictEqual(state.executions.length, 0);
        assert.strictEqual(formQueue._queues.size, 0);
    } finally {
        store.setFormSessionPending = original;
    }
});

test('the sweep gives up after MAX_RECOVERIES and puts a resumed page back up', async () => {
    state.runs.set('parent1', { id: 'parent1', status: 'awaiting_form', awaitingStepId: null });
    session('r1', {
        runId: 'parent1',
        pendingWork: { kind: 'resume', parentRunId: 'parent1', stepId: 'fp1', values: { a: 1 } },
        pendingAttempts: MAX_RECOVERIES,
    });
    assert.strictEqual(await formQueue.recoverPending(), 0);
    assert.strictEqual(state.resumes.length, 0);
    assert.strictEqual(state.sessions.get('r1').pendingWork, null);
    assert.strictEqual(state.runs.get('parent1').awaitingStepId, 'fp1', 'the visitor can answer again');
});

test('the sweep does not resume a run that is no longer waiting for this answer', async () => {
    state.runs.set('parent2', { id: 'parent2', status: 'error' });
    session('r2', { runId: 'parent2', pendingWork: { kind: 'resume', parentRunId: 'parent2', stepId: 'fp1', values: {} } });
    // …nor one whose child already exists.
    state.runs.set('parent3', { id: 'parent3', status: 'awaiting_form' });
    session('r3', { runId: 'child3', pendingWork: { kind: 'resume', parentRunId: 'parent3', stepId: 'fp1', values: {} } });
    assert.strictEqual(await formQueue.recoverPending(), 0);
    assert.strictEqual(state.resumes.length, 0);
    assert.strictEqual(state.sessions.get('r2').pendingWork, null);
    assert.strictEqual(state.sessions.get('r3').pendingWork, null);
});

test('the sweep reruns a submission whose only run lost the cross-pod race', async () => {
    state.runs.set('lost', { id: 'lost', status: 'cancelled', error: 'Skipped: automation already running' });
    session('s9', { runId: 'lost', pendingWork: { kind: 'submit', payload: { email: 'c@d.nl' }, submitterId: null } });
    assert.strictEqual(await formQueue.recoverPending(), 1);
    await flush();
    await flush();
    assert.strictEqual(state.executions.length, 1);
    assert.strictEqual(state.executions[0].triggerPayload.email, 'c@d.nl');
    assert.strictEqual(state.sessions.get('s9').runId, 'run1');
});

test('a closed form runs nothing on recovery', async () => {
    state.automation = { ...state.automation, isActive: false };
    session('s8', { pendingWork: { kind: 'submit', payload: {}, submitterId: null } });
    assert.strictEqual(await formQueue.recoverPending(), 0);
    assert.strictEqual(state.executions.length, 0);
    assert.strictEqual(state.sessions.get('s8').pendingWork, null);
});

test('a first submission that kept losing the race goes back to the sweep instead of being dropped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lost = { status: 'cancelled', error: 'Skipped: automation already running' };
    state.nextRuns = RETRY_DELAYS_MS.map((_, i) => ({ id: `l${i}`, ...lost })).concat([{ id: 'lLast', ...lost }]);
    await submit('s7');
    for (const ms of RETRY_DELAYS_MS) {
        await flush();
        t.mock.timers.tick(ms);
    }
    await flush();
    await flush();
    assert.strictEqual(state.executions.length, RETRY_DELAYS_MS.length + 1);
    assert.ok(state.sessions.get('s7').pendingWork, 'the answers are still there');
    assert.strictEqual(state.released.at(-1).ids[0], 's7', 'handed back to the sweep for a later try');
    assert.ok(state.released.at(-1).delayMs > 0, 'after a pause, not straight into the same collision');
});
