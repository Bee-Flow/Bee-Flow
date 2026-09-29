import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import followToBottom from './followToBottom';

/**
 * BFSF-453: a loaded conversation opens at its latest message and stays there
 * while late content (images, code blocks) lays out, until the reader scrolls
 * up. jsdom has no layout, so the scroller's geometry is stubbed and the
 * ResizeObserver is a hand-driven fake.
 */

let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { resizeCallbacks.push(this.cb); }
    disconnect() { resizeCallbacks = resizeCallbacks.filter(c => c !== this.cb); }
    unobserve() {}
}

/** A scroller with a child, a settable scrollTop and a scrollHeight we control. */
function scroller(initialHeight: number) {
    const el = document.createElement('div');
    el.appendChild(document.createElement('div'));
    let top = 0;
    let height = initialHeight;
    Object.defineProperty(el, 'scrollTop', {
        get: () => top,
        set: (v: number) => { top = Math.max(0, Math.min(v, height)); },
        configurable: true,
    });
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
    return {
        el,
        grow(to: number) { height = to; resizeCallbacks.forEach(cb => cb()); },
        userScrollTo(v: number) { top = v; el.dispatchEvent(new Event('scroll')); },
    };
}

beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('followToBottom', () => {
    it('lands on the bottom at once', () => {
        const s = scroller(4000);
        followToBottom(s.el);
        expect(s.el.scrollTop).toBe(4000);
    });

    it('follows content that grows after the first scroll', () => {
        const s = scroller(4000);
        followToBottom(s.el);
        s.grow(4600); // an image finished loading
        expect(s.el.scrollTop).toBe(4600);
    });

    it('lets go as soon as the reader scrolls up', () => {
        const s = scroller(4000);
        followToBottom(s.el);
        s.userScrollTo(1200);
        s.grow(4600);
        expect(s.el.scrollTop).toBe(1200);
    });

    it('does not mistake its own scroll for the reader', () => {
        const s = scroller(4000);
        followToBottom(s.el);
        s.el.dispatchEvent(new Event('scroll')); // the event our own pin causes
        s.grow(4600);
        expect(s.el.scrollTop).toBe(4600);
    });

    it('stops after its window, and on the returned stop()', () => {
        const a = scroller(4000);
        followToBottom(a.el, { durationMs: 1000 });
        vi.advanceTimersByTime(1000);
        a.grow(4600);
        expect(a.el.scrollTop).toBe(4000);

        const b = scroller(4000);
        const stop = followToBottom(b.el);
        stop();
        b.grow(4600);
        expect(b.el.scrollTop).toBe(4000);
    });
});
