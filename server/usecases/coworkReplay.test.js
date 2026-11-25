/**
 * "Replay on last month" from the route's side (./coworkReplay.mts): what is refused before anything runs, that START
 * answers before the replays are done, that one failing past run is not the end of the replay, and that a replay is
 * read through its own item. The store and the engine are handed in (the store has its own PGlite test,
 * stores/coworkReplays.pg.test.js; the engine's part is core/cowork/replay/replay.engine.pg.test.js).
 *
 * Run: cd server && node --test usecases/coworkReplay.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { startReplay, replayStateOf } = require('./coworkReplay.mts');
const { OPEN_POLICY } = require('../core/entitlements/coworkPolicy.mts');

const literal = (value) => ({ kind: 'literal', value });
const PLAN = {
    schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
    steps: [{ id: 'facts', type: 'set', label: 'The figures', fields: { n: literal(3) } }], edges: [{ from: 'trg', to: 'facts' }], vars: {},
};
const ITEM = { id: 'cw-1', userId: 'u1', planAutomationId: 'auto-1' };
const lookups = { appOfTool: () => null, effectOfTool: () => 'reads', isOpenWebRead: () => false };

/** An in-memory store with the store's contract: one running replay per item, events counted once. */
function memoryStore(pastRuns) {
    const replays = new Map();
    return {
        replays,
        beginReplay: async (r) => {
            if ([...replays.values()].some((x) => x.replay.scheduleId === r.scheduleId && x.replay.status === 'running')) return false;
            replays.set(r.id, { replay: { ...r, status: 'running', same: 0, differs: 0, partial: 0, notReplayable: 0, startedAt: null, finishedAt: null }, events: [] });
            return true;
        },
        addEvent: async (id, e) => {
            const r = replays.get(id);
            r.events.push(e);
            const key = { same: 'same', differs: 'differs', partial: 'partial', not_replayable: 'notReplayable' }[e.verdict];
            r.replay[key] += 1;
        },
        finishReplay: async (id, status) => { replays.get(id).replay.status = status; },
        getReplay: async (scheduleId, id) => (replays.get(id)?.replay.scheduleId === scheduleId ? replays.get(id) : null),
        pastRunsOf: async (_id, limit) => pastRuns.slice(0, limit),
    };
}

const PAST = [
    { id: 'run-2', startedAt: new Date().toISOString(), automationRunId: 'ar-2', planDefinition: PLAN, independence: null, trustedSteps: [] },
    { id: 'run-1', startedAt: new Date().toISOString(), automationRunId: null, planDefinition: null, independence: null, trustedSteps: [] },
];

function depsWith(over = {}) {
    const background = [];
    const deps = {
        store: memoryStore(PAST),
        getAutomation: async (id) => (id === 'auto-1' ? { id, userId: 'u1', organizationId: 'org-1', definition: PLAN } : null),
        isManaged: async () => false,
        mayAsk: async () => true,
        ownerRefusal: async () => null,
        policyOf: async () => OPEN_POLICY,
        lookups,
        run: {
            getRun: async () => null,
            getRunStepsForChain: async () => [],
            getRunFullOutput: async () => null,
            executeAutomation: async () => { throw new Error('nothing runs: the recording is gone'); },
        },
        inBackground: (fn) => { background.push(fn()); },
        ...over,
    };
    return { deps, settled: () => Promise.all(background) };
}

const refusedWith = (status, code) => (e) => e.status === status && e.code === code;

test('START answers at once with the replay and its plan; the past runs are replayed behind it', async () => {
    const { deps, settled } = depsWith();
    const started = await startReplay({ item: ITEM }, deps);
    assert.strictEqual(started.total, 2);
    assert.match(started.fingerprint, /^[0-9a-f]{64}$/);
    await settled();
    const state = await replayStateOf({ item: ITEM, replayId: started.replayId }, deps);
    assert.deepStrictEqual([state.status, state.done, state.notReplayable], ['done', true, 2]);
    assert.deepStrictEqual(state.runs.map((r) => [r.pastRunId, r.verdict, r.reason]), [['run-2', 'not_replayable', 'not_recorded'], ['run-1', 'not_replayable', 'no_plan']]);
});

test('a past run whose replay throws is not replayable, and the replay goes on with the next', async () => {
    const run = { ...depsWith().deps.run, getRun: async () => ({ id: 'ar-2', mode: 'live', triggerPayload: {} }), getRunStepsForChain: async () => [{ runId: 'ar-2', stepId: 'facts', stepType: 'set', status: 'success', output: { n: 3 } }] };
    const { deps, settled } = depsWith({ run });
    const { replayId } = await startReplay({ item: ITEM }, deps);
    await settled();
    const state = await replayStateOf({ item: ITEM, replayId }, deps);
    assert.deepStrictEqual(state.runs.map((r) => [r.pastRunId, r.reason]), [['run-2', 'failed'], ['run-1', 'no_plan']]);
    assert.strictEqual(state.status, 'done');
});

test('refused before anything runs: no plan, a plan with findings, a read-only organisation, an owner the runner refuses, no past runs, a second replay', async () => {
    await assert.rejects(() => startReplay({ item: { ...ITEM, planAutomationId: null } }, depsWith().deps), refusedWith(409, 'cowork_replay_refused'));
    const layered = { ...PLAN, layers: [{ id: 'l1' }] };
    await assert.rejects(() => startReplay({ item: ITEM }, depsWith({ getAutomation: async () => ({ id: 'auto-1', userId: 'u1', definition: layered }) }).deps), refusedWith(422, 'cowork_plan_not_allowed'));
    await assert.rejects(() => startReplay({ item: ITEM }, depsWith({ policyOf: async () => ({ ...OPEN_POLICY, readOnly: true }) }).deps), refusedWith(423, 'cowork_read_only'));
    await assert.rejects(() => startReplay({ item: ITEM }, depsWith({ ownerRefusal: async () => 'inactive' }).deps), refusedWith(403, 'cowork_plan_refused'));
    await assert.rejects(() => startReplay({ item: ITEM }, depsWith({ store: memoryStore([]) }).deps), refusedWith(409, 'cowork_replay_refused'));
    const { deps } = depsWith({ inBackground: () => {} });
    await startReplay({ item: ITEM }, deps);
    await assert.rejects(() => startReplay({ item: ITEM }, deps), refusedWith(409, 'cowork_replay_running'));
});

test('a replay is read through its own item: another item\'s replay does not exist', async () => {
    const { deps, settled } = depsWith();
    const { replayId } = await startReplay({ item: ITEM }, deps);
    await settled();
    await assert.rejects(() => replayStateOf({ item: { ...ITEM, id: 'cw-2' }, replayId }, deps), refusedWith(404, 'cowork_replay_not_found'));
});
