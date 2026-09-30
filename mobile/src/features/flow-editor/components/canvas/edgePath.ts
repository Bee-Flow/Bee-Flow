/**
 * A connection's drawing: its SVG path, its arrowhead, where its chip and
 * "+" sit, and the box it occupies.
 *
 *   forward   a cubic bezier from the source port to the target port, the
 *             control points pulled out horizontally by half the distance
 *             (React Flow's bezier edge, which the web's lines are measured
 *             against);
 *   backward  a line that runs BACK to a node on its left — the return edge
 *             between two wrapped rows, or a loop drawn by hand — routed
 *             through the gap instead of across the cards: out to the right,
 *             along a midline, and into the target from the left, corners
 *             rounded like the web's smooth-step lines (radius 12).
 *
 * The chip sits at the line's middle (the web's rule, edges.jsx: on the line,
 * over an opaque ground). Several lines between the same two nodes fan out,
 * the target end shifted LANE_PITCH per lane and the chips staggered.
 *
 * Android draws an <Svg> into a bitmap the size of its box, so every line is
 * its own small Svg (a whole-canvas one would be hundreds of megabytes), and
 * `edgeResolution` keeps each one inside a pixel budget.
 */

import { COMPACT_BELOW, type Point, type Rect, type Size } from './viewport';

/** Vertical distance between parallel lanes (edges.jsx LANE_PITCH). */
export const LANE_PITCH = 26;
/** Horizontal chip stagger for parallel lanes (edges.jsx CHIP_PITCH). */
export const CHIP_PITCH = 28;
/** The smooth-step corner radius (edges.jsx `borderRadius: 12`). */
export const CORNER = 12;
/** How far a returning line runs out of its port before it turns. */
const STUB = 24;
/** Below this much room to the right, a line counts as running back. */
const MIN_FORWARD = 20;
/** How far along a line back its controls sit from where it turns down. */
const LABEL_REACH = 72;
/** Room around the path for the stroke and the arrowhead. */
const MARGIN = 10;
/** Most pixels one line's bitmap may hold (about 6 MB). */
export const EDGE_PIXEL_BUDGET = 1_500_000;

export interface EdgeGeometry {
    d: string;
    arrow: string;
    label: Point;
    bbox: Rect;
    backward: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The lane's vertical offset at the target end. */
export function laneOffset(index: number, count: number): number {
    return count > 1 ? (index - (count - 1) / 2) * LANE_PITCH : 0;
}

/** The chip's horizontal stagger. */
export function chipOffset(index: number, count: number): number {
    return count > 1 ? (index - (count - 1) / 2) * CHIP_PITCH : 0;
}

function box(xs: number[], ys: number[]): Rect {
    const x0 = Math.min(...xs) - MARGIN;
    const y0 = Math.min(...ys) - MARGIN;
    return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(Math.max(...xs) + MARGIN - x0), height: Math.ceil(Math.max(...ys) + MARGIN - y0) };
}

function forward(sx: number, sy: number, tx: number, ty: number): Omit<EdgeGeometry, 'arrow'> {
    const c = (tx - sx) / 2;
    const d = `M${r1(sx)} ${r1(sy)} C${r1(sx + c)} ${r1(sy)} ${r1(tx - c)} ${r1(ty)} ${r1(tx)} ${r1(ty)}`;
    return { d, label: { x: (sx + tx) / 2, y: (sy + ty) / 2 }, bbox: box([sx, tx], [sy, ty]), backward: false };
}

/** The midline a returning line runs along: halfway between the ends, or under both when they are level. */
function midlineY(sy: number, ty: number): number {
    return Math.abs(ty - sy) >= 4 * CORNER ? (sy + ty) / 2 : Math.max(sy, ty) + 80;
}

function backward(sx: number, sy: number, tx: number, ty: number): Omit<EdgeGeometry, 'arrow'> {
    const x1 = sx + STUB;
    const x2 = tx - STUB;
    const my = midlineY(sy, ty);
    const s1 = my >= sy ? 1 : -1;
    const s2 = ty >= my ? 1 : -1;
    const r = Math.max(0, Math.min(CORNER, Math.abs(my - sy) / 2, Math.abs(ty - my) / 2, (x1 - x2) / 2));
    const d = [
        `M${r1(sx)} ${r1(sy)}`,
        `L${r1(x1 - r)} ${r1(sy)} Q${r1(x1)} ${r1(sy)} ${r1(x1)} ${r1(sy + r * s1)}`,
        `L${r1(x1)} ${r1(my - r * s1)} Q${r1(x1)} ${r1(my)} ${r1(x1 - r)} ${r1(my)}`,
        `L${r1(x2 + r)} ${r1(my)} Q${r1(x2)} ${r1(my)} ${r1(x2)} ${r1(my + r * s2)}`,
        `L${r1(x2)} ${r1(ty - r * s2)} Q${r1(x2)} ${r1(ty)} ${r1(x2 + r)} ${r1(ty)}`,
        `L${r1(tx)} ${r1(ty)}`,
    ].join(' ');
    // The chip and "+" sit on the midline just past the step the line leaves,
    // not halfway along it: a line back to the next row is as wide as the
    // flow, and its middle is empty space nobody connects with this step.
    const labelX = Math.max((x1 + x2) / 2, x1 - LABEL_REACH);
    return { d, label: { x: labelX, y: my }, bbox: box([sx, x1, x2, tx], [sy, my, ty]), backward: true };
}

/** The arrowhead at the target port, pointing into it. */
export function arrowPath(tx: number, ty: number): string {
    return `M${r1(tx)} ${r1(ty)} L${r1(tx - 8)} ${r1(ty - 4.5)} L${r1(tx - 8)} ${r1(ty + 4.5)} Z`;
}

/** Everything about one line, from its source port to its target port. */
export function edgeGeometry(sx: number, sy: number, tx: number, ty: number): EdgeGeometry {
    const shape = tx - sx >= MIN_FORWARD ? forward(sx, sy, tx, ty) : backward(sx, sy, tx, ty);
    return { ...shape, arrow: arrowPath(tx, ty) };
}

/** Line resolution by zoom: half at the tile level, double when zoomed in close. */
export function resolutionFor(scale: number): number {
    'worklet';
    if (scale < COMPACT_BELOW) return 0.5;
    return scale < 1.2 ? 1 : 2;
}

/**
 * The resolution one line's Svg is drawn at: the zoom's, lowered for a long
 * line until its bitmap fits the budget. Rounded, so a line re-renders only
 * when the answer really changes.
 */
export function edgeResolution(size: Size, res: number, pixelRatio: number): number {
    const px = size.width * size.height * res * res * pixelRatio * pixelRatio;
    const fitted = px <= EDGE_PIXEL_BUDGET ? res : res * Math.sqrt(EDGE_PIXEL_BUDGET / px);
    return Math.max(0.05, Math.floor(fitted * 100) / 100);
}

/**
 * A straight line from one point to another as a thin view's frame: where it
 * starts, how long it is, and its angle — the rubber band a line becomes
 * while one of its nodes is being dragged (an Svg redrawn every frame would
 * allocate a new bitmap every frame).
 */
export function segmentFrame(x1: number, y1: number, x2: number, y2: number): { left: number; top: number; width: number; angle: number } {
    'worklet';
    const dx = x2 - x1;
    const dy = y2 - y1;
    return { left: x1, top: y1, width: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) };
}
