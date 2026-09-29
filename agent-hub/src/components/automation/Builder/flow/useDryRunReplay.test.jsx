import { renderHook, act, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { useDryRunReplay, replayOrder, replayFrames, REPLAY_STEP_MS } from './useDryRunReplay';

/**
 * The test run replayed one card at a time. Fake timers throughout: a frame
 * is one interval tick of `stepMs`, and the assertions are about WHICH rows
 * are visible in which state at each tick — and that, once it is over, the
 * hook hands back the very array it was given.
 */
const DEF = { trigger: { id: 'trg', type: 'trigger' }, steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

const row = (stepId, over = {}) => ({ stepId, status: 'success', output: { ok: true }, ...over });

function mount(initial) {
    return renderHook((props) => useDryRunReplay(props), { initialProps: initial });
}

describe('replayOrder / replayFrames — the order rows are dealt in', () => {
    it('keeps array order when no row carries a start time, triggers first regardless', () => {
        const steps = [row('a'), row('trg'), row('b')];
        expect(replayOrder(steps, DEF).map(r => r.stepId)).toEqual(['trg', 'a', 'b']);
    });

    it('sorts by startedAt (or started_at) when every row has one', () => {
        const steps = [
            row('b', { startedAt: '2026-09-11T10:00:02Z' }),
            row('trg', { startedAt: '2026-09-11T10:00:00Z' }),
            row('a', { started_at: '2026-09-11T10:00:01Z' }),
        ];
        expect(replayOrder(steps, DEF).map(r => r.stepId)).toEqual(['trg', 'a', 'b']);
    });

    it('a row with no node on the canvas rides along with the next shown row, never as its own frame', () => {
        const steps = [row('trg'), row('x', { parentStepId: 'a' }), row('a'), row('b')];
        const frames = replayFrames(steps, DEF);
        expect(frames.map(f => f.currentStepId)).toEqual(['trg', 'a', 'b']);
        // 'x' is already there — real, not running — when 'a' is revealed.
        expect(frames[1].visibleSteps.map(r => `${r.stepId}:${r.status}`)).toEqual(['trg:success', 'x:success', 'a:running']);
    });

    it('without a definition every row is shown, in array order', () => {
        const steps = [row('q'), row('p')];
        expect(replayFrames(steps, null).map(f => f.currentStepId)).toEqual(['q', 'p']);
    });
});

describe('useDryRunReplay', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    it('mounting with rows already there replays nothing: visibleSteps IS steps', () => {
        const steps = [row('trg'), row('a'), row('b')];
        const { result } = mount({ steps, seq: 3, definition: DEF });
        expect(result.current.visibleSteps).toBe(steps);
        expect(result.current.replaying).toBe(false);
        expect(result.current.currentStepId).toBeNull();
    });

    it('a new seq reveals the rows one by one — running first, real once the next one starts — and ends on the same array', () => {
        const steps = [row('trg'), row('a'), row('b')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF });
        rerender({ steps, seq: 1, definition: DEF });

        // Frame 0, in the same commit the rows land: the trigger is running.
        expect(result.current.replaying).toBe(true);
        expect(result.current.currentStepId).toBe('trg');
        expect(result.current.visibleSteps).toHaveLength(1);
        expect(result.current.visibleSteps[0].status).toBe('running');

        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.currentStepId).toBe('a');
        expect(result.current.visibleSteps).toHaveLength(2);
        // The trigger settled into ITS row — the original object, not a copy.
        expect(result.current.visibleSteps[0]).toBe(steps[0]);
        expect(result.current.visibleSteps[1].status).toBe('running');

        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.currentStepId).toBe('b');
        expect(result.current.visibleSteps.map(r => r.status)).toEqual(['success', 'success', 'running']);

        // The last row settles: over, and the array is the caller's own.
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.replaying).toBe(false);
        expect(result.current.currentStepId).toBeNull();
        expect(result.current.visibleSteps).toBe(steps);

        // …and then nothing else happens, however long it sits there.
        act(() => { vi.advanceTimersByTime(10 * REPLAY_STEP_MS); });
        expect(result.current.visibleSteps).toBe(steps);
    });

    it('honours a custom stepMs', () => {
        const steps = [row('trg'), row('a')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF, stepMs: 100 });
        rerender({ steps, seq: 1, definition: DEF, stepMs: 100 });
        expect(result.current.currentStepId).toBe('trg');
        act(() => { vi.advanceTimersByTime(100); });
        expect(result.current.currentStepId).toBe('a');
        act(() => { vi.advanceTimersByTime(100); });
        expect(result.current.replaying).toBe(false);
    });

    it('a new seq mid-replay restarts from the first row of the new run', () => {
        const steps1 = [row('trg'), row('a'), row('b')];
        const steps2 = [row('trg', { output: 2 }), row('a', { output: 2 }), row('b', { output: 2 })];
        const { result, rerender } = mount({ steps: steps1, seq: 0, definition: DEF });
        rerender({ steps: steps1, seq: 1, definition: DEF });
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.currentStepId).toBe('a');

        rerender({ steps: steps2, seq: 2, definition: DEF });
        expect(result.current.currentStepId).toBe('trg');
        expect(result.current.visibleSteps[0].output).toBe(2);
        // The old interval is gone: exactly one advance per tick from here.
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.currentStepId).toBe('a');
        act(() => { vi.advanceTimersByTime(2 * REPLAY_STEP_MS); });
        expect(result.current.visibleSteps).toBe(steps2);
    });

    it('reduced motion: the rows land at once, nothing runs', () => {
        const steps = [row('trg'), row('a'), row('b')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF, reducedMotion: true });
        rerender({ steps, seq: 1, definition: DEF, reducedMotion: true });
        expect(result.current.replaying).toBe(false);
        expect(result.current.visibleSteps).toBe(steps);
        expect(result.current.currentStepId).toBeNull();
    });

    it('fewer than two rows: nothing to replay', () => {
        const steps = [row('trg')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF });
        rerender({ steps, seq: 1, definition: DEF });
        expect(result.current.replaying).toBe(false);
        expect(result.current.visibleSteps).toBe(steps);
    });

    it('disabling mid-replay cancels it for good — re-enabling does not resume', () => {
        const steps = [row('trg'), row('a'), row('b')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF, enabled: true });
        rerender({ steps, seq: 1, definition: DEF, enabled: true });
        expect(result.current.replaying).toBe(true);
        rerender({ steps, seq: 1, definition: DEF, enabled: false });
        expect(result.current.replaying).toBe(false);
        expect(result.current.visibleSteps).toBe(steps);
        rerender({ steps, seq: 1, definition: DEF, enabled: true });
        expect(result.current.replaying).toBe(false);
        expect(result.current.visibleSteps).toBe(steps);
    });

    it('a seq that changes while disabled is remembered, so enabling later replays nothing', () => {
        const steps = [row('trg'), row('a')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF, enabled: false });
        rerender({ steps, seq: 1, definition: DEF, enabled: false });
        rerender({ steps, seq: 1, definition: DEF, enabled: true });
        expect(result.current.replaying).toBe(false);
    });

    it('rows whose step is not on the canvas are revealed instantly, never as the current step', () => {
        const steps = [row('trg'), row('ghost-of-a-deleted-step'), row('a')];
        const { result, rerender } = mount({ steps, seq: 0, definition: DEF });
        rerender({ steps, seq: 1, definition: DEF });
        expect(result.current.currentStepId).toBe('trg');
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.currentStepId).toBe('a');
        expect(result.current.visibleSteps.map(r => r.stepId)).toEqual(['trg', 'ghost-of-a-deleted-step', 'a']);
        expect(result.current.visibleSteps[1].status).toBe('success');
    });

    it('survives a StrictMode double mount without starting twice', () => {
        const steps = [row('trg'), row('a')];
        const { result, rerender } = renderHook((props) => useDryRunReplay(props), {
            initialProps: { steps, seq: 0, definition: DEF },
            wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
        });
        expect(result.current.replaying).toBe(false);
        rerender({ steps, seq: 1, definition: DEF });
        expect(result.current.currentStepId).toBe('trg');
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        // One interval, one advance: still on 'a', not already over.
        expect(result.current.currentStepId).toBe('a');
        act(() => { vi.advanceTimersByTime(REPLAY_STEP_MS); });
        expect(result.current.visibleSteps).toBe(steps);
    });
});
