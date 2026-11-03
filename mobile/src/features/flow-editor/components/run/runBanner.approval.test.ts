/**
 * The line over the flow on a run that waits for a decision: who decides,
 * the "Test" marker on a test run, Stop called "Discard this test run", and
 * a pause decided elsewhere no longer claimed. Branches on runPhase (via
 * runPause), so a legacy row with no profile reads as today.
 */

import type { AutomationRun, AutomationRunStep } from '@/features/automations';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { runBannerModel, type BannerRun } from './runBanner';
import { computeRunFocus } from './runFocus';
import { pausedStopLabel } from './runMenu';
import { beginRun, IDLE_TEST_RUN, settleDryRun, settleStoppedRun, type TestRunState } from './runState';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'a', type: 'set', label: 'Prepare' },
        { id: 'ok', type: 'approval', label: 'Manager says yes' },
        { id: 'f', type: 'form_page', label: 'Ask for details' },
    ],
    edges: [],
};

const T0 = Date.parse('2026-11-03T10:00:00Z');

function row(stepId: string, status: string): AutomationRunStep {
    return {
        runId: 'r1', stepId, parentStepId: null, stepType: null, attempts: null, status,
        startedAt: '2026-11-03T10:00:01Z', finishedAt: null, input: null, output: null, error: null, errorClass: null, branchIndex: null,
    };
}

function settled(run: Partial<AutomationRun>, rows: AutomationRunStep[]): TestRunState {
    return settleDryRun(beginRun(IDLE_TEST_RUN, { kind: 'step', stepId: 'ok', mode: 'upTo', now: T0 }), { run: { id: 'r1', automationId: 'a1', ...run } as AutomationRun, steps: rows }, T0 + 1000);
}

function model(state: TestRunState, fresh: BannerRun | null = null) {
    return runBannerModel(state, computeRunFocus({ runSteps: state.rows, definition: DEF }), { running: false, t, now: T0 + 5000, run: fresh });
}

const WAITING = [row('a', 'success'), row('ok', 'awaiting_approval')];

describe('the line over a run that waits for a decision', () => {
    it('names the step, and marks it a test, while the run row has said nothing about who decides', () => {
        const m = model(settled({ status: 'awaiting_approval', profile: { kind: 'test' } }, WAITING));
        expect(m).toMatchObject({ tone: 'warning', text: 'Waiting for a decision at Manager says yes', stepId: 'ok', live: false });
        expect(m?.pause).toMatchObject({ kind: 'approval', canDecide: null, isTest: true, testLabel: 'Test', stopLabel: 'Discard this test run' });
    });

    it('says "Waiting for your decision (test)" once GET /runs/:id says this person decides', () => {
        const state = settled({ status: 'awaiting_approval' }, WAITING);
        const m = model(state, { status: 'awaiting_approval', profile: { kind: 'test' }, canDecide: true });
        expect(m?.text).toBe('Waiting for your decision (test)');
        expect(m?.pause?.testLabel).toBe('Test');
    });

    it('says on whom it waits when somebody else decides, and a production run has no Test marker', () => {
        const state = settled({ status: 'awaiting_approval' }, WAITING);
        const m = model(state, { status: 'awaiting_approval', profile: { kind: 'production' }, canDecide: false, waitingOn: { stageName: 'Finance', seatCount: 2 } });
        expect(m?.text).toBe('Waiting for Finance (2)');
        expect(m?.pause).toMatchObject({ testLabel: null, stopLabel: 'Stop this run', canDecide: false });
    });

    it('reads a legacy row (no profile) as today: no Test marker', () => {
        const m = model(settled({ status: 'awaiting_approval', mode: 'live' }, WAITING));
        expect(m?.pause?.testLabel).toBeNull();
    });

    it('stops claiming the pause once the run row says it was decided elsewhere', () => {
        const state = settled({ status: 'awaiting_approval' }, WAITING);
        const m = model(state, { status: 'success', profile: { kind: 'test' } });
        expect(m?.pause).toBeUndefined();
        expect(m?.tone).toBe('success');
    });

    it('waits on a form page with the web builder as the place to answer it', () => {
        const m = model(settled({ status: 'awaiting_form', profile: { kind: 'test' } }, [row('a', 'success'), row('f', 'awaiting_form')]));
        expect(m).toMatchObject({ text: 'Waiting for a form at Ask for details', stepId: 'f' });
        expect(m?.pause).toMatchObject({ kind: 'form', hint: 'Answer this page in the web builder.', stopLabel: 'Discard this test run' });
    });

    it('says the run stopped once it was discarded, and the step no longer waits', () => {
        const stopped = settleStoppedRun(settled({ status: 'awaiting_approval', profile: { kind: 'test' } }, WAITING), null, T0 + 9000);
        expect(stopped.rows.find((r) => r.stepId === 'ok')?.status).toBe('cancelled');
        expect(model(stopped)).toMatchObject({ tone: 'info', text: 'Test run stopped' });
    });

    it('the run menu offers the same way out, only while the run waits', () => {
        expect(pausedStopLabel({ status: 'awaiting_form', profile: { kind: 'test' } }, t)).toBe('Discard this test run');
        expect(pausedStopLabel({ status: 'awaiting_approval', profile: { kind: 'production' } }, t)).toBe('Stop this run');
        expect(pausedStopLabel({ status: 'success' }, t)).toBeNull();
        expect(pausedStopLabel(null, t)).toBeNull();
    });
});

describe('the run focus on a pause', () => {
    it('names an approval pause and when it began, and lets go of it while the run executes again', () => {
        const parked = computeRunFocus({ runSteps: WAITING, definition: DEF });
        expect(parked).toMatchObject({ stepId: 'ok', awaitingApproval: true, awaitingForm: false, pausedAt: '2026-11-03T10:00:01Z' });
        const moving = computeRunFocus({ runSteps: WAITING, definition: DEF, runInFlight: true });
        expect(moving).toMatchObject({ awaitingApproval: false, pausedAt: null });
    });
});
