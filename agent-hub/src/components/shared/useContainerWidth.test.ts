import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useContainerWidth from './useContainerWidth';

/**
 * The observed width of one element. jsdom lays nothing out, so each test
 * installs an observer that reports the width the test asks for, and keeps
 * the callback so a later resize can be played back.
 */

type Entry = { contentRect: { width: number }; borderBoxSize?: { inlineSize: number }[] };

function stubObserver() {
    const state: { cb: ((entries: Entry[]) => void) | null; observed: Element[]; disconnected: number } = {
        cb: null, observed: [], disconnected: 0,
    };
    vi.stubGlobal('ResizeObserver', class {
        constructor(cb: (entries: Entry[]) => void) { state.cb = cb; }
        observe(el: Element) { state.observed.push(el); }
        disconnect() { state.disconnected += 1; }
    });
    return state;
}

function element(width = 0): HTMLDivElement {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width } as DOMRect);
    return el;
}

describe('useContainerWidth', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is null before an element is attached', () => {
        stubObserver();
        const { result } = renderHook(() => useContainerWidth());
        expect(result.current[1]).toBeNull();
    });

    it('reads the width once on attach, then follows the observer (border box, whole pixels)', () => {
        const ro = stubObserver();
        const { result } = renderHook(() => useContainerWidth());
        const el = element(1112.4);
        act(() => result.current[0](el));
        expect(result.current[1]).toBe(1112);
        expect(ro.observed).toEqual([el]);
        act(() => ro.cb?.([{ contentRect: { width: 700 }, borderBoxSize: [{ inlineSize: 702 }] }]));
        expect(result.current[1]).toBe(702);
        act(() => ro.cb?.([{ contentRect: { width: 640.6 } }]));
        expect(result.current[1]).toBe(641);
    });

    it('a zero width (jsdom, a hidden element) is unknown, not zero', () => {
        stubObserver();
        const { result } = renderHook(() => useContainerWidth());
        act(() => result.current[0](element(0)));
        expect(result.current[1]).toBeNull();
    });

    it('disabled: no observer, no width, and attaching renders nothing again', () => {
        const ro = stubObserver();
        let renders = 0;
        const { result } = renderHook(() => { renders += 1; return useContainerWidth(false); });
        const before = renders;
        act(() => result.current[0](element(900)));
        expect(renders).toBe(before);
        expect(result.current[1]).toBeNull();
        expect(ro.observed).toEqual([]);
    });

    it('disconnects when the element goes away', () => {
        const ro = stubObserver();
        const { result } = renderHook(() => useContainerWidth());
        act(() => result.current[0](element(500)));
        act(() => result.current[0](null));
        expect(ro.disconnected).toBe(1);
        expect(result.current[1]).toBeNull();
    });

    it('without ResizeObserver it still reads the width once', () => {
        vi.stubGlobal('ResizeObserver', undefined);
        const { result } = renderHook(() => useContainerWidth());
        act(() => result.current[0](element(820)));
        expect(result.current[1]).toBe(820);
    });
});
