/**
 * A flowchart link's line and its ends. The line through dagre's points is
 * d3's `curveBasis`, the curve the web's Mermaid config asks for
 * (`flowchart.curve: 'basis'`), ported step for step; the ends are Mermaid's
 * arrowhead, circle and cross, pointing along the line's last segment.
 */

import type { Point } from './flowchartLayout';
import type { EdgeEnd } from './flowchartParser';

const f = (n: number) => n.toFixed(1);

/** d3-shape's curveBasis over the points, as an SVG path. */
export function basisPath(points: readonly Point[]): string {
    if (points.length === 0) return '';
    const out: string[] = [];
    let x0 = NaN;
    let y0 = NaN;
    let x1 = NaN;
    let y1 = NaN;
    const bezier = (x: number, y: number) =>
        out.push(`C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 4 * x1 + x) / 6)},${f((y0 + 4 * y1 + y) / 6)}`);
    points.forEach(({ x, y }, i) => {
        if (i === 0) out.push(`M${f(x)},${f(y)}`);
        else if (i >= 2) {
            if (i === 2) out.push(`L${f((5 * x0 + x1) / 6)},${f((5 * y0 + y1) / 6)}`);
            bezier(x, y);
        }
        x0 = x1;
        y0 = y1;
        x1 = x;
        y1 = y;
    });
    if (points.length >= 3) bezier(x1, y1);
    if (points.length >= 2) out.push(`L${f(x1)},${f(y1)}`);
    return out.join(' ');
}

/** The unit direction of travel into `to` from `from`. */
function direction(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

export type EndMark =
    | { kind: 'arrow'; points: string }
    | { kind: 'circle'; cx: number; cy: number; r: number }
    | { kind: 'cross'; lines: [Point, Point][] };

const ARROW_LENGTH = 9;
const ARROW_HALF = 4.5;

/**
 * The mark at one end of a link: `tip` is the end point, `from` the point
 * before it along the line. Null for a plain end.
 */
export function endMark(end: EdgeEnd, from: Point, tip: Point): EndMark | null {
    const d = direction(from, tip);
    const perp = { x: -d.y, y: d.x };
    if (end === 'arrow') {
        const base = { x: tip.x - d.x * ARROW_LENGTH, y: tip.y - d.y * ARROW_LENGTH };
        const a = `${f(base.x + perp.x * ARROW_HALF)},${f(base.y + perp.y * ARROW_HALF)}`;
        const b = `${f(base.x - perp.x * ARROW_HALF)},${f(base.y - perp.y * ARROW_HALF)}`;
        return { kind: 'arrow', points: `${f(tip.x)},${f(tip.y)} ${a} ${b}` };
    }
    if (end === 'circle') return { kind: 'circle', cx: tip.x - d.x * 4, cy: tip.y - d.y * 4, r: 4 };
    if (end === 'cross') {
        const c = { x: tip.x - d.x * 5, y: tip.y - d.y * 5 };
        const s = 4;
        return {
            kind: 'cross',
            lines: [
                [{ x: c.x - s, y: c.y - s }, { x: c.x + s, y: c.y + s }],
                [{ x: c.x - s, y: c.y + s }, { x: c.x + s, y: c.y - s }],
            ],
        };
    }
    return null;
}

/** Stop the line short of an arrowhead, so its stroke does not poke through the tip. */
export function trimForEnd(points: readonly Point[], end: EdgeEnd): Point[] {
    const n = points.length;
    if (end !== 'arrow' || n < 2) return [...points];
    const tip = points[n - 1] as Point;
    const d = direction(points[n - 2] as Point, tip);
    return [...points.slice(0, -1), { x: tip.x - d.x * (ARROW_LENGTH - 2), y: tip.y - d.y * (ARROW_LENGTH - 2) }];
}
