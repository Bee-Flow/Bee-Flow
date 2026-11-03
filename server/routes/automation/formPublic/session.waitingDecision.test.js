'use strict';

/**
 * The visitor's poll while the journey waits on a person's decision (WI-12,
 * D4c): `waiting_decision`, never "working" (the page would spin and give up
 * after five minutes on a wait that can take days). It says whether the
 * visitor will be told when the next page is ready, and nothing about the gate
 * itself: no step, no approver, no prompt.
 *
 * And a test journey says so on EVERY answer (`test: true`), so a page
 * reloaded with ?s= keeps its Test banner without reading GET /form/:token.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 * Run: node --test routes/automation/formPublic/session.waitingDecision.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    PAGE_2, state, resetState, putRun, getSession, makeRes, makeReq, startSession, awaitingRun,
} = require('./formPublic.testkit');

beforeEach(resetState);

async function poll(sid) {
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    return res.body;
}

test('a run paused on an approval answers waiting_decision, and only that', async () => {
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();
    putRun('runA', 'awaiting_approval', { awaitingStepId: 'gate', steps: [{ stepId: 'gate', status: 'awaiting_approval', output: { prompt: 'Approve the quote for Ada?' } }] });
    const body = await poll(sid);
    assert.deepStrictEqual(body, { state: 'waiting_decision', notify: false });
});

test('notify is true when the journey knows who submitted it (they get the link)', async () => {
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();
    putRun('runA', 'awaiting_approval', { awaitingStepId: 'gate' }).submittedByUserId = 'visitor1';
    assert.deepStrictEqual(await poll(sid), { state: 'waiting_decision', notify: true });
});

test('a second approval later in the journey reads the submitter off the ROOT leg', async () => {
    state.runQueue = [{ id: 'root' }];
    const sid = await startSession();
    putRun('root', 'success').submittedByUserId = 'visitor1';
    putRun('leg2', 'awaiting_approval', { awaitingStepId: 'gate2', rootRunId: 'root' });
    assert.deepStrictEqual(await poll(sid), { state: 'waiting_decision', notify: true });
});

test('once the decision is made, the poll moves on to the next page', async () => {
    state.runQueue = [{ id: 'root' }];
    const sid = await startSession();
    putRun('root', 'awaiting_approval', { awaitingStepId: 'gate' });
    assert.strictEqual((await poll(sid)).state, 'waiting_decision');
    // The approval resumed the journey in a child leg, which paused on page 2.
    state.runs.get('root').status = 'success';
    awaitingRun('leg2', 'fp2', PAGE_2).rootRunId = 'root';
    const body = await poll(sid);
    assert.strictEqual(body.state, 'form');
    assert.strictEqual(body.form.title, 'Nearly there');
});

test('a test journey carries test: true on every answer; a production one never does', async () => {
    state.runQueue = [{ id: 'runT' }];
    const sid = await startSession();
    putRun('runT', 'running');
    assert.strictEqual((await poll(sid)).test, undefined, 'production: no flag');

    state.sessions.get(sid).isTest = true;
    assert.strictEqual((await poll(sid)).test, true, 'working');
    putRun('runT', 'awaiting_approval', { awaitingStepId: 'gate' });
    assert.strictEqual((await poll(sid)).test, true, 'waiting_decision');
    awaitingRun('runT', 'fp2', PAGE_2);
    assert.strictEqual((await poll(sid)).test, true, 'form');
    putRun('runT', 'success');
    assert.strictEqual((await poll(sid)).test, true, 'done');
    state.sessions.get(sid).expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.deepStrictEqual(await poll(sid), { state: 'expired', test: true });
});
