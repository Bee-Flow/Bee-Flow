/**
 * A plan run that waited for its owner's decision, followed to its end (./planRunFollowUp.mts): closed once, on the
 * engine's event or by the sweep, and the owner told when the plan does not tell them itself. Everything it reaches
 * is handed in, so nothing is mocked.
 *
 * Run: cd server && node --test core/cowork/planRunFollowUp.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { onRunEnd, sweepWaiting, start, stop } = require('./planRunFollowUp.mts');
const { planOf, supplierRadar } = require('./plan/plan.testkit');

const PLAN = { runId: 'cw-run-1', userId: 'u1', title: 'Supplier radar', scheduleId: 's1', definition: supplierRadar() };

function world({ plan = PLAN, waiting = true, legs = {}, waitingRuns = [], steps = {} } = {}) {
    const seen = { closed: [], notes: [] };
    let open = waiting;
    const handlers = new Map();
    const deps = {
        getPlanOfAutomationRun: async (id) => (id === 'leg-1' ? plan : null),
        closeWaitingRun: async (runId, end) => { if (!open) return false; open = false; seen.closed.push([runId, end]); return true; },
        listWaitingRuns: async (limit, after) => {
            const start = after ? waitingRuns.findIndex((w) => w.id === after.id) + 1 : 0;
            return waitingRuns.slice(start, start + limit);
        },
        getLatestRunInChain: async (id) => legs[id] ?? null,
        getRunStepsForChain: async (id) => steps[id] ?? [],
        createNotification: async (n) => { seen.notes.push(n); },
        onRunEvent: (type, handler) => { handlers.set(type, handler); return () => handlers.delete(type); },
    };
    return { deps, seen, handlers };
}

test('a journey that ended well closes its waiting run with what it did; a plan with a result step told its owner itself', async () => {
    const { deps, seen } = world();
    assert.strictEqual(await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status: 'success', summary: 'Ran 3 steps.' }, deps), true);
    assert.deepStrictEqual(seen.closed, [['cw-run-1', { status: 'success', result: 'Done, after your decision.', error: null }]], 'the engine\'s list of steps is no result');
    assert.deepStrictEqual(seen.notes, []);
});

test('a plan without a result step is told here, once', async () => {
    const noResult = { ...PLAN, definition: planOf([{ id: 'a', type: 'set', fields: {} }]) };
    const { deps, seen } = world({ plan: noResult });
    await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status: 'success' }, deps);
    assert.deepStrictEqual(seen.notes.map((n) => [n.userId, n.title, n.message]), [['u1', 'Supplier radar', 'Done, after your decision.']]);
    await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status: 'success' }, deps);
    assert.strictEqual(seen.notes.length, 1, 'hearing the end twice changes nothing');
});

test('a journey that failed after the decision closes as error and always tells its owner, with a way to the item', async () => {
    const { deps, seen } = world();
    await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status: 'error', error: 'Outlook did not answer.' }, deps);
    assert.deepStrictEqual(seen.closed, [['cw-run-1', { status: 'error', result: null, error: 'Outlook did not answer.' }]]);
    assert.deepStrictEqual(seen.notes.map((n) => [n.title, n.message, n.link]), [['Cowork failed', 'Supplier radar: Outlook did not answer.', '/app/cowork/s1']]);
});

test('a rejection or a cancellation is an end too, and says how it ended', async () => {
    const { deps, seen } = world();
    await onRunEnd({ runId: 'leg-1', status: 'cancelled' }, deps);
    assert.match(seen.closed[0][1].error, /ended as "cancelled"/);
});

test('a journey that is still going, or waits for a person again, is left alone', async () => {
    for (const status of ['running', 'queued', 'awaiting_approval', 'awaiting_form', 'awaiting_confirm', undefined, '']) {
        const { deps, seen } = world();
        assert.strictEqual(await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status }, deps), false, String(status));
        assert.deepStrictEqual([seen.closed, seen.notes], [[], []]);
    }
});

test('a journey no plan run started, or one whose Cowork run is not waiting, changes nothing and tells nobody', async () => {
    const other = world();
    assert.strictEqual(await onRunEnd({ runId: 'leg-9', status: 'success' }, other.deps), false);
    const done = world({ waiting: false });
    assert.strictEqual(await onRunEnd({ runId: 'leg-1', status: 'error', error: 'x' }, done.deps), false);
    assert.deepStrictEqual(done.seen.notes, []);
    assert.strictEqual(await onRunEnd({}, other.deps), false);
});

test('the sweep closes waiting runs whose journey ended unheard, and leaves the ones still waiting', async () => {
    const { deps, seen } = world({
        waitingRuns: [{ id: 'cw-run-1', automationRunId: 'leg-1' }, { id: 'cw-run-2', automationRunId: 'leg-5' }],
        legs: { 'leg-1': { id: 'leg-2', status: 'success', summary: 'Ran 3 steps.' }, 'leg-5': { id: 'leg-5', status: 'awaiting_approval' } },
    });
    assert.strictEqual(await sweepWaiting(deps), 1);
    assert.deepStrictEqual(seen.closed.map((c) => c[0]), ['cw-run-1']);
});

test('a failed notification never undoes the close', async () => {
    const { deps, seen } = world();
    deps.createNotification = async () => { throw new Error('the bell is down'); };
    assert.strictEqual(await onRunEnd({ runId: 'leg-1', status: 'error', error: 'x' }, deps), true);
    assert.strictEqual(seen.closed.length, 1);
});

test('start listens to the engine\'s ends once, and stop lets go', async () => {
    const { deps, seen, handlers } = world();
    assert.strictEqual(start(deps), true);
    assert.strictEqual(start(deps), false, 'a second start does nothing');
    assert.deepStrictEqual([...handlers.keys()].sort(), ['run.failed', 'run.finished']);
    handlers.get('run.finished')({ runId: 'leg-2', rootRunId: 'leg-1', status: 'success' });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.strictEqual(seen.closed.length, 1);
    stop();
    assert.strictEqual(handlers.size, 0);
});

test('the result of a journey is the message its last step delivered', async () => {
    const { deps, seen } = world({ steps: { 'leg-1': [
        { status: 'success', output: { overdue: 3 } },
        { status: 'success', output: { delivered: { title: 'Supplier radar', body: '3 orders are overdue' } } },
        { status: 'error', output: null },
    ] } });
    await onRunEnd({ runId: 'leg-2', rootRunId: 'leg-1', status: 'success' }, deps);
    assert.strictEqual(seen.closed[0][1].result, '3 orders are overdue');
});

test('the sweep pages past waiting runs whose decision is still pending', async () => {
    const pending = Array.from({ length: 150 }, (_, i) => ({ id: `w-${i}`, automationRunId: `pending-${i}`, startedAt: new Date(1_795_000_000_000 + i).toISOString() }));
    const { deps, seen } = world({
        waitingRuns: [...pending, { id: 'cw-run-1', automationRunId: 'leg-1', startedAt: new Date(1_795_000_001_000).toISOString() }],
        legs: { ...Object.fromEntries(pending.map((w) => [w.automationRunId, { status: 'awaiting_approval' }])), 'leg-1': { id: 'leg-2', status: 'success' } },
    });
    assert.strictEqual(await sweepWaiting(deps), 1);
    assert.deepStrictEqual(seen.closed.map((c) => c[0]), ['cw-run-1']);
});
