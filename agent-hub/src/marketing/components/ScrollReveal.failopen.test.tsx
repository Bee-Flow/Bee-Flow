import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useScrollReveal, REVEAL_FAILSAFE_MS } from './ScrollReveal';

// An IntersectionObserver whose callback NEVER fires.
const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn> }[] = [];

class SilentObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor() { observers.push(this); }
}

function Page({ extra = false }: { extra?: boolean }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useScrollReveal(ref, 'k');
    return (
        <div ref={ref}>
            <p className="reveal" data-testid="below" data-top="5000">below</p>
            <p className="reveal" data-testid="far" data-top="9000">far</p>
            {extra && <p className="reveal" data-testid="late" data-top="5000">late</p>}
        </div>
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', SilentObserver);
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const top = Number(this.getAttribute('data-top') ?? 0);
        return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) };
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('scroll reveal fails open', () => {
    it('shows an element that ended up in or above the viewport after the timeout when the observer never fires', () => {
        const { getByTestId } = render(<Page />);
        const el = getByTestId('below');
        expect(el.classList.contains('visible')).toBe(false);
        el.setAttribute('data-top', '-900');
        act(() => { vi.advanceTimersByTime(REVEAL_FAILSAFE_MS + 1); });
        expect(el.classList.contains('visible')).toBe(true);
        // far below the fold stays hidden for the normal scroll animation
        expect(getByTestId('far').classList.contains('visible')).toBe(false);
    });

    it('shows an element that scrolls into view when the observer never fires', () => {
        const { getByTestId } = render(<Page />);
        const el = getByTestId('below');
        el.setAttribute('data-top', '100');
        act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(200); });
        expect(el.classList.contains('visible')).toBe(true);
    });

    it('sweeps on pageshow (bfcache restore)', () => {
        const { getByTestId } = render(<Page />);
        const el = getByTestId('below');
        el.setAttribute('data-top', '100');
        act(() => { window.dispatchEvent(new Event('pageshow')); });
        expect(el.classList.contains('visible')).toBe(true);
    });

    it('observes an element added after mount', async () => {
        const { getByTestId, rerender } = render(<Page />);
        const before = observers[0].observe.mock.calls.length;
        rerender(<Page extra />);
        await act(async () => { await Promise.resolve(); });
        const late = getByTestId('late');
        expect(observers[0].observe.mock.calls.slice(before).map(c => c[0])).toContain(late);
    });

    it('disconnects observers and clears timers on unmount', () => {
        const { getByTestId, unmount } = render(<Page />);
        const el = getByTestId('below');
        unmount();
        expect(observers[0].disconnect).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        el.setAttribute('data-top', '0');
        act(() => { vi.advanceTimersByTime(REVEAL_FAILSAFE_MS * 2); });
        expect(el.classList.contains('visible')).toBe(false);
    });
});
