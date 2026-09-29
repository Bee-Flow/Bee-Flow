import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resolveOrigin } from './ribbonOrigin';
import { useRibbonSpotlight, SPOT_CLASS, SPOT_RETRIES } from './useRibbonSpotlight';

/**
 * The spotlight is a class on the ribbon command the model is drawing from.
 * Pinned: it lands on the resolved tile and moves when the keys change; it
 * leaves on disable, on empty keys and on unmount; a tile that mounts a few
 * frames late is found by the rAF retry, and one that never mounts is given
 * up on after SPOT_RETRIES frames. jsdom lays nothing out, so the stamped
 * elements get real rects by hand and resolveOrigin is used as is.
 */
const FAKES = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'];

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

function makeRoot() {
    const root = document.createElement('div');
    root.setAttribute('data-ribbon-origin', 'ribbon');
    root.getBoundingClientRect = () => rect(0, 0, 1200, 48);
    const stamp = (key, r = rect(300, 10, 80, 24)) => {
        const el = document.createElement('button');
        el.setAttribute('data-ribbon-origin', key);
        el.getBoundingClientRect = () => r;
        root.appendChild(el);
        return el;
    };
    document.body.appendChild(root);
    return { root, stamp };
}

function propsFor(over = {}) {
    return { ribbonRootRef: { current: null }, keys: [], enabled: true, ...over };
}

describe('useRibbonSpotlight', () => {
    let fx;
    beforeEach(() => {
        vi.useFakeTimers({ toFake: FAKES });
        fx = makeRoot();
    });
    afterEach(() => {
        vi.useRealTimers();
        fx.root.remove();
    });

    it('puts the class on the first key that resolves, and takes it off when the keys empty', () => {
        const gmail = fx.stamp('app:gmail');
        const props = propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:google_drive', 'app:gmail'] });
        const { rerender } = renderHook((p) => useRibbonSpotlight(p), { initialProps: props });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
        rerender({ ...props, keys: [] });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(false);
    });

    it('moves with the keys: the old tile is cleared, the new one lit', () => {
        const gmail = fx.stamp('app:gmail');
        const drive = fx.stamp('app:google_drive', rect(400, 10, 80, 24));
        const props = propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'] });
        const { rerender } = renderHook((p) => useRibbonSpotlight(p), { initialProps: props });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
        rerender({ ...props, keys: ['app:google_drive'] });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(false);
        expect(drive.classList.contains(SPOT_CLASS)).toBe(true);
        // The same keys as a new array re-resolve nothing and leave the class alone.
        rerender({ ...props, keys: ['app:google_drive'] });
        expect(drive.classList.contains(SPOT_CLASS)).toBe(true);
        expect(document.querySelectorAll(`.${SPOT_CLASS}`).length).toBe(1);
    });

    it('a tile that mounts a few frames late is found by the retry', () => {
        const props = propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'] });
        renderHook((p) => useRibbonSpotlight(p), { initialProps: props });
        expect(document.querySelectorAll(`.${SPOT_CLASS}`).length).toBe(0);
        // Two frames pass with nothing; the tile lands; the next frame finds it.
        act(() => { vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame(); });
        const gmail = fx.stamp('app:gmail');
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(false);
        act(() => { vi.advanceTimersToNextFrame(); });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
    });

    it('gives up after SPOT_RETRIES frames; a change of keys tries again', () => {
        const resolve = vi.fn(() => null);
        const props = propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'], resolve });
        const { rerender } = renderHook((p) => useRibbonSpotlight(p), { initialProps: props });
        expect(resolve).toHaveBeenCalledTimes(1);
        act(() => { for (let i = 0; i < SPOT_RETRIES + 5; i += 1) vi.advanceTimersToNextFrame(); });
        expect(resolve).toHaveBeenCalledTimes(1 + SPOT_RETRIES);
        rerender({ ...props, keys: ['app:outlook'] });
        expect(resolve).toHaveBeenCalledTimes(2 + SPOT_RETRIES);
    });

    it('disabled → the class comes off and nothing is looked up; re-enabled → it is back', () => {
        const gmail = fx.stamp('app:gmail');
        const resolve = vi.fn(resolveOrigin);
        const props = propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'], resolve });
        const { rerender } = renderHook((p) => useRibbonSpotlight(p), { initialProps: props });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
        rerender({ ...props, enabled: false });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(false);
        const calls = resolve.mock.calls.length;
        act(() => { vi.advanceTimersToNextFrame(); });
        expect(resolve.mock.calls.length).toBe(calls);
        rerender({ ...props, enabled: true });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
    });

    it('a tile with no width is not on screen (a collapsed cluster): nothing is lit', () => {
        const hidden = fx.stamp('app:gmail', rect(0, 0, 0, 0));
        renderHook((p) => useRibbonSpotlight(p), { initialProps: propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'] }) });
        act(() => { for (let i = 0; i < SPOT_RETRIES + 1; i += 1) vi.advanceTimersToNextFrame(); });
        expect(hidden.classList.contains(SPOT_CLASS)).toBe(false);
    });

    it('no ribbon root → nothing, without throwing', () => {
        expect(() => {
            renderHook((p) => useRibbonSpotlight(p), { initialProps: propsFor({ ribbonRootRef: { current: null }, keys: ['app:gmail'] }) });
            act(() => { vi.advanceTimersToNextFrame(); });
        }).not.toThrow();
        expect(document.querySelectorAll(`.${SPOT_CLASS}`).length).toBe(0);
    });

    it('unmount takes the class off and cancels a pending retry', () => {
        const gmail = fx.stamp('app:gmail');
        const { unmount } = renderHook((p) => useRibbonSpotlight(p), { initialProps: propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:gmail'] }) });
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(true);
        unmount();
        expect(gmail.classList.contains(SPOT_CLASS)).toBe(false);

        const resolve = vi.fn(() => null);
        const pending = renderHook((p) => useRibbonSpotlight(p), { initialProps: propsFor({ ribbonRootRef: { current: fx.root }, keys: ['app:outlook'], resolve }) });
        pending.unmount();
        act(() => { vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame(); });
        expect(resolve).toHaveBeenCalledTimes(1);
    });
});
