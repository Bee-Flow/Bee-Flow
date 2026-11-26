import { flushSync } from 'react-dom';

/** Share Bee's position between the outgoing and incoming Cowork screens. */
export function beeTransition(update: () => void) {
    if (!document.startViewTransition || !globalThis.CSS?.supports('selector(:active-view-transition-type(cowork))')
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        update();
        return;
    }
    document.startViewTransition({types: ['cowork'], update: () => flushSync(update)});
}
