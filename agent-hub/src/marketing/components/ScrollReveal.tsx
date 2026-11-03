import React, { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Mounts a single IntersectionObserver that promotes any `.reveal` element
 * to `.visible` once it enters the viewport. Call once at the page root.
 *
 * `contentKey` scopes the effect: the observer rebuilds only when the
 * rendered content changes (new/removed blocks), not on every render —
 * the old dep-less version constructed a fresh observer per render.
 *
 * ABOVE THE FOLD IS EXEMPT, synchronously. `.reveal` starts at `opacity: 0`,
 * and waiting for the IntersectionObserver's async callback meant the hero —
 * h1 included — was invisible for at least one painted frame after React
 * mounted. The h1 is the page's LCP element, so Lighthouse clocked LCP at
 * "whenever the observer got around to it" (11.9 s on throttled mobile,
 * where the callback queued behind bundle parsing). A layout effect runs
 * before the browser paints the mounted tree: anything already inside the
 * viewport gets `.visible` in that same pre-paint pass and never renders
 * invisible at all. The entrance animation remains for everything below the
 * fold, which is the only place a human could see it anyway — an element
 * already on screen at page load "animating in" is indistinguishable from
 * flicker.
 */
/**
 * A positive bottom margin makes the observer fire while the element is still
 * below the viewport, so a block is already visible when it scrolls in (and a
 * fast scroll or full-page capture does not show it as a blank gap).
 */
export const REVEAL_OBSERVER_OPTIONS = { threshold: 0.1, rootMargin: '0px 0px 15% 0px' };

/** Delay before the safety net marks in-viewport `.reveal` elements visible. */
export const REVEAL_FAILSAFE_MS = 1000;
const SCROLL_SETTLE_MS = 150;
const PENDING = '.reveal:not(.visible)';

function inOrAboveViewport(el: Element): boolean {
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    return el.getBoundingClientRect().top < viewportH;
}

/**
 * Content must never depend on JS to become visible. The observer is the
 * nice path; three safety nets sit behind it for the cases where its
 * callback never runs for an element (observer attached before the element
 * existed, element re-mounted after hydration, a parent that breaks
 * intersection, bfcache restore):
 *  - a timeout, `pageshow` and a scroll-settle check mark every pending
 *    element that is in or above the viewport visible;
 *  - a MutationObserver picks up `.reveal` elements added after the first pass.
 */
export function useScrollReveal(rootRef: RefObject<HTMLElement | null> | null | undefined, contentKey?: unknown) {
    useLayoutEffect(() => {
        const root: ParentNode = rootRef?.current || document;
        const reduced = typeof window !== 'undefined' &&
            !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        let observer: IntersectionObserver | null = null;

        const observe = (el: Element) => {
            if (!observer) {
                observer = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            entry.target.classList.add('visible');
                            observer?.unobserve(entry.target);
                        }
                    }
                }, REVEAL_OBSERVER_OPTIONS);
            }
            observer.observe(el);
        };

        // All reads, then all writes — one layout pass, no thrash.
        // `reveal-instant` zeroes the transition for the in-view batch: the
        // rect reads flushed style with the element at opacity 0, so adding
        // `.visible` alone would still FADE it in. The first viewport must
        // render visible immediately; the entrance animation remains below
        // the fold.
        const process = (elements: Element[]) => {
            if (!elements.length) return;
            if (reduced) {
                elements.forEach(el => el.classList.add('visible'));
                return;
            }
            const inView: Element[] = [];
            const below: Element[] = [];
            for (const el of elements) (inOrAboveViewport(el) ? inView : below).push(el);
            inView.forEach(el => el.classList.add('reveal-instant', 'visible'));
            below.forEach(observe);
        };

        process(Array.from(root.querySelectorAll(PENDING)));

        // Safety net: whatever the observer missed and is on screen (or
        // already scrolled past) becomes visible.
        const sweep = () => {
            for (const el of root.querySelectorAll(PENDING)) {
                if (inOrAboveViewport(el)) {
                    el.classList.add('visible');
                    observer?.unobserve(el);
                }
            }
        };
        const failsafe = window.setTimeout(sweep, REVEAL_FAILSAFE_MS);
        let settle: number | undefined;
        const onScroll = () => {
            window.clearTimeout(settle);
            settle = window.setTimeout(sweep, SCROLL_SETTLE_MS);
        };
        const onPageShow = () => sweep();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('pageshow', onPageShow);

        // Re-observe `.reveal` elements created or re-mounted after this pass.
        const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
            const added = new Set<Element>();
            for (const record of records) {
                record.addedNodes.forEach((node) => {
                    if (!(node instanceof Element)) return;
                    if (node.matches(PENDING)) added.add(node);
                    node.querySelectorAll(PENDING).forEach(el => added.add(el));
                });
            }
            process(Array.from(added));
        });
        mutations?.observe(root instanceof Document ? root.body : root, { childList: true, subtree: true });

        return () => {
            window.clearTimeout(failsafe);
            window.clearTimeout(settle);
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('pageshow', onPageShow);
            mutations?.disconnect();
            observer?.disconnect();
        };
    }, [rootRef, contentKey]);
}

interface ScrollRevealProps {
    delay?: number;
    children?: React.ReactNode;
    className?: string;
}

function ScrollReveal({ delay = 0, children, className = '' }: ScrollRevealProps) {
    const delayClass = delay > 0 ? `reveal-delay-${Math.min(delay, 6)}` : '';
    return <div className={`reveal ${delayClass} ${className}`.trim()}>{children}</div>;
}
