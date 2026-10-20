'use strict';
/**
 * Golden replay, with every collaborator faked.
 * Run: cd server && node --test automation/testing/goldenReplay.test.js
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { replayGoldens, effectiveStatus, anyRunning } = require('./goldenReplay');

const T0 = '2026-10-01T10:00:00.000Z';
const goldenRun = { id: 'g-run', automationId: 'a1', version: 4, rootStepId: 'trig2', triggerPayload: { who: 'sample' }, status: 'success', startedByUserId: 'u1' };
const automation = { id: 'a1', definition: { steps: [] } };

let calls;
let written;
let compareResult;

function makeDeps(over = {}) {
    return {
        store: {
            getRun: async (id) => (id === 'g-run' ? { ...goldenRun } : null),
            getRunsInChain: async (id) => [{ id }],
            getRunStepsForChain: async () => [{ stepId: 'p1' }],
            getVersionDefinition: async (aid, v) => ({ snapshot: `${aid}@${v}` }),
        },
        testingStore: { setGoldenReplay: async (id, patch) => { written.push({ id, ...patch }); } },
        answersFromJourney: (input) => { calls.answers.push(input); return { v: 1, trigger: null, pages: { p1: { name: 'x' } }, skipped: [] }; },
        runEntry: {
            entryDefinitionOf: async () => ({ triggers: ['trig1', 'trig2'] }),
            resolveTriggerStepId: (def, id) => {
                calls.resolve.push(id);
                if (id == null) return { trigger: {}, rootStepId: 'trig1' };
                return def.triggers.includes(id) ? { trigger: {}, rootStepId: id } : { error: 'unknown trigger' };
            },
        },
        executeAutomation: async (a, opts) => { calls.exec.push(opts); return { id: `replay-${calls.exec.length}`, status: 'success' }; },
        compareRuns: async (input) => { calls.compare.push(input); return compareResult; },
        log: { warn: (m) => calls.warn.push(m) },
        ...over,
    };
}

beforeEach(() => {
    calls = { answers: [], resolve: [], exec: [], compare: [], warn: [] };
    written = [];
    compareResult = { verdict: 'same', summary: { same: 3, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 }, steps: [], truncated: false };
});

const golden = (id, over = {}) => ({ id, runId: 'g-run', ignorePaths: ['meta.at'], ...over });

test('happy path: dry run with the saved answers and the AI mode, compared with the golden, verdict stored', async () => {
    const results = await replayGoldens({ automation, goldens: [golden('gold_1')], userId: 'u1', aiAnswers: 'cache' }, makeDeps());
    assert.deepStrictEqual(results, [{ goldenId: 'gold_1', status: 'same' }]);
    assert.deepStrictEqual(calls.answers[0].definition, { snapshot: 'a1@4' });
    assert.strictEqual(calls.answers[0].rootRun.id, 'g-run');
    assert.deepStrictEqual(calls.exec[0], {
        triggerKind: 'dry_run', mode: 'dry_run', triggerPayload: { who: 'sample' }, rootStepId: 'trig2', startedByUserId: 'u1',
        harness: { source: { kind: 'golden', id: 'gold_1' }, formAnswers: { pages: { p1: { name: 'x' } } }, aiAnswers: 'cache' },
    });
    assert.strictEqual(calls.compare[0].runA.id, 'g-run');
    assert.strictEqual(calls.compare[0].runB.id, 'replay-1');
    assert.deepStrictEqual(calls.compare[0].ignorePaths, ['meta.at']);
    assert.strictEqual(calls.compare[0].viewerId, 'u1');
    assert.deepStrictEqual(written, [
        { id: 'gold_1', status: 'running', summary: null, replayRunId: null, errorCode: null },
        { id: 'gold_1', status: 'same', summary: compareResult.summary, replayRunId: 'replay-1', errorCode: null },
    ]);
});

test('aiAnswers defaults to live; a missing definition snapshot falls back to the current one', async () => {
    const deps = makeDeps();
    deps.store.getVersionDefinition = async () => null;
    await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.strictEqual(calls.exec[0].harness.aiAnswers, 'live');
    assert.deepStrictEqual(calls.answers[0].definition, automation.definition);
});

test('the verdict of the compare is what is stored: soft and changed', async () => {
    compareResult = { ...compareResult, verdict: 'changed', summary: { same: 1, changed: 2, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 } };
    const results = await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, makeDeps());
    assert.strictEqual(results[0].status, 'changed');
    assert.strictEqual(written.at(-1).status, 'changed');
    assert.strictEqual(written.at(-1).summary.changed, 2);
});

test('a trigger that no longer exists falls back to the primary trigger', async () => {
    const deps = makeDeps();
    deps.store.getRun = async () => ({ ...goldenRun, rootStepId: 'removed_trigger' });
    await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.deepStrictEqual(calls.resolve, ['removed_trigger', null]);
    assert.strictEqual(calls.exec[0].rootStepId, 'trig1');
});

test('a run without a stored trigger uses the primary one directly', async () => {
    const deps = makeDeps();
    deps.store.getRun = async () => ({ ...goldenRun, rootStepId: null });
    await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.deepStrictEqual(calls.resolve, [null]);
});

test('an executeAutomation throw ends as status error with a code, logged without the message', async () => {
    const deps = makeDeps({ executeAutomation: async () => { throw Object.assign(new Error('secret value in message'), { code: 'sandbox_failed' }); } });
    const results = await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.deepStrictEqual(results, [{ goldenId: 'g1', status: 'error' }]);
    assert.deepStrictEqual(written.at(-1), { id: 'g1', status: 'error', summary: null, replayRunId: null, errorCode: 'sandbox_failed' });
    assert.strictEqual(calls.warn.length, 1);
    assert.ok(!calls.warn[0].includes('secret'));
});

test('an unknown error becomes replay_failed; a gone golden run becomes golden_run_gone; one failure does not stop the rest', async () => {
    const deps = makeDeps();
    let n = 0;
    deps.executeAutomation = async (a, opts) => { calls.exec.push(opts); if (++n === 1) throw new Error('boom'); return { id: 'r2' }; };
    const results = await replayGoldens({ automation, goldens: [golden('g1'), golden('g2')], userId: 'u1' }, { ...deps, concurrency: 1 });
    assert.deepStrictEqual(results.map(r => r.status), ['error', 'same']);
    assert.strictEqual(written.find(w => w.id === 'g1' && w.status === 'error').errorCode, 'replay_failed');

    written = [];
    const gone = await replayGoldens({ automation, goldens: [golden('g3', { runId: 'nope' })], userId: 'u1' }, makeDeps());
    assert.strictEqual(gone[0].status, 'error');
    assert.strictEqual(written.at(-1).errorCode, 'golden_run_gone');
});

test('a failing store write while recording the failure does not throw either', async () => {
    const deps = makeDeps({ executeAutomation: async () => { throw new Error('x'); } });
    deps.testingStore.setGoldenReplay = async (id, patch) => { if (patch.status === 'error') throw new Error('db down'); };
    const results = await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.deepStrictEqual(results, [{ goldenId: 'g1', status: 'error' }]);
});

test('the concurrency is respected', async () => {
    for (const [limit, expected] of [[1, 1], [2, 2], [3, 3]]) {
        let live = 0;
        let peak = 0;
        const deps = makeDeps({
            executeAutomation: async () => {
                live++; peak = Math.max(peak, live);
                await new Promise(r => setTimeout(r, 15));
                live--;
                return { id: 'r' };
            },
        });
        const goldens = Array.from({ length: 6 }, (_, i) => golden(`g${i}`));
        const results = await replayGoldens({ automation, goldens, userId: 'u1' }, { ...deps, concurrency: limit });
        assert.strictEqual(peak, expected, `limit ${limit}`);
        assert.strictEqual(results.length, 6);
    }
});

test('no goldens is an empty result', async () => {
    assert.deepStrictEqual(await replayGoldens({ automation, goldens: [], userId: 'u1' }, makeDeps()), []);
});

test('the compare is given only the legs the user may read', async () => {
    const deps = makeDeps();
    deps.store.getRunsInChain = async (id) => (id === 'g-run'
        ? [{ id: 'g-run' }, { id: 'g-leg2', connectionsMode: 'caller', startedByUserId: 'other' }]
        : [{ id }]);
    await replayGoldens({ automation, goldens: [golden('g1')], userId: 'u1' }, deps);
    assert.deepStrictEqual(calls.compare[0].legsA.map(l => l.id), ['g-run']);
});

test('effectiveStatus: running becomes interrupted after the stale window, everything else is itself', () => {
    const now = Date.parse(T0) + 31 * 60_000;
    assert.strictEqual(effectiveStatus(null, now), null);
    assert.strictEqual(effectiveStatus({ status: 'running', at: T0 }, Date.parse(T0) + 60_000), 'running');
    assert.strictEqual(effectiveStatus({ status: 'running', at: T0 }, now), 'interrupted');
    assert.strictEqual(effectiveStatus({ status: 'running', at: new Date(T0) }, now), 'interrupted');
    assert.strictEqual(effectiveStatus({ status: 'changed', at: T0 }, now), 'changed');
    assert.strictEqual(effectiveStatus({ status: 'error', at: T0 }, now), 'error');
    assert.strictEqual(anyRunning([{ lastReplay: { status: 'running', at: T0 } }], now), false);
    assert.strictEqual(anyRunning([{ lastReplay: null }, { lastReplay: { status: 'running', at: T0 } }], Date.parse(T0) + 1000), true);
});

test('the stale window comes from the environment; 0 never expires', () => {
    const now = Date.parse(T0) + 5 * 60_000;
    process.env.AUTOMATION_GOLDEN_REPLAY_STALE_MS = '60000';
    try {
        assert.strictEqual(effectiveStatus({ status: 'running', at: T0 }, now), 'interrupted');
        process.env.AUTOMATION_GOLDEN_REPLAY_STALE_MS = '0';
        assert.strictEqual(effectiveStatus({ status: 'running', at: T0 }, now + 10 * 86_400_000), 'running');
    } finally {
        delete process.env.AUTOMATION_GOLDEN_REPLAY_STALE_MS;
    }
});
