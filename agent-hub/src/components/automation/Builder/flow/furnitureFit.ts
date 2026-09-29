import type { FitViewOptions, InternalNode } from '@xyflow/react';

type Padding = NonNullable<FitViewOptions['padding']>;

/**
 * Fitting the graph around the canvas furniture.
 *
 * React Flow's fitView pads the graph by one fraction on every side and knows
 * nothing about what floats over the pane: the zoom stack (south-west), the
 * minimap (south-east), the lines lens and the legend (north-east), the
 * summary chips (north-west) and the south bar. At 1280 a plain fit put the
 * first card of the second row against the zoom stack.
 *
 * Every piece of furniture sits in a corner or on an edge, so the graph can
 * get clear of it in one of two ways: stay out of its columns (inset the near
 * side by its width) or out of its rows (inset the near top or bottom by its
 * height). One of the two is usually free, because a long left-to-right flow
 * has height to spare and a wrapped one has width. So every combination is
 * tried and the one that keeps the zoom highest wins; on a tie (the zoom at
 * its cap) the one that moves the graph least.
 *
 * Only the fits the canvas does on its own use this: on mount, the zoom
 * stack's Fit and Arrange. The build film frames its own shots
 * (flow/buildChoreography.js) and keeps its recipes.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Bounds { x: number; y: number; width: number; height: number }

/** The fraction every fit used before the furniture counted, still the floor on each side. */
export const FIT_PADDING = 0.08;
/** Air between a piece of furniture and the nearest card. */
export const FURNITURE_GAP_PX = 12;
/**
 * How far outside the cards the dashed line back to the next row runs, in
 * flow units (layout.js wraps; measured 31 at 78% and at 117%). It is not a
 * node, so it is not in the bounds; a piece passed on the side must clear
 * it as well, or the line and its arrow run behind the zoom stack.
 */
export const LINE_GUTTER_FLOW = 32;
// Two options per piece means 2^n combinations; the canvas has six or seven.
const MAX_OBSTACLES = 10;
const EPSILON = 1e-6;

/** React Flow's own reading of a fractional padding (parsePadding in @xyflow/system), per side in px. */
export function fractionInsets(width: number, height: number, fraction: number = FIT_PADDING): Insets {
    const x = Math.floor((width - width / (1 + fraction)) * 0.5);
    const y = Math.floor((height - height / (1 + fraction)) * 0.5);
    return { top: y, right: x, bottom: y, left: x };
}

interface Option { side: keyof Insets; inset: number; across: boolean }

/** The two ways past one piece: out of its columns, or out of its rows. */
function optionsFor(box: Box, width: number, height: number, gap: number): [Option, Option] {
    const across: Option = (box.left + box.right) / 2 < width / 2
        ? { side: 'left', inset: box.right + gap, across: true }
        : { side: 'right', inset: width - box.left + gap, across: true };
    const along: Option = (box.top + box.bottom) / 2 < height / 2
        ? { side: 'top', inset: box.bottom + gap, across: false }
        : { side: 'bottom', inset: height - box.top + gap, across: false };
    return [across, along];
}

const isOnPane = (b: Box, width: number, height: number): boolean => (
    b.right > b.left && b.bottom > b.top && b.right > 0 && b.left < width && b.bottom > 0 && b.top < height
);

export interface InsetsInput {
    width: number;
    height: number;
    bounds: Bounds | null;
    obstacles: Box[];
    base: Insets;
    gap?: number;
    gutter?: number;
    minZoom: number;
    maxZoom: number;
}

/**
 * The insets (px per side) that keep a fitted graph clear of every obstacle,
 * with the highest zoom that allows. `base` is the floor on each side; with
 * nothing in the way it comes back unchanged.
 */
