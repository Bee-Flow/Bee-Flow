/**
 * The overlay's mapping: a test run's rows onto what the flow shows — the
 * run line's words and tone, the step it points at, and the effective row
 * each card reads (pins included, a deleted step's row never named).
 */

import type { AutomationRun, AutomationRunStep } from '@/features/automations';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { runBannerModel } from './runBanner';
import { computeRunFocus } from './runFocus';
import { beginRun, IDLE_TEST_RUN, settleDryRun, type TestRunState } from './runState';
import { effectiveRunByStep } from './runStatus';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'a', type: 'ai_step', label: 'Sort the mail' },
        { id: 'b', type: 'notification', label: 'Tell me' },
        { id: 'p', type: 'set', label: 'Pinned', pinnedOutput: { x: 1 } },
    ],
    edges: [],
};

const T0 = Date.parse('2026-09-01T10:00:00Z');

function row(stepId: string, status: string, extra: Partial<AutomationRunStep> = {}): AutomationRunStep {
    return {
        runId: 'r1', stepId, parentStepId: null, stepType: null, attempts: null, status,
        startedAt: '2026-09-01T10:00:00Z', finishedAt: null, input: null, output: null, error: null, errorClass: null, branchIndex: null, ...extra,
    };
}

function model(state: TestRunState, running = false, now = T0 + 12_000) {
    return runBannerModel(state, computeRunFocus({ runSteps: state.rows, runInFlight: running, definition: DEF }), { running, t, now });
}

it('says nothing before any test', () => {
    expect(model(IDLE_TEST_RUN)).toBeNull();
});

it('says where a going run is, how far and how long', () => {
    const going = { ...beginRun(IDLE_TEST_RUN, { kind: 'dry', now: T0 }), rows: [row('a', 'success'), row('b', 'running')] };
    expect(model(going, true)).toEqual({ tone: 'info', text: 'Testing the automation… · Tell me · 1/4 · 12s', stepId: 'b', live: true });
    const stepRun = beginRun(IDLE_TEST_RUN, { kind: 'step', stepId: 'a', mode: 'only', now: T0 });
    expect(model(stepRun, true)?.text).toBe('Testing… · 12s');
});

it('points at the failed step, by its name', () => {
    const done = settleDryRun(beginRun(IDLE_TEST_RUN, { kind: 'dry', now: T0 }), {
        run: { id: 'r1', status: 'error' } as AutomationRun,
        steps: [row('a', 'success'), row('b', 'error', { error: 'No channel' })],
    }, T0 + 1000);
    expect(model(done)).toEqual({ tone: 'error', text: 'Failed at Tell me', stepId: 'b', live: false });
});

it('never names a step that is gone', () => {
    const done = settleDryRun(beginRun(IDLE_TEST_RUN, { kind: 'dry', now: T0 }), {
        run: { id: 'r1', status: 'error', error: 'Broke somewhere' } as AutomationRun,
        steps: [row('deleted', 'error')],
    }, T0 + 1000);
    expect(model(done)).toEqual({ tone: 'error', text: 'Broke somewhere', stepId: null, live: false });
});

it('sums up a run that finished', () => {
    const done = settleDryRun(beginRun(IDLE_TEST_RUN, { kind: 'dry', now: T0 }), {
        run: { id: 'r1', status: 'success', durationMs: 1500 } as AutomationRun,
        steps: [row('a', 'success'), row('b', 'success'), row('a/x', 'success', { parentStepId: 'a' })],
    }, T0 + 2000);
    expect(model(done)).toEqual({ tone: 'success', text: 'Test run finished · 2 steps · 1.5s', stepId: null, live: false });
});

it('says a request that failed in its own words, pointing at the step it asked for', () => {
    const failed: TestRunState = { ...beginRun(IDLE_TEST_RUN, { kind: 'step', stepId: 'a', mode: 'only', now: T0 }), pending: false, error: 'Rate limited' };
    expect(model(failed)).toEqual({ tone: 'error', text: 'Rate limited', stepId: 'a', live: false });
});

it('gives every card its effective row: the run row, else the pin', () => {
    const map = effectiveRunByStep(DEF, [row('a', 'success'), row('ghost', 'error')]);
    expect(map.get('a')?.status).toBe('success');
    expect(map.get('p')).toEqual({ stepId: 'p', status: 'pinned', output: { x: 1 } });
    expect(map.has('b')).toBe(false);
});
