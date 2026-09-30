/**
 * highlights.ts — paint ranges of the document without touching its DOM.
 *
 * The editor owns every node inside its host and re-renders the whole
 * document when anything else writes there, so find results, comment
 * anchors and co-editors' selections cannot be wrapped in <mark>s. The CSS
 * Custom Highlight API paints ranges with zero DOM mutation; where it is
 * missing, callers fall back to measured overlay rectangles outside the host
 * (rectsFor).
 *
 * The highlight registry is global per page, and two editors can be on one
 * page, so every name is shared through this module: each caller ("owner")
 * contributes its own ranges and the registered Highlight is the union.
 */

type RangeList = Range[];

const registry = new Map<string, Map<string, RangeList>>();

interface HighlightCtor { new (...ranges: Range[]): unknown }

function api(): { highlights: Map<string, unknown>; Highlight: HighlightCtor } | null {
    const g = globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: HighlightCtor };
    if (!g.CSS || !g.CSS.highlights || typeof g.Highlight !== 'function') return null;
    return { highlights: g.CSS.highlights, Highlight: g.Highlight };
}

/** Whether ranges can be painted natively (else use overlay rectangles). */
export function supportsHighlights(): boolean {
    return api() !== null;
}

function repaint(name: string) {
    const a = api();
    if (!a) return;
    const owners = registry.get(name);
    const all: Range[] = [];
    owners?.forEach((ranges) => { all.push(...ranges); });
    if (!all.length) { a.highlights.delete(name); return; }
    try { a.highlights.set(name, new a.Highlight(...all)); } catch { a.highlights.delete(name); }
}

/** Set `owner`'s ranges for highlight `name` (an empty list removes them). */
export function paintHighlight(name: string, owner: string, ranges: RangeList): void {
    let owners = registry.get(name);
    if (!owners) { owners = new Map(); registry.set(name, owners); }
    if (ranges.length) owners.set(owner, ranges.slice());
    else owners.delete(owner);
    if (!owners.size) registry.delete(name);
    repaint(name);
}

/** Remove everything `owner` painted, under every name. */
export function clearOwner(owner: string): void {
    for (const name of [...registry.keys()]) {
        const owners = registry.get(name);
        if (owners?.delete(owner)) {
            if (!owners.size) registry.delete(name);
            repaint(name);
        }
    }
}

export interface OverlayRect { top: number; left: number; width: number; height: number }

/**
 * Client rectangles of `ranges`, relative to `container` (which must be the
 * positioned ancestor the overlay is drawn in). Zero-size rectangles (the
 * line-box stubs browsers report around line wraps) are dropped.
 */
export function rectsFor(ranges: RangeList, container: Element | null): OverlayRect[] {
    if (!container) return [];
    const base = container.getBoundingClientRect();
    const out: OverlayRect[] = [];
    for (const r of ranges) {
        let list: DOMRect[] = [];
        try { list = Array.from(r.getClientRects ? r.getClientRects() : []); } catch { list = []; }
        for (const rect of list) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            out.push({ top: rect.top - base.top, left: rect.left - base.left, width: rect.width, height: rect.height });
        }
    }
    return out;
}

let ownerSeq = 0;
/** A unique owner id for one editor instance. */
export function newHighlightOwner(prefix = 'bf'): string {
    ownerSeq += 1;
    return `${prefix}-${ownerSeq}`;
}
