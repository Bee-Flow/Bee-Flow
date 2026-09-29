import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useReducedMotion } from './useReducedMotion';

/**
 * The one motion switch the canvas choreography honours.
 *
 * src/test/setup.js polyfills matchMedia to "never matches", so the default
 * answer here is false; the tests below swap in a MediaQueryList they can
 * drive, to prove the hook reads the OS setting, follows a change, lets go
 * of its listener, and stays calm when matchMedia does not exist at all.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

function fakeMediaQueryList(initial, { legacy = false } = {}) {
    const listeners = new Set();
    const mql = {
        matches: initial,
        media: QUERY,
        // Flip the setting the way the browser would: mutate, then notify.
        fire(matches) {
            mql.matches = matches;
            listeners.forEach((fn) => fn({ matches, media: QUERY }));
        },
        listeners,
    };
    if (legacy) {
        mql.addListener = vi.fn((fn) => listeners.add(fn));
        mql.removeListener = vi.fn((fn) => listeners.delete(fn));
    } else {
        mql.addEventListener = vi.fn((type, fn) => { if (type === 'change') listeners.add(fn); });
        mql.removeEventListener = vi.fn((type, fn) => { if (type === 'change') listeners.delete(fn); });
    }
    return mql;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useReducedMotion', () => {
    it('is false under the test polyfill (no preference expressed)', () => {
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);
    });

    it('asks the browser for exactly the reduce query and reports its answer', () => {
        const mql = fakeMediaQueryList(true);
        const spy = vi.spyOn(window, 'matchMedia').mockImplementation(() => mql);
        const { result } = renderHook(() => useReducedMotion());
        expect(spy).toHaveBeenCalledWith(QUERY);
        expect(result.current).toBe(true);
    });

    it('follows a change of the OS setting while mounted, and unsubscribes on unmount', () => {
        const mql = fakeMediaQueryList(false);
        vi.spyOn(window, 'matchMedia').mockImplementation(() => mql);
        const { result, unmount } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);
        expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

        act(() => mql.fire(true));
        expect(result.current).toBe(true);

        act(() => mql.fire(false));
        expect(result.current).toBe(false);

        const [, listener] = mql.addEventListener.mock.calls[0];
        unmount();
        expect(mql.removeEventListener).toHaveBeenCalledWith('change', listener);
        expect(mql.listeners.size).toBe(0);
    });

    it('falls back to the deprecated addListener pair when addEventListener is missing', () => {
        const mql = fakeMediaQueryList(false, { legacy: true });
        vi.spyOn(window, 'matchMedia').mockImplementation(() => mql);
        const { result, unmount } = renderHook(() => useReducedMotion());
        expect(mql.addListener).toHaveBeenCalledTimes(1);

        act(() => mql.fire(true));
        expect(result.current).toBe(true);

        unmount();
        expect(mql.removeListener).toHaveBeenCalledTimes(1);
        expect(mql.listeners.size).toBe(0);
    });

    it('is false, without throwing, where matchMedia does not exist', () => {
        const original = window.matchMedia;
        window.matchMedia = undefined;
        try {
            const { result } = renderHook(() => useReducedMotion());
            expect(result.current).toBe(false);
        } finally {
            window.matchMedia = original;
        }
    });

    it('is false, without throwing, when matchMedia itself throws', () => {
        vi.spyOn(window, 'matchMedia').mockImplementation(() => { throw new Error('nope'); });
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);
    });
});
