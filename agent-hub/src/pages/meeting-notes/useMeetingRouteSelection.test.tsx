import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useMeetingRouteSelection from './useMeetingRouteSelection';

interface Props { initialMeetingId: string | null }

function setup(initialMeetingId: string | null, { withRouter = true } = {}) {
    const onNavigate = vi.fn();
    const openCapture = vi.fn();
    const hook = renderHook(
        (props: Props) => useMeetingRouteSelection({ initialMeetingId: props.initialMeetingId, onNavigate: withRouter ? onNavigate : null, openCapture }),
        { initialProps: { initialMeetingId } },
    );
    return { ...hook, onNavigate, openCapture };
}

afterEach(() => { window.__beeflowPendingMeetingId = null; });

describe('useMeetingRouteSelection: the "new" capture cue', () => {
    it('opens the capture flow on mount instead of selecting a meeting called "new"', () => {
        const { result, onNavigate, openCapture } = setup('new');
        expect(result.current.selectedId).toBeNull();
        expect(openCapture).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('studio/meeting-notes', { replace: true });
    });

    it('opens the capture flow when the route becomes "new" while the page is mounted, keeping the selection', () => {
        const { result, rerender, onNavigate, openCapture } = setup('A');
        rerender({ initialMeetingId: 'new' });
        expect(openCapture).toHaveBeenCalledTimes(1);
        expect(result.current.selectedId).toBe('A');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/meeting-notes/A', { replace: true });
    });

    it('still opens the capture flow without a router', () => {
        const { result, openCapture } = setup('new', { withRouter: false });
        expect(openCapture).toHaveBeenCalledTimes(1);
        expect(result.current.selectedId).toBeNull();
    });
});

describe('useMeetingRouteSelection: the route and the selection stay in step', () => {
    it('adopts a deep link to another meeting while mounted (sidebar recents, back/forward, palette)', () => {
        const { result, rerender, openCapture } = setup('A');
        expect(result.current.selectedId).toBe('A');
        rerender({ initialMeetingId: 'B' });
        expect(result.current.selectedId).toBe('B');
        rerender({ initialMeetingId: null });
        expect(result.current.selectedId).toBeNull();
        expect(openCapture).not.toHaveBeenCalled();
    });

    it('writes a selected meeting into the URL', () => {
        const { result, onNavigate } = setup(null);
        act(() => result.current.select('B'));
        expect(result.current.selectedId).toBe('B');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/meeting-notes/B', { replace: false });
    });

    it('drops a deleted meeting from the URL, so a reload does not reopen it', () => {
        const { result, onNavigate } = setup('A');
        act(() => result.current.select(null, { replace: true }));
        expect(result.current.selectedId).toBeNull();
        expect(onNavigate).toHaveBeenLastCalledWith('studio/meeting-notes', { replace: true });
    });

    it('takes the one-shot window handoff on mount and clears it', () => {
        window.__beeflowPendingMeetingId = 'P';
        const { result } = setup(null);
        expect(result.current.selectedId).toBe('P');
        expect(window.__beeflowPendingMeetingId).toBeNull();
    });
});
