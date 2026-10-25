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

export function useScrollReveal(rootRef: RefObject<HTMLElement | null> | null | undefined, contentKey?: unknown) {
    useLayoutEffect(() => {
        const root = rootRef?.current || document;
        const elements = root.querySelectorAll('.reveal:not(.visible)');
        if (!elements.length) return;

        // Reduced motion: no entrance animation — render everything
        // visible immediately (the CSS guard also zeroes the transition).
        if (typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            elements.forEach(el => el.classList.add('visible'));
            return;
        }

        // All reads, then all writes — one layout pass, no thrash.
        const viewportH = window.innerHeight || document.documentElement.clientHeight;
        const inView: Element[] = [];
        const below: Element[] = [];
        for (const el of elements) {
            const r = el.getBoundingClientRect();
            (r.top < viewportH && r.bottom > 0 ? inView : below).push(el);
        }
        // `reveal-instant` zeroes the transition for this batch: the rect
        // reads above flushed style with the element at opacity 0, so adding
        // `.visible` alone would still FADE everything above the fold in
        // over ~0.5–0.9s after first paint (stagger delays included). The
        // first viewport must render visible immediately; the entrance
        // animation remains for everything below the fold.
        inView.forEach(el => el.classList.add('reveal-instant', 'visible'));
        if (!below.length) return;

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            }
        }, REVEAL_OBSERVER_OPTIONS);

        below.forEach(el => observer.observe(el));
        return () => observer.disconnect();
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
