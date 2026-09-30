/**
 * The test run's bookkeeping: a dry run replaces the rows once its own run
 * shows up, a step run merges, a failed step run leaves an honest error row,
 * and the run feed lights the cards up only for the run this test started.
 */

import type { AutomationRun, AutomationRunStep, RunEvent } from '@/features/automations';

import {
    applyRunEvent, beginRun, failRun, IDLE_TEST_RUN, markStepFailed, mergeRows, settleDryRun, settleStepRun, testDurationMs,
    type TestRunState,
} from './runState';

const T0 = Date.parse('2026-09-01T10:00:00Z');

function row(stepId: string, status: string, extra: Partial<AutomationRunStep> = {}): AutomationRunStep {
    return {
        runId: 'old', stepId, parentStepId: null, stepType: 'set', attempts: 1, status,
        startedAt: null, finishedAt: null, input: null, output: { from: stepId }, error: null, errorClass: null, branchIndex: null, ...extra,
    };
}

const run = (id: string, status: string, durationMs: number | null = null) => ({ id, status, durationMs }) as AutomationRun;

const withRows = (rows: AutomationRunStep[]): TestRunState => ({ ...IDLE_TEST_RUN, rows });

describe('a dry run', () => {
    it('keeps the old rows until its own run is seen, then replaces them live', () => {
        let s = beginRun(withRows([row('a', 'success'), row('b', 'error')]), { kind: 'dry', now: T0 });
        expect(s).toMatchObject({ pending: true, kind: 'dry', rows: [{ stepId: 'a' }, { stepId: 'b' }] });

        s = applyRunEvent(s, { type: 'run.started', runId: 'r1' });
        expect(s.runId).toBe('r1');
        expect(s.rows).toEqual([]);

        s = applyRunEvent(s, { type: 'step.started', runId: 'r1', stepId: 'a', stepType: 'set', at: '2026-09-01T10:00:01Z' });
        expect(s.rows).toMatchObject([{ stepId: 'a', status: 'running', startedAt: '2026-09-01T10:00:01Z' }]);
        s = applyRunEvent(s, { type: 'step.finished', runId: 'r1', stepId: 'a', status: 'success', at: '2026-09-01T10:00:02Z' });
        expect(s.rows).toMatchObject([{ stepId: 'a', status: 'success', startedAt: '2026-09-01T10:00:01Z', finishedAt: '2026-09-01T10:00:02Z' }]);

        // Another run of the same routine (a schedule firing) is not this test.
        const other = applyRunEvent(s, { type: 'step.started', runId: 'r2', stepId: 'b' });
        expect(other).toBe(s);

        s = settleDryRun(s, { run: run('r1', 'success', 1500), steps: [row('a', 'success'), row('b', 'skipped')] }, T0 + 3000);
        expect(s).toMatchObject({ pending: false, runId: 'r1', rows: [{ stepId: 'a' }, { stepId: 'b', status: 'skipped' }] });
        expect(testDurationMs(s)).toBe(1500);
    });

    it('ignores the feed when nothing is pending, or a frame carries no run', () => {
        const idle = withRows([row('a', 'success')]);
        expect(applyRunEvent(idle, { type: 'step.started', runId: 'r1', stepId: 'a' })).toBe(idle);
        const pending = beginRun(idle, { kind: 'dry', now: T0 });
        expect(applyRunEvent(pending, { type: 'step.started', stepId: 'a' } as RunEvent)).toBe(pending);
    });
});

describe('a step run', () => {
    it('merges its rows by step id and keeps every other card', () => {
        let s = beginRun(withRows([row('a', 'success'), row('b', 'error'), row('c', 'success')]), { kind: 'step', stepId: 'b', mode: 'from', now: T0 });
        s = applyRunEvent(s, { type: 'step.started', runId: 'r9', stepId: 'b', at: '2026-09-01T10:00:01Z' });
        // A step run does not wipe the other cards when its run shows up.
        expect(s.rows.map((r) => `${r.stepId}:${r.status}`)).toEqual(['a:success', 'b:running', 'c:success']);
        s = settleStepRun(s, { run: run('r9', 'success'), steps: [row('b', 'success'), row('d', 'success')], stepRecord: null }, T0 + 2000);
        expect(s.rows.map((r) => `${r.stepId}:${r.status}`)).toEqual(['a:success', 'b:success', 'c:success', 'd:success']);
        expect(testDurationMs(s)).toBe(2000);
    });

    it('a failure replaces the step row with an error row and drops its sub-rows', () => {
        const before = withRows([row('a', 'success'), row('cl', 'success'), row('cl/x', 'success', { parentStepId: 'cl' }), row('cl/y/z', 'success')]);
        let s = beginRun({ ...before, run: run('r0', 'running') }, { kind: 'step', stepId: 'cl', mode: 'only', now: T0 });
        s = failRun(s, 'Boom', T0 + 10);
        expect(s.error).toBe('Boom');
        expect(s.run?.status).toBe('error');
        expect(s.rows.map((r) => `${r.stepId}:${r.status}`)).toEqual(['a:success', 'cl:error']);
        expect(s.rows[1]).toMatchObject({ output: null, error: 'Boom', attempts: null });
    });

    it('markStepFailed appends a row for a step that had none', () => {
        expect(markStepFailed([row('a', 'success')], 'b', 'No').map((r) => r.stepId)).toEqual(['a', 'b']);
        expect(markStepFailed([row('a', 'success')], '', 'No')).toHaveLength(1);
    });

    it('a failed dry run keeps its rows', () => {
        const s = failRun(beginRun(withRows([row('a', 'success')]), { kind: 'dry', now: T0 }), 'Offline', T0 + 5);
        expect(s.rows).toHaveLength(1);
        expect(testDurationMs(s)).toBe(5);
    });
});

it('mergeRows: the fresh answer wins', () => {
    expect(mergeRows([row('a', 'error')], [row('a', 'success')]).map((r) => r.status)).toEqual(['success']);
});
