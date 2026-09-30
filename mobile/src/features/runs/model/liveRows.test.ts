/**
 * Live events against the rows on screen: the head of a journey is patched,
 * a continuation is never a row of its own, and a start only appears where
 * the status chip would show it.
 */

import { DEFAULT_FILTERS } from './filters';
import { applyRunEvent, type LiveRunEvent } from './liveRows';
import type { LogRun } from './types';

const row = (id: string, over: Partial<LogRun> = {}): LogRun => ({
    id,
    journeyRunId: null,
    automationId: 'a1',
    automationTitle: 'Invoices',
    automationKind: 'automation',
    triggerKind: 'manual',
    rootStepId: null,
    rootTriggerLabel: null,
    mode: 'live',
    status: 'running',
    startedAt: '2026-09-24T10:00:00Z',
    finishedAt: null,
    durationMs: null,
    summary: null,
    error: null,
    errorClass: null,
    handledErrorCount: 0,
    ...over,
});

const ev = (over: Partial<LiveRunEvent>): LiveRunEvent => ({ type: 'run.started', runId: 'r9', automationId: 'a1', ...over });

describe('applyRunEvent', () => {
    it('puts a new run on top when the chip shows running runs', () => {
        const out = applyRunEvent([row('r1')], ev({ title: 'Digest', at: '2026-09-24T11:00:00Z' }), DEFAULT_FILTERS);
        expect(out.map((r) => r.id)).toEqual(['r9', 'r1']);
        expect(out[0]).toMatchObject({ automationTitle: 'Digest', status: 'running', journeyRunId: 'r9', mode: 'live' });
    });

    it('does not insert into a failures-only list, nor a continuation leg', () => {
        const rows = [row('r1')];
        expect(applyRunEvent(rows, ev({}), { ...DEFAULT_FILTERS, status: 'error' })).toBe(rows);
        expect(applyRunEvent(rows, ev({ rootRunId: 'r0' }), DEFAULT_FILTERS)).toBe(rows);
    });

    it('settles the head row of a journey without taking the leg’s duration', () => {
        const rows = [row('r1', { durationMs: 1000 })];
        const out = applyRunEvent(rows, ev({ type: 'run.finished', runId: 'r2', rootRunId: 'r1', status: 'success', durationMs: 5 }), DEFAULT_FILTERS);
        expect(out[0]).toMatchObject({ id: 'r1', status: 'success', journeyRunId: 'r2', durationMs: 1000 });
    });

    it('takes a self-contained run’s duration and error', () => {
        const out = applyRunEvent([row('r1')], ev({ type: 'run.failed', runId: 'r1', status: 'error', durationMs: 42, error: 'boom', errorClass: 'timeout' }), DEFAULT_FILTERS);
        expect(out[0]).toMatchObject({ status: 'error', durationMs: 42, error: 'boom', errorClass: 'timeout' });
    });

    it('ignores step frames, other routines and unknown rows', () => {
        const rows = [row('r1')];
        expect(applyRunEvent(rows, ev({ type: 'step.started', runId: 'r1' }), DEFAULT_FILTERS)).toBe(rows);
        expect(applyRunEvent(rows, ev({ automationId: 'a2' }), { ...DEFAULT_FILTERS, automationId: 'a1' })).toBe(rows);
        expect(applyRunEvent(rows, ev({ type: 'run.finished', runId: 'zz' }), DEFAULT_FILTERS)).toBe(rows);
    });

    it('marks an existing row running again on a restart', () => {
        const out = applyRunEvent([row('r1', { status: 'queued' })], ev({ runId: 'r1' }), DEFAULT_FILTERS);
        expect(out[0]?.status).toBe('running');
    });
});
