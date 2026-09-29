import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { useSidebarFlyouts, headingInto } from './useSidebarFlyouts';

/* The sidebar flyouts open beside a row and are taller than it. Cutting the
   corner from the row to a low item in the panel crosses the rows below it
   and the gap — this hook must read that as "on my way to the panel", not
   as "hovering something else". Geometry is faked: jsdom lays nothing out. */

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const anchorAt = (top) => ({ getBoundingClientRect: () => rect(20, top, 260, 40) });

// A stand-in for the panel NavRow renders: the hook finds it by test id.
let panels = [];
const mountPanel = (testid, r) => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', testid);
    el.getBoundingClientRect = () => r;
    document.body.appendChild(el);
    panels.push(el);
};

const move = (x, y) => act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    panels.forEach(el => el.remove());
    panels = [];
    vi.useRealTimers();
});

const setup = () => renderHook(() => useSidebarFlyouts({ current: null }));

describe('headingInto', () => {
    const panel = rect(480, 500, 288, 1000);
    it('is true for a diagonal that meets the panel edge', () => {
        expect(headingInto({ x: 300, y: 545 }, { x: 320, y: 570 }, panel)).toBe(true);
    });
    it('is false when moving straight down the sidebar', () => {
        expect(headingInto({ x: 300, y: 545 }, { x: 300, y: 600 }, panel)).toBe(false);
    });
    it('is false when moving away from the panel', () => {
        expect(headingInto({ x: 300, y: 545 }, { x: 280, y: 560 }, panel)).toBe(false);
    });
    it('is false for a diagonal that would miss the panel', () => {
        expect(headingInto({ x: 300, y: 545 }, { x: 310, y: 300 }, panel)).toBe(false);
    });
    it('is true once the pointer is over the panel', () => {
        expect(headingInto({ x: 600, y: 800 }, { x: 600, y: 810 }, panel)).toBe(true);
    });
    it('ignores a panel that has no layout', () => {
        expect(headingInto({ x: 300, y: 545 }, { x: 320, y: 570 }, rect(0, 0, 0, 0))).toBe(false);
    });
});

describe('useSidebarFlyouts — aim detection', () => {
    it('opens a panel on hover at once', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        expect(result.current.flyout?.key).toBe('studio');
    });

    it('keeps the panel while the pointer crosses the row below on its way there', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        // Leave the Studio row diagonally, over the Apps row, aiming at the panel.
        move(300, 545);
        move(330, 590);
        act(() => result.current.scheduleFlyoutClose('studio'));
        act(() => result.current.hoverFlyout('apps', anchorAt(593)));
        expect(result.current.flyout?.key).toBe('studio');
        act(() => vi.advanceTimersByTime(180));
        expect(result.current.flyout?.key).toBe('studio');
        // Still on course, across the gap…
        move(400, 700);
        act(() => vi.advanceTimersByTime(100));
        expect(result.current.flyout?.key).toBe('studio');
        // …and into the panel: nothing swaps, nothing closes.
        move(600, 900);
        act(() => vi.advanceTimersByTime(2000));
        expect(result.current.flyout?.key).toBe('studio');
    });

    it('swaps to the hovered row once the pointer stops heading for the panel', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(300, 545);
        move(330, 590);
        act(() => result.current.hoverFlyout('apps', anchorAt(593)));
        expect(result.current.flyout?.key).toBe('studio');
        // Changes its mind: settles on the Apps row and moves along it.
        move(200, 610);
        move(180, 612);
        act(() => vi.advanceTimersByTime(100));
        expect(result.current.flyout?.key).toBe('apps');
    });

    it('does not swap when the pointer has left the row that asked', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(300, 545);
        move(330, 590);
        act(() => result.current.hoverFlyout('apps', anchorAt(593)));
        // Veers off past the panel's bottom, no longer over Apps either.
        move(340, 1700);
        move(345, 1750);
        act(() => vi.advanceTimersByTime(100));
        expect(result.current.flyout?.key).toBe('studio');
    });

    it('swaps immediately when the hover is not on course for the open panel', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(200, 545);
        move(200, 600);     // straight down the sidebar
        act(() => result.current.hoverFlyout('apps', anchorAt(593)));
        expect(result.current.flyout?.key).toBe('apps');
    });

    it('still closes after the grace period when the pointer simply leaves', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(300, 545);
        move(280, 545);
        act(() => result.current.scheduleFlyoutClose('studio'));
        act(() => vi.advanceTimersByTime(180));
        expect(result.current.flyout).toBeNull();
    });

    it('gives up holding a close once the cap runs out', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(300, 545);
        move(330, 590);
        act(() => result.current.scheduleFlyoutClose('studio'));
        act(() => vi.advanceTimersByTime(180));
        expect(result.current.flyout?.key).toBe('studio');
        // The trail is stale but never refreshed: the pointer parked there.
        act(() => vi.advanceTimersByTime(1600));
        expect(result.current.flyout).toBeNull();
    });

    it('applies the same rule to the second level', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        act(() => result.current.hoverSubFlyout('automations', anchorAt(580)));
        mountPanel('subflyout-automations', rect(776, 575, 288, 400));
        move(600, 600);
        move(640, 640);
        act(() => result.current.scheduleSubFlyoutClose('automations'));
        act(() => result.current.hoverSubFlyout('datatables', anchorAt(690)));
        act(() => vi.advanceTimersByTime(180));
        expect(result.current.subFlyout?.key).toBe('automations');
        move(850, 800);
        act(() => vi.advanceTimersByTime(500));
        expect(result.current.subFlyout?.key).toBe('automations');
    });

    it('a click swaps regardless of where the pointer is going', () => {
        const { result } = setup();
        act(() => result.current.hoverFlyout('studio', anchorAt(525)));
        mountPanel('flyout-studio', rect(480, 505, 288, 1000));
        move(300, 545);
        move(330, 590);
        act(() => result.current.openFlyout('apps', anchorAt(593)));
        expect(result.current.flyout?.key).toBe('apps');
    });
});