export function furnitureInsets({
    width, height, bounds, obstacles, base, gap = FURNITURE_GAP_PX, gutter = LINE_GUTTER_FLOW, minZoom, maxZoom,
}: InsetsInput): Insets {
    if (!(width > 0 && height > 0) || !bounds || !(bounds.width > 0) || !(bounds.height > 0)) return base;
    const choices = obstacles
        .filter(b => isOnPane(b, width, height))
        .slice(0, MAX_OBSTACLES)
        .map(b => optionsFor(b, width, height, gap));
    const zoomFor = (insets: Insets): number | null => {
        const w = width - insets.left - insets.right;
        const h = height - insets.top - insets.bottom;
        if (w <= 0 || h <= 0) return null;
        return Math.min(maxZoom, Math.max(minZoom, Math.min(w / bounds.width, h / bounds.height)));
    };
    let best: Insets | null = null;
    let bestZoom = -Infinity;
    let bestSum = Infinity;
    for (let mask = 0; mask < (1 << choices.length); mask += 1) {
        // The line gutter is in flow units, so its width on screen depends on
        // the zoom it is meant to set: place without it, then again with it
        // at that (higher) zoom — a little more room than needed, never less.
        const place = (gutterPx: number): Insets => {
            const insets = { ...base };
            choices.forEach((pair, i) => {
                const pick = pair[(mask >> i) & 1];
                insets[pick.side] = Math.max(insets[pick.side], pick.inset + (pick.across ? gutterPx : 0));
            });
            return insets;
        };
        const rough = zoomFor(place(0));
        if (rough == null) continue;
        const insets = place(gutter * rough);
        const zoom = zoomFor(insets);
        if (zoom == null) continue;
        const sum = insets.top + insets.right + insets.bottom + insets.left;
        if (zoom > bestZoom + EPSILON || (Math.abs(zoom - bestZoom) <= EPSILON && sum < bestSum)) {
            best = insets;
            bestZoom = zoom;
            bestSum = sum;
        }
    }
    return best ?? base;
}

/**
 * The furniture on the pane, in px from its top-left corner: one box per
 * React Flow <Panel> (the minimap is one too). A panel that holds loose
 * pieces side by side (the zoom stack with Flowlets and Arrange beside it)
 * marks its row `data-furniture-parts`, and each piece counts on its own:
 * the tall stack and the short buttons are not one tall block.
 */
export function measureFurniture(pane: Element | null | undefined): Box[] {
    if (!pane) return [];
    const origin = pane.getBoundingClientRect();
    const boxes: Box[] = [];
    for (const panel of Array.from(pane.querySelectorAll('.react-flow__panel'))) {
        const row = panel.querySelector('[data-furniture-parts]');
        for (const el of row ? Array.from(row.children) : [panel]) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            boxes.push({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top });
        }
    }
    return boxes;
}

type FitNode = Pick<InternalNode, 'hidden' | 'measured' | 'internals'>;

/** The bounds React Flow's own fitView frames: every measured, visible node. */
export function graphBounds(nodes: Iterable<FitNode>): Bounds | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
        const w = n.measured?.width;
        const h = n.measured?.height;
        const p = n.internals?.positionAbsolute;
        if (!w || !h || !p || n.hidden) continue;
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + w);
        y1 = Math.max(y1, p.y + h);
    }
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export interface PaddingInput {
    pane: Element | null | undefined;
    width: number;
    height: number;
    nodes: Iterable<FitNode>;
    minZoom: number;
    maxZoom: number;
}

/** A fitView `padding` that clears the furniture — or the plain fraction when there is nothing to measure. */
export function furniturePadding({ pane, width, height, nodes, minZoom, maxZoom }: PaddingInput): Padding {
    const bounds = graphBounds(nodes);
    if (!pane || !bounds || !(width > 0 && height > 0)) return FIT_PADDING;
    const insets = furnitureInsets({
        width, height, bounds, obstacles: measureFurniture(pane),
        base: fractionInsets(width, height), minZoom, maxZoom,
    });
    return { top: `${insets.top}px`, right: `${insets.right}px`, bottom: `${insets.bottom}px`, left: `${insets.left}px` };
}
