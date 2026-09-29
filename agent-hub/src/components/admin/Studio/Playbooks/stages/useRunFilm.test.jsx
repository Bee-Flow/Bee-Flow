import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useRunFilm from './useRunFilm';

/** The paced run as the canvas receives it, over time. */
const DEF = { trigger: { id: 'trg' }, steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
const rec = (stepId, status) => ({ stepId, status });
const shown = (result) => result.current.map((s) => `${s.stepId}:${s.status}`);

describe('useRunFilm — the canvas sees the run travel', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // One beat of the film. A timer that sets state commits at the END of the
    // act, so the next beat's timer is only armed then — one act, one node.
    const beat = (ms = 700) => act(() => { vi.advanceTimersByTime(ms); });

    it('starts at the trigger even when the server already has three steps done', () => {
        const steps = [rec('s1', 'success'), rec('s2', 'success'), rec('s3', 'success')];
        const { result } = renderHook(() => useRunFilm(steps, DEF, { runId: 'run_1', runStatus: 'success' }));
        expect(shown(result)).toEqual(['trg:running']);
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:running']);
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:success', 's2:running']);
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:success', 's2:success', 's3:running']);
        // And only then the last node lands — every one of them was seen.
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:success', 's2:success', 's3:success']);
    });

    it('waits for the server: the film cannot reach a step that has not started', () => {
        const { result, rerender } = renderHook(
            ({ steps }) => useRunFilm(steps, DEF, { runId: 'run_1', runStatus: 'running' }),
            { initialProps: { steps: [rec('s1', 'running')] } },
        );
        beat();
        beat();
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:running'], 'the server has not started s2 — the film waits');
        rerender({ steps: [rec('s1', 'success'), rec('s2', 'running')] });
        beat();
        expect(shown(result)).toEqual(['trg:success', 's1:success', 's2:running']);
    });

    it('reduced motion gets the server\'s own steps, unpaced', () => {
        const steps = [rec('s1', 'success'), rec('s2', 'success')];
        const { result } = renderHook(() => useRunFilm(steps, DEF, { runId: 'run_1', reducedMotion: true }));
        expect(result.current).toBe(steps);
    });

    it('a second run starts its own film', () => {
        const steps = [rec('s1', 'success'), rec('s2', 'success'), rec('s3', 'success')];
        const { result, rerender } = renderHook(
            ({ runId }) => useRunFilm(steps, DEF, { runId, runStatus: 'success' }),
            { initialProps: { runId: 'run_1' } },
        );
        for (let i = 0; i < 4; i++) beat();
        expect(shown(result)).toEqual(['trg:success', 's1:success', 's2:success', 's3:success']);
        rerender({ runId: 'run_2' });
        expect(shown(result)).toEqual(['trg:running']);
    });
});
