/**
 * Finding a component on the page for the browser steps that name one (focus,
 * scroll_to). Every rendered node sits in a wrapper carrying `data-node-id`
 * (AppRenderer's NodeWrapper); the attribute is compared as a string, never
 * built into a selector, so an id can hold any character.
 *
 * Beside browserSteps/, not in it: that folder holds only files named after a step kind,
 * and the steps there import this one.
 */

/** The first rendered element of the node with this id, or null when it is not on the page. */
export function findNodeElement(nodeId: string, root: ParentNode = document): HTMLElement | null {
    for (const el of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
        if (el.getAttribute('data-node-id') === nodeId) return el;
    }
    return null;
}

const FOCUSABLE = [
    'input:not([type="hidden"]):not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])',
    'button:not([disabled])', 'a[href]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The element itself when it takes the focus, else the first one inside it that does. */
export function focusableIn(el: HTMLElement): HTMLElement | null {
    if (el.matches(FOCUSABLE)) return el;
    return el.querySelector<HTMLElement>(FOCUSABLE);
}

/** 'smooth', unless the person asked their system for reduced motion. */
function scrollBehavior(): ScrollBehavior {
    try {
        return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    } catch {
        return 'smooth';
    }
}

/** Scroll an element into view at the top of its scroll area (jsdom has no scrollIntoView: then nothing). */
export function scrollToElement(el: Element): void {
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
}
