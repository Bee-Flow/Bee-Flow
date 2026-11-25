/**
 * The motion of the Cowork page, as class names. The keyframes and rules are in src/app.css ("Cowork motion"); the
 * shared classes below handle arrivals, row expansion and status changes.
 * Only active work indicators loop, and `prefers-reduced-motion: reduce` switches all of it off.
 *
 * At rest nothing here leaves a `transform` (or a filter) on an element: text on a transformed layer renders soft on
 * many screens. ENTER fills backwards only, so the finished element carries no transform at all.
 *
 *   ENTER          an element arriving (a page, a card, a toast): fades in and rises 4px in 160ms, once, when it mounts.
 *                    <div className={`${CARD} ${ENTER}`}>
 *   STAGGER(i)     ENTER for the i-th row of a list (0-based): the first six start 30ms after one another, the rest
 *                  are simply there.
 *                    {rows.map((row, i) => <li key={row.id} className={STAGGER(i)}>…)}
 *   SWAP           a value or status that changes: give the element `key={value}` and this class, and the new value
 *                  fades in over 120ms.
 *                    <span key={status} className={SWAP}>{label}</span>
 *   SPIN           the spinner, while work is in progress.
 *   TINT           colour, border and background changes take 120ms (a hover, a tone that changes).
 *   <Expand open>  a row or disclosure opening in place: its height grows in 180ms, and it renders nothing while
 *                  closed. EXPAND is the class it puts on its wrapper.
 *                    <Expand open={open} id={bodyId} className="flex flex-col gap-3 pt-3">…</Expand>
 *   useLeave(open) for an element that should fade out before it is gone (a card that was answered, the Undo toast):
 *                    const { ref, mounted, leaving } = useLeave<HTMLDivElement>(open);
 *                    {mounted && <div ref={ref} className={leaving ? LEAVE : ENTER}>…</div>}
 *   useReveal(open) for a row that opens in place: once it has opened it is scrolled into view when part of it is
 *                  off screen (the row above it may have closed and pulled it up, or its body may reach under the fold).
 *                    const ref = useReveal<HTMLDivElement>(open);
 *
 * No motion library: CSS keyframes driven by React state. Where the browser reports no animations (reduced motion, a
 * test's DOM), an element that leaves is gone at once.
 */
import { createElement, useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';

export const ENTER = 'cowork-enter';
export const SWAP = 'cowork-swap';
export const LEAVE = 'cowork-leave';
export const SPIN = 'cowork-spin';
export const EXPAND = 'cowork-expand';
export const TINT = 'transition-colors duration-[120ms] motion-reduce:transition-none';

// Literal class names, so a search for one finds both this file and the stylesheet.
const STAGGERED = ['cowork-enter', 'cowork-enter cowork-stagger-1', 'cowork-enter cowork-stagger-2', 'cowork-enter cowork-stagger-3', 'cowork-enter cowork-stagger-4', 'cowork-enter cowork-stagger-5'] as const;

/** ENTER for the i-th row of a list: 30ms apart for the first six rows, no motion for the rows after them. */
export function STAGGER(i: number): string {
    return STAGGERED[i] ?? '';
}

/** Whether this DOM can say when an element's animations end (a browser can; a test's DOM cannot). */
const reportsAnimations = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.getAnimations === 'function';

export interface Leave<T extends HTMLElement> {
    /** Put it on the element that carries the animation. */
    ref: RefObject<T | null>;
    /** Render the element while this holds: it is open, or still on its way out. */
    mounted: boolean;
    /** Closed, and its way out is still playing. */
    leaving: boolean;
    /** Open, and its way in has ended. */
    settled: boolean;
}

/**
 * Follows `open` through the element's own animations: `mounted` stays true after `open` turns false until the
 * animation that plays then has ended, and `settled` turns true once the way in has ended.
 */
export function useLeave<T extends HTMLElement = HTMLDivElement>(open: boolean): Leave<T> {
    const ref = useRef<T>(null);
    // The value of `open` whose animation has ended.
    const [settledFor, setSettledFor] = useState(open);
    const moving = settledFor !== open && reportsAnimations();
    useEffect(() => {
        if (!moving) return undefined;
        let live = true;
        // The element's own animations only: a spinner inside it never ends.
        const running = ref.current?.getAnimations() ?? [];
        void Promise.allSettled(running.map((animation) => animation.finished)).then(() => { if (live) setSettledFor(open); });
        return () => { live = false; };
    }, [moving, open]);
    return { ref, mounted: open || moving, leaving: !open && moving, settled: open && !moving };
}

/** How long EXPAND takes (src/app.css), with a frame to spare: by then the row that opened and the one that closed have their final height. */
const EXPANDED_AFTER_MS = 200;

/** Keeps a row that just opened on screen. Put the ref on the row; it scrolls only when part of the row is outside. */
export function useReveal<T extends HTMLElement = HTMLDivElement>(open: boolean): RefObject<T | null> {
    const ref = useRef<T>(null);
    const wasOpen = useRef(open);
    useEffect(() => {
        const opened = open && !wasOpen.current;
        wasOpen.current = open;
        if (!opened) return undefined;
        const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const timer = window.setTimeout(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' }), still ? 0 : EXPANDED_AFTER_MS);
        return () => window.clearTimeout(timer);
    }, [open]);
    return ref;
}

interface ExpandProps {
    open: boolean;
    /** The id of the body, for the `aria-controls` of what opens it. */
    id?: string;
    /** Classes for the body (its padding and layout). */
    className?: string;
    children: ReactNode;
}

function openState(open: boolean, settled: boolean): 'false' | 'true' | 'settled' {
    if (!open) return 'false';
    return settled ? 'settled' : 'true';
}

/** A body that opens in place: it grows to its own height, and renders nothing while it is closed. */
export function Expand({ open, id, className, children }: ExpandProps): ReactElement | null {
    const { ref, mounted, settled } = useLeave<HTMLDivElement>(open);
    if (!mounted) return null;
    return createElement('div', { ref, className: EXPAND, 'data-open': openState(open, settled), inert: !open },
        createElement('div', { id, className }, children));
}
