import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { RunFocus } from './runFocus';
import { useBannerMark } from './useFailedRunBanner';

const failure = (over: Partial<RunFocus> = {}): RunFocus => ({
    stepId: 's2', label: 'Code', done: 1, total: 3, state: 'error',
    startedAt: '2026-10-15T10:00:00.000Z', awaitingForm: false, ...over,
});
const def = (code: string) => ({ trigger: { id: 't' }, steps: [{ id: 's2', code }] });

describe('useBannerMark', () => {
    it('hides the failure after a dismiss, and shows a newer failure again', () => {
        const { result, rerender } = renderHook(({ f, d }) => useBannerMark(f, d), {
            initialProps: { f: failure() as RunFocus | null, d: def('a') },
        });
        expect(result.current.runFocus).not.toBeNull();
        act(() => result.current.dismiss());
        expect(result.current.runFocus).toBeNull();
        rerender({ f: failure({ startedAt: '2026-10-15T11:00:00.000Z' }), d: def('a') });
        expect(result.current.runFocus).not.toBeNull();
    });

    it('hides the failure once the failing step is edited', () => {
        const { result, rerender } = renderHook(({ f, d }) => useBannerMark(f, d), {
            initialProps: { f: failure() as RunFocus | null, d: def('a') },
        });
        expect(result.current.runFocus).not.toBeNull();
        rerender({ f: failure(), d: def('b') });
        expect(result.current.runFocus).toBeNull();
    });

    it('ignores layout: dragging the failing node does not hide the banner', () => {
        const { result, rerender } = renderHook(({ f, d }) => useBannerMark(f, d), {
            initialProps: { f: failure() as RunFocus | null, d: { trigger: { id: 't' }, steps: [{ id: 's2', code: 'a', position: { x: 1, y: 1 } }] } },
        });
        rerender({ f: failure(), d: { trigger: { id: 't' }, steps: [{ id: 's2', code: 'a', position: { x: 90, y: 40 } }] } });
        expect(result.current.runFocus).not.toBeNull();
    });

    it('keys the failure on the run id: a different run shows again after a dismiss', () => {
        const { result, rerender } = renderHook(({ k }) => useBannerMark(failure(), def('a'), k), { initialProps: { k: 'run_1' } });
        act(() => result.current.dismiss());
        expect(result.current.runFocus).toBeNull();
        rerender({ k: 'run_2' });
        expect(result.current.runFocus).not.toBeNull();
    });

    it('keeps the failure when another step changes, and never touches a live run', () => {
        const { result, rerender } = renderHook(({ f, d }) => useBannerMark(f, d), {
            initialProps: { f: failure() as RunFocus | null, d: def('a') },
        });
        rerender({ f: failure(), d: { trigger: { id: 't' }, steps: [{ id: 's2', code: 'a' }, { id: 's9', code: 'b' }] } });
        expect(result.current.runFocus).not.toBeNull();
        const live = failure({ state: 'running' });
        rerender({ f: live, d: def('zzz') });
        expect(result.current.runFocus).toBe(live);
    });
});
