/**
 * The steps of a run that followed a plan (./coworkRunTrace.mts). The store and the automation runs are handed in,
 * so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkRunTrace.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runTraceOf } = require('./coworkRunTrace.mts');
const { fakeLookups, supplierRadar } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 's1', userId: 'u1' };
const PLAN = { id: 'plan-2', scheduleId: 's1', automationId: 'auto-1', version: 2, definition: supplierRadar(), permissions: {}, fingerprint: 'f'.repeat(64), approvedBy: 'u1', approvedAt: null };
const ROWS = [
    { stepId: 'mail', attempts: 1, status: 'success', startedAt: '2026-11-23T08:00:00.000Z', finishedAt: '2026-11-23T08:00:01.500Z', output: { messages: 9 } },
    { stepId: 'draft', attempts: 1, status: 'success', input: { to: 'orders@hoekstra-staal.example' }, output: { id: 'AAMk-1' } },
];

function world({ link = { runId: 'run-1', automationRunId: 'arun-1', plan: PLAN }, run = { id: 'arun-1', automationId: 'auto-1', status: 'success', durationMs: 5200 }, rows = ROWS } = {}) {
    const asked = [];
    return {
        asked,
        deps: {
            store: { getPlanRun: async (scheduleId, runId) => { asked.push([scheduleId, runId]); return link; } },
            getLatestRunInChain: async (id) => (run && id === 'arun-1' ? run : null),
            getRunStepsForChain: async () => rows,
            lookups: fakeLookups(),
        },
    };
}

test('the trace of a run is the plan it followed, step by step, read through its item', async () => {
    const { deps, asked } = world();
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, deps);
    assert.deepStrictEqual(asked, [['s1', 'run-1']]);
    assert.deepStrictEqual([trace.runId, trace.planVersion, trace.recorded, trace.done, trace.durationMs], ['run-1', 2, true, true, 5200]);
    assert.deepStrictEqual(trace.steps.map((s) => [s.id, s.status]), [
        ['mail', 'success'], ['orders', 'not_reached'], ['overdue', 'not_reached'], ['table', 'not_reached'],
        ['reply', 'not_reached'], ['draft', 'success'], ['digest', 'not_reached'],
    ]);
    assert.strictEqual(trace.steps[0].durationMs, 1500);
});

test('a real run holds nothing back: a step that wrote shows what went into it', async () => {
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, world().deps);
    const draft = trace.steps.find((s) => s.id === 'draft');
    assert.strictEqual(draft.held, false);
    assert.match(draft.preview, /hoekstra-staal/);
    assert.ok(trace.steps.every((s) => s.held === false));
});

test('a run that is still going says so, and its later steps are still to come', async () => {
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, world({ run: { id: 'arun-1', automationId: 'auto-1', status: 'running' }, rows: [ROWS[0]] }).deps);
    assert.deepStrictEqual([trace.done, trace.durationMs], [false, null]);
    assert.deepStrictEqual(trace.steps.slice(0, 2).map((s) => s.status), ['success', 'pending']);
});

test('a run that waited for a decision is read over its whole journey: the newest leg says how it stands', async () => {
    const legs = { id: 'arun-2', automationId: 'auto-1', status: 'success', durationMs: 900 };
    const journey = [ROWS[0], { stepId: 'draft', attempts: 1, status: 'success', input: { to: 'orders@hoekstra-staal.example' } }];
    const w = world({ run: legs, rows: journey });
    w.deps.getLatestRunInChain = async (id) => (id === 'arun-1' ? legs : null);
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, w.deps);
    assert.deepStrictEqual([trace.recorded, trace.done, trace.durationMs], [true, true, 900]);
    assert.deepStrictEqual(trace.steps.filter((s) => s.status === 'success').map((s) => s.id), ['mail', 'draft']);
});

test('while the journey waits for a decision, the steps after it are still to come, not "not reached"', async () => {
    const w = world({ run: { id: 'arun-1', automationId: 'auto-1', status: 'awaiting_approval' }, rows: [ROWS[0]] });
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, w.deps);
    assert.strictEqual(trace.done, true, 'nothing changes by itself: no need to keep reading');
    assert.deepStrictEqual(trace.steps.slice(0, 3).map((x) => x.status), ['success', 'pending', 'pending']);
    assert.ok(trace.steps.every((x) => x.status !== 'not_reached'));
});

test('a run that followed no plan has no trace', async () => {
    await assert.rejects(runTraceOf({ item: ITEM, runId: 'run-1' }, world({ link: null }).deps), (err) => err.status === 404 && err.code === 'cowork_run_no_plan');
});

test('steps that were never recorded, or are no longer kept, leave the plan listed without how it went', async () => {
    const neverStarted = world({ link: { runId: 'run-1', automationRunId: null, plan: PLAN } });
    const gone = world({ run: null });
    for (const w of [neverStarted, gone]) {
        const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, w.deps);
        assert.deepStrictEqual([trace.recorded, trace.done, trace.planVersion], [false, true, 2]);
        assert.ok(trace.steps.length === 7 && trace.steps.every((s) => s.status === 'not_reached' && s.preview === null));
    }
});

test('the steps of a run of another automation are never shown as this run\'s', async () => {
    const trace = await runTraceOf({ item: ITEM, runId: 'run-1' }, world({ run: { id: 'arun-1', automationId: 'someone-elses', status: 'success' } }).deps);
    assert.strictEqual(trace.recorded, false);
    assert.ok(trace.steps.every((s) => s.preview === null && s.status === 'not_reached'));
});
