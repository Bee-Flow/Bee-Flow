export const CARD_WIDTH = 340;
export const SPOTLIGHT_PAD = 8;
export const EDGE = 16;
export const DEFAULT_TIMEOUT = 3000;   // resolve timeout for static targets
export const NAV_TIMEOUT = 6000;       // resolve timeout when the step navigates (lazy)

export function isShowable(el: Element | null) {
    if (!el || !document.body.contains(el)) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return false;
    return true;
}

// First node matching the selector that is actually showable — guards against
// the sidebar's off-screen duplicate icons (the visible one wins).
export function pickShowable(selector: string | undefined) {
    if (!selector) return null;
    let nodes: NodeListOf<Element>;
    try { nodes = document.querySelectorAll(selector); } catch (e) { return null; }
    for (const n of nodes) if (isShowable(n)) return n;
    return null;
}
