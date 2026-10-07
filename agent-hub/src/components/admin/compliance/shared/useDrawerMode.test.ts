import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useDrawerMode, { drawerModeFor } from './useDrawerMode';

/**
 * Where a register's drawer goes. The numbers are the real ones: the rail
 * takes 300px and the page frame 28px of padding, so the register's row is
 * 1112px at a 1440 window, 952px at 1280 and 696px at 1024.
 */

describe('drawerModeFor: the rule', () => {
    it('a phone always gets the modal', () => {
        expect(drawerModeFor(1112, { isMobile: true })).toBe('modal');
        expect(drawerModeFor(null, { isMobile: true })).toBe('modal');
    });

    it('inline only while the table keeps at least minTable beside the drawer (and the gap)', () => {
        expect(drawerModeFor(1112)).toBe('inline'); // 1440: 1112 - 380 - 12 = 720
        expect(drawerModeFor(952)).toBe('overlay'); // 1280: 560 left for the table
        expect(drawerModeFor(696)).toBe('overlay'); // 1024
        expect(drawerModeFor(380 + 12 + 640)).toBe('inline');
        expect(drawerModeFor(380 + 12 + 639)).toBe('overlay');
    });

    it('honours the drawer width, minTable and gap it is given', () => {
        expect(drawerModeFor(1112, { drawerWidth: 480 })).toBe('overlay');
        expect(drawerModeFor(952, { minTable: 520 })).toBe('inline');
        expect(drawerModeFor(1020, { gap: 0 })).toBe('inline');
        expect(drawerModeFor(1019, { gap: 0 })).toBe('overlay');
    });

    it('an unmeasured width keeps the inline layout the pages had', () => {
        expect(drawerModeFor(null)).toBe('inline');
        expect(drawerModeFor(0)).toBe('inline');
    });
});

describe('useDrawerMode: the observed width', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function element(width: number): HTMLDivElement {
        const el = document.createElement('div');
        el.getBoundingClientRect = () => ({ width } as DOMRect);
        return el;
    }

    it('decides on the width of the element the ref sits on', () => {
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        const { result, rerender } = renderHook((props: { isMobile: boolean }) => useDrawerMode(props), {
            initialProps: { isMobile: false },
        });
        expect(result.current[1]).toBe('inline');
        act(() => result.current[0](element(952)));
        expect(result.current[1]).toBe('overlay');
        act(() => result.current[0](element(1112)));
        expect(result.current[1]).toBe('inline');
        rerender({ isMobile: true });
        expect(result.current[1]).toBe('modal');
    });
});
