import { describe, it, expect } from 'vitest';
import { mergeRunEvent } from './useExecutions';
import type { RunLogRow } from './runLogSentence';

const row = (id: string, extra: Partial<RunLogRow> = {}): RunLogRow => ({ id, status: 'running', durationMs: null, ...extra });

describe('mergeRunEvent — run.started', () => {
    it('injects a stub at the top when the status filter can show a running row', () => {
        const prev = [row('a')];
        const next = mergeRunEvent(prev, 'run.started', { automationId: 'au1', title: 'T', at: '2026-01-01T00:00:00.000Z' }, 'r1', 'all');
        expect(next).toHaveLength(2);
        expect(next[0]).toMatchObject({ id: 'r1', journeyRunId: 'r1', automationId: 'au1', automationTitle: 'T', automationKind: 'automation', mode: 'live', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', durationMs: null });
        expect(next[1]).toBe(prev[0]);
    });

    it('leaves the list alone under a non-running status filter, and never injects a continuation leg', () => {
        const prev = [row('a')];
        expect(mergeRunEvent(prev, 'run.started', {}, 'r1', 'error')).toBe(prev);
        expect(mergeRunEvent(prev, 'run.started', { rootRunId: 'head' }, 'leg', 'all')).toBe(prev);
    });

    it('updates the status of a row it already holds, addressed by the journey head', () => {
        const prev = [row('head', { status: 'awaiting_form' })];
        const next = mergeRunEvent(prev, 'run.started', { rootRunId: 'head' }, 'leg', 'error');
        expect(next).not.toBe(prev);
        expect(next[0].status).toBe('running');
    });
});

describe('mergeRunEvent — terminal events', () => {
    it('patches the terminal state of an existing row', () => {
        const prev = [row('r1')];
        const next = mergeRunEvent(prev, 'run.finished', { status: 'success', durationMs: 1200, error: null }, 'r1', 'all');
        expect(next[0]).toMatchObject({ id: 'r1', journeyRunId: 'r1', status: 'success', durationMs: 1200 });
    });

    it('keeps the journey duration when a continuation leg finishes', () => {
        const prev = [row('head', { durationMs: 5000 })];
        const next = mergeRunEvent(prev, 'run.failed', { rootRunId: 'head', status: 'error', durationMs: 10, error: 'boom' }, 'leg', 'all');
        expect(next[0]).toMatchObject({ id: 'head', journeyRunId: 'leg', status: 'error', durationMs: 5000, error: 'boom' });
    });

    it('ignores an event for a row the list does not hold', () => {
        const prev = [row('a')];
        expect(mergeRunEvent(prev, 'run.finished', { status: 'success' }, 'zzz', 'all')).toBe(prev);
    });
});
