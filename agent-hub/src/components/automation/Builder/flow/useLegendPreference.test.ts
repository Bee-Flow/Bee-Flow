import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getItem, setCurrentUser, setItem } from '../../../../utils/scopedStorage';
import { LEGEND_ROOM_HEIGHT_PX, LEGEND_ROOM_PX, useLegendPreference } from './useLegendPreference';

/**
 * The legend starts closed on a laptop-sized canvas (or the strip above an
 * open step drawer) and open on a big one, until the person opens or closes
 * it; from then on their choice holds.
 */
describe('useLegendPreference', () => {
    beforeEach(() => { localStorage.clear(); setCurrentUser('u1'); });
    afterEach(() => { localStorage.clear(); setCurrentUser(null); });

    const open = (width: number, height = 983) => renderHook(
        ({ w, h }) => useLegendPreference(w, h),
        { initialProps: { w: width, h: height } },
    );

    it('decides by the pane size until someone chooses', () => {
        expect(open(1280, 703).result.current[0]).toBe(false);
        expect(open(LEGEND_ROOM_PX, LEGEND_ROOM_HEIGHT_PX).result.current[0]).toBe(true);
        // 1920 wide, but a strip of 463px above the step drawer.
        expect(open(1920, 463).result.current[0]).toBe(false);
        // Not measured yet: closed, so a laptop never sees it flash open.
        expect(open(0, 0).result.current[0]).toBe(false);
    });

    it('follows the pane as it changes, while there is no choice', () => {
        const hook = open(1920);
        expect(hook.result.current[0]).toBe(true);
        hook.rerender({ w: 1280, h: 983 });
        expect(hook.result.current[0]).toBe(false);
        hook.rerender({ w: 1920, h: 463 });
        expect(hook.result.current[0]).toBe(false);
    });

    it('a choice holds, on this canvas and the next, whatever the width', () => {
        const hook = open(1280);
        act(() => hook.result.current[1]());
        expect(hook.result.current[0]).toBe(true);
        expect(getItem('routinesLegendChoice')).toBe('open');
        hook.rerender({ w: 900, h: 400 });
        expect(hook.result.current[0]).toBe(true);
        expect(open(1280).result.current[0]).toBe(true);

        act(() => hook.result.current[1]());
        expect(open(3440).result.current[0]).toBe(false);
    });

    it('reads the old key: a 0 was someone closing it; a 1 was written on every visit and says nothing', () => {
        setItem('routinesLegendOpen', '0');
        expect(open(1920).result.current[0]).toBe(false);
        setItem('routinesLegendOpen', '1');
        expect(open(1280).result.current[0]).toBe(false);
        expect(open(1920).result.current[0]).toBe(true);
    });
});
