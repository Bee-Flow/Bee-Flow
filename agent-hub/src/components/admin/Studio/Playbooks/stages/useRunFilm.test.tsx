import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useRunFilm from './useRunFilm';
import { stub } from '@/test/mocks';

/** The paced run as the canvas receives it, over time. */
const DEF = { trigger: { id: 'trg' }, steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
const rec = (stepId: string, status: number) => ({ stepId, status });
const shown = (result: { current: { map: (...args: unknown[]) => unknown } }) => result.current.map((s: { stepId: unknown; status: unknown }) => `${s.stepId}:${s.status}`);

describe('useRunFilm — the canvas sees the run travel', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // One beat of the film. A timer that sets state commits at the END of the
    // act, so the next beat's timer is only armed then — one act, one node.
    const beat = (ms = 700) => act(() => { vi.advanceTimersByTime(ms); });

    it('starts at the trigger even when the server already has three steps done', () => {
        const steps = [rec('s1', stub<Parameters<typeof rec>[1]>('success')), rec('s2', stub<Parameters<typeof rec>[1]>('success')), rec('s3', stub<Parameters<typeof rec>[1]>('success'))];
        const { result } = renderHook(() => useRunFilm(stub<Parameters<typeof useRunFilm>[0]>(steps), DEF, { runId: 'run_1', runStatus: 'success' }));
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:running']);
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:running']);
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:success', 's2:running']);
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:success', 's2:success', 's3:running']);
        // And only then the last node lands — every one of them was seen.
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:success', 's2:success', 's3:success']);
    });

    it('waits for the server: the film cannot reach a step that has not started', () => {
        const { result, rerender } = renderHook(
            ({ steps }) => useRunFilm(stub<Parameters<typeof useRunFilm>[0]>(steps), DEF, { runId: 'run_1', runStatus: 'running' }),
            { initialProps: { steps: [rec('s1', stub<Parameters<typeof rec>[1]>('running'))] } },
        );
        beat();
        beat();
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result)), 'the server has not started s2 — the film waits').toEqual(['trg:success', 's1:running']);
        rerender({ steps: [rec('s1', stub<Parameters<typeof rec>[1]>('success')), rec('s2', stub<Parameters<typeof rec>[1]>('running'))] });
        beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:success', 's2:running']);
    });

    it('reduced motion gets the server\'s own steps, unpaced', () => {
        const steps = [rec('s1', stub<Parameters<typeof rec>[1]>('success')), rec('s2', stub<Parameters<typeof rec>[1]>('success'))];
        const { result } = renderHook(() => useRunFilm(stub<Parameters<typeof useRunFilm>[0]>(steps), DEF, { runId: 'run_1', reducedMotion: true }));
        expect(result.current).toBe(steps);
    });

    it('a second run starts its own film', () => {
        const steps = [rec('s1', stub<Parameters<typeof rec>[1]>('success')), rec('s2', stub<Parameters<typeof rec>[1]>('success')), rec('s3', stub<Parameters<typeof rec>[1]>('success'))];
        const { result, rerender } = renderHook(
            ({ runId }) => useRunFilm(stub<Parameters<typeof useRunFilm>[0]>(steps), DEF, { runId, runStatus: 'success' }),
            { initialProps: { runId: 'run_1' } },
        );
        for (let i = 0; i < 4; i++) beat();
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:success', 's1:success', 's2:success', 's3:success']);
        rerender({ runId: 'run_2' });
        expect(shown(stub<Parameters<typeof shown>[0]>(result))).toEqual(['trg:running']);
    });
});
