/**
 * A Cowork run as its agent, the scheduler side: it runs only when it claimed the schedule, the tick's claim asks for
 * a schedule that is still due, a claim that could not start is given back, and a run past its time limit is stopped
 * for real, through the signal the agent runtime takes.
 *
 * The collaborators are handed in (deps.services), as in agentScheduleRun.review.test.js: no module is mocked.
 *
 * Run: cd server && node --test core/cowork/agentScheduleRun.claim.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { executeAgentRun } = require('./agentScheduleRun');
const { fakeStore, fakeDeps } = require('./agentScheduleRun.testkit');

const task = { id: 's1', userId: 'u1', agentId: 'a1', title: 'Mail desk', prompt: 'Answer new mail.', conversationId: null, timezone: 'Europe/Amsterdam', repeatInterval: 'daily', nextRunAt: '2026-11-23T07:30:00.000Z' };

const names = (store) => store.calls.map((c) => c[0]);

/** The kit's deps, with what failed and what was notified collected in the given lists. */
const deps = ({ chat, failed = [], notes = [], organizationId = null, orgHasBetaFeature = undefined }) => fakeDeps({
    chat, organizationId,
    onFail: (err, opts) => { failed.push({ err, ...opts }); },
    onNote: (n) => { notes.push(n); },
    services: { orgHasBetaFeature },
});

const answers = (seen = {}) => async (agentId, userId, prompt, auth, onEvent, history, metadata) => {
    seen.calls = (seen.calls || 0) + 1;
    seen.metadata = metadata;
    return { message: 'Done.', conversationId: 'conv-1' };
};

test('a refused claim runs nothing: no agent turn, no outcome, no failure, no notification', async () => {
    const seen = {};
    const failed = [];
    const notes = [];
    const store = fakeStore(null);
    await executeAgentRun(task, { store, due: true }, deps({ chat: answers(seen), failed, notes }));
    assert.deepStrictEqual(names(store), ['markRunning']);
    assert.strictEqual(seen.calls, undefined, 'the agent runtime was never started');
    assert.deepStrictEqual(failed, []);
    assert.deepStrictEqual(notes, []);
});

test('the tick asks for a schedule that is still due; a run-now does not', async () => {
    const tick = fakeStore();
    await executeAgentRun(task, { store: tick, due: true }, deps({ chat: answers() }));
    assert.deepStrictEqual(tick.calls[0], ['markRunning', 's1', { triggerKind: 'schedule', due: true }]);

    const manual = fakeStore();
    await executeAgentRun(task, { store: manual, manual: true }, deps({ chat: answers() }));
    assert.deepStrictEqual(manual.calls[0], ['markRunning', 's1', { triggerKind: 'manual', due: false }]);
});

test('a store without history (it answers nothing, not null) still runs: only null refuses', async () => {
    const seen = {};
    const store = fakeStore(undefined);
    await executeAgentRun(task, { store, manual: true }, deps({ chat: answers(seen) }));
    assert.strictEqual(seen.calls, 1);
    assert.ok(names(store).includes('markCompleted'));
});

test('the agent turn gets the run\'s signal, and a turn that finishes in time is not touched by it', async () => {
    const seen = {};
    const store = fakeStore();
    await executeAgentRun(task, { store, manual: true, maxMs: 60_000 }, deps({ chat: answers(seen) }));
    assert.ok(seen.metadata.signal instanceof AbortSignal);
    assert.strictEqual(seen.metadata.signal.aborted, false);
    assert.ok(names(store).includes('markCompleted'));
});

test('a run past its time limit is stopped through the signal and fails with a reason the owner can read', async () => {
    const failed = [];
    const store = fakeStore();
    // The runtime's own behaviour on an aborted signal: it ends the turn with an abort error.
    const chat = (agentId, userId, prompt, auth, onEvent, history, metadata) => new Promise((resolve, reject) => {
        metadata.signal.addEventListener('abort', () => reject(Object.assign(new Error('Client disconnected before the turn finished'), { name: 'AbortError', _terminationLogged: true })));
    });
    // The deadline's timer never keeps a process alive on its own (a server has other reasons to live); here it is
    // the only thing pending, so the test holds the event loop open until the run is over.
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
        await executeAgentRun(task, { store, due: true, maxMs: 25 }, deps({ chat, failed }));
    } finally {
        clearTimeout(keepAlive);
    }
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].err.name, 'RunDeadlineError');
    assert.match(failed[0].err.message, /it took longer than a run may take/);
    assert.ok(!/Client disconnected/.test(failed[0].err.message), 'not the runtime\'s abort message');
    assert.ok(!names(store).includes('markCompleted'));
});

test('a failure before the limit keeps its own reason', async () => {
    const failed = [];
    const chat = async () => { throw new Error('The provider is unavailable'); };
    await executeAgentRun(task, { store: fakeStore(), manual: true, maxMs: 60_000 }, deps({ chat, failed }));
    assert.strictEqual(failed[0].err.message, 'The provider is unavailable');
});

test('when the feature service does not answer, the claim is given back so the next tick retries', async () => {
    const seen = {};
    const failed = [];
    const store = fakeStore('run-9');
    const down = async () => { throw Object.assign(new Error('feature service timed out'), { name: 'FeatureServiceUnavailableError' }); };
    await executeAgentRun(task, { store, due: true }, deps({ chat: answers(seen), failed, organizationId: 'org-1', orgHasBetaFeature: down }));
    assert.deepStrictEqual(store.calls.find((c) => c[0] === 'releaseRun'), ['releaseRun', 's1', 'run-9']);
    assert.strictEqual(seen.calls, undefined, 'nothing ran');
    assert.deepStrictEqual(failed, [], 'and it is nobody\'s failure');
    assert.ok(!names(store).includes('markError'));
});

test('a feature that is switched off still closes the run as an error, and gives nothing back', async () => {
    const store = fakeStore('run-9');
    await executeAgentRun(task, { store, due: true }, deps({ chat: answers(), organizationId: 'org-1', orgHasBetaFeature: async () => false }));
    assert.ok(names(store).includes('markError'));
    assert.ok(!names(store).includes('releaseRun'));
});
