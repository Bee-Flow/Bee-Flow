import { useCallback, useEffect, useRef, type RefObject } from 'react';

export interface StickToBottomOptions {
    /** The scroller. */
    containerRef: RefObject<HTMLElement | null>;
    /** The box inside it that grows; defaults to the container's first element child. */
    contentRef?: RefObject<HTMLElement | null> | null;
    /** How far from the bottom still counts as "at the bottom", in px. */
    slack?: number;
}

export interface StickToBottom {
    onScroll: () => void;
    forceStick: () => void;
    isStuck: () => boolean;
}

/**
 * Keep a scrolling list pinned to its newest content — and stop pinning it the
 * moment the reader scrolls away.
 *
 * Why an observer and not a dependency array. In the two builder panes the
 * thing that grows is rarely a new MESSAGE: it is a tool-call row inside the
 * assistant turn that is already on screen, a plan card, the waiting card, or
 * markdown that lands 150 ms after the state did (MarkdownRenderer throttles
 * streaming content). The routine pane scrolled on `messages.length` and so
 * never followed a build step at all; the App Studio pane jumped on every
 * `messages` identity change, which fired BEFORE the content it was trying to
 * scroll past had been laid out. Watching the content box instead catches all
 * of it, whatever state it came from (owner, 2026-09-16).
 */
export default function useStickToBottom(
    { containerRef, contentRef = null, slack = 48 }: StickToBottomOptions,
): StickToBottom {
    const stick = useRef(true);

    // scrollTop on the container, not scrollIntoView on a sentinel: the latter
    // also scrolls every scrollable ANCESTOR, which in a builder means the
    // page moving under a pane that only wanted its own list moved.
    // Always instant, never smooth — a smooth scroll fires `scroll` events all
    // the way down, each one a position far from the bottom, and onScroll
    // would read those as "the reader moved away" mid-animation. Instant also
    // means the scroll event our own scroll causes lands AT the bottom, so it
    // re-decides `stick` to exactly what it already was.
    const scrollNow = useCallback(() => {
        const el = containerRef && containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [containerRef]);

    const onScroll = useCallback(() => {
        const el = containerRef && containerRef.current;
        if (!el) return;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
    }, [containerRef, slack]);

    const forceStick = useCallback(() => {
        stick.current = true;
        scrollNow();
    }, [scrollNow]);

    useEffect(() => {
        const el = containerRef && containerRef.current;
        if (!el) return undefined;
        const follow = () => { if (stick.current) scrollNow(); };
        // The content box is resolved on every tick, never captured once: a
        // pane that swaps an empty state for the message list replaces the
        // node this effect would otherwise still be watching, and the effect
        // does not re-run (its deps are refs).
        const contentNow = () => (contentRef && contentRef.current) || el.firstElementChild || el;

        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
        if (ro) { ro.observe(el); ro.observe(contentNow()); }
        // The scroller's own box shrinks when something beside it grows (a
        // composer taking a third line, a reply chip, a notice row, the
        // on-screen keyboard): scrollTop stays, so the newest rows slide under
        // whatever grew unless a pinned list re-pins.
        // A row that appears without changing the measured height (an image
        // swapped in, a <details> opening, markdown landing a beat late) still
        // moves the bottom — and this is what catches the node swap.
        const mo = typeof MutationObserver === 'function'
            ? new MutationObserver(() => { if (ro) ro.observe(contentNow()); follow(); })
            : null;
        if (mo) mo.observe(el, { childList: true, subtree: true, characterData: true });
        follow();
        return () => { if (ro) ro.disconnect(); if (mo) mo.disconnect(); };
    }, [containerRef, contentRef, scrollNow]);

    return { onScroll, forceStick, isStuck: () => stick.current };
}
