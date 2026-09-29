import { useSyncExternalStore } from 'react';

/**
 * Does the OS ask for less motion? The one switch the builder's canvas
 * choreography (useBuildChoreography.js, the bf-* rules in index.css) obeys.
 *
 * Why only this signal: the stylesheet once gated the step-arrival animation
 * on `[data-anim="off"]` as well, but that attribute is the glass theme's
 * sheen level (Off / Subtle / Lively), default 'off' — so the guard switched
 * the animation off for nearly every user. prefers-reduced-motion is what a
 * person actually set when they meant "less motion"; nothing else counts.
 *
 * Read through useSyncExternalStore rather than state + effect so the first
 * render already has the right answer — a card that fades in on frame one
 * and is then told "no motion" on frame two is the flash the setting exists
 * to prevent. Environments without matchMedia (jsdom before the test setup's
 * polyfill, a server render) report false: no signal, no restriction.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
        return window.matchMedia(QUERY) || null;
    } catch {
        return null;
    }
}

function subscribe(onChange: () => void): () => void {
    const mq = mediaQuery();
    if (!mq) return () => {};
    if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }
    // Safari before 14 has only the deprecated pair.
    if (typeof mq.addListener === 'function') {
        mq.addListener(onChange);
        return () => mq.removeListener(onChange);
    }
    return () => {};
}

function getSnapshot(): boolean {
    return !!mediaQuery()?.matches;
}

function getServerSnapshot(): boolean {
    return false;
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
