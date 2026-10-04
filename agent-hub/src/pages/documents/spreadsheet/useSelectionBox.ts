// Where the selection is on screen, for the overlays that float over it (the
// Ask AI button, the prompt, the shimmer). The corner cells are measured and
// the result is written as CSS variables (--sel-left, --sel-top, --sel-right,
// --sel-bottom, in px, relative to the grid content) on the layer element, so
// moving the selection re-renders nothing, and scrolling needs no code at all:
// the layer scrolls with the cells.

import { useLayoutEffect, type RefObject } from 'react';
import { cellName } from './sheetEngine';
import type { Range } from './sheetModel';

/** Measure `range` inside `content` and publish it on `layer`. Re-measures on resize. */
export default function useSelectionBox(content: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, range: Range, active: boolean): void {
    const { c1, r1, c2, r2 } = range;
    useLayoutEffect(() => {
        const root = content.current;
        const out = layer.current;
        if (!active || !root || !out) return undefined;
        const measure = () => {
            const first = root.querySelector(`[data-cell="${cellName(c1, r1)}"]`);
            const last = root.querySelector(`[data-cell="${cellName(c2, r2)}"]`);
            if (!first || !last) return;
            const o = root.getBoundingClientRect();
            const a = first.getBoundingClientRect();
            const b = last.getBoundingClientRect();
            const px = (n: number) => `${Math.round(n)}px`;
            out.style.setProperty('--sel-left', px(a.left - o.left));
            out.style.setProperty('--sel-top', px(a.top - o.top));
            out.style.setProperty('--sel-right', px(b.right - o.left));
            out.style.setProperty('--sel-bottom', px(b.bottom - o.top));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
    }, [content, layer, active, c1, r1, c2, r2]);
}
