import type { CurveRoute, EdgeGeometry, MapEdge, Point } from './studioMap.types';
import { TILE_W, SIDE_NORMAL } from './studioMap.constants';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** De richting waarin de pijlpunt wijst, uit de laatste twee punten. */
export function direction(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

/**
 * The arrowhead: a triangle with its point ON the end point. Deliberately not an SVG
 * marker — a marker does not inherit the stroke colour everywhere, and on this map that
 * colour changes at every selection.
 */
export function arrowPath(point: Point, dir: Point, size = 6): string {
    const bx = point.x - dir.x * size;
    const by = point.y - dir.y * size;
    const px = -dir.y * size * 0.55;
    const py = dir.x * size * 0.55;
    return `M ${round1(point.x)} ${round1(point.y)} L ${round1(bx + px)} ${round1(by + py)} L ${round1(bx - px)} ${round1(by - py)} Z`;
}

/** Een orthogonale polylijn met afgeronde hoeken. */
export function roundedPolyline(points: Point[], r = 8): string {
    if (points.length < 2) return '';
    let d = `M ${round1(points[0].x)} ${round1(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const cur = points[i];
        const next = points[i + 1];
        const inDir = direction(prev, cur);
        const outDir = direction(cur, next);
        const rIn = Math.min(r, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2);
        const rOut = Math.min(r, Math.hypot(next.x - cur.x, next.y - cur.y) / 2);
        const a = { x: cur.x - inDir.x * rIn, y: cur.y - inDir.y * rIn };
        const b = { x: cur.x + outDir.x * rOut, y: cur.y + outDir.y * rOut };
        d += ` L ${round1(a.x)} ${round1(a.y)} Q ${round1(cur.x)} ${round1(cur.y)} ${round1(b.x)} ${round1(b.y)}`;
    }
    const end = points[points.length - 1];
    d += ` L ${round1(end.x)} ${round1(end.y)}`;
    return d;
}

/** De zelflus: een boog over de eigen tegel heen. */
export function selfGeometry(node: Point) {
    const left = { x: node.x + 40, y: node.y };
    const right = { x: node.x + TILE_W - 40, y: node.y };
    const top = node.y - 42;
    const d = `M ${left.x} ${left.y} C ${left.x} ${top}, ${right.x} ${top}, ${right.x} ${right.y}`;
    return {
        d,
        mid: { x: (left.x + 3 * left.x + 3 * right.x + right.x) / 8, y: (left.y + 3 * top + 3 * top + right.y) / 8 },
        tip: right,
        dir: { x: 0, y: 1 },
    };
}

/**
 * De bocht: een cubic bezier met raaklijnen loodrecht op de twee randen. De
 * lengte van die raaklijn schaalt mee met de afstand, en is begrensd: op een
 * korte rand duwt een lange raaklijn de bocht terug door zichzelf heen.
 */
export function curveGeometry(a: Point, b: Point, route: CurveRoute, edge: MapEdge): EdgeGeometry {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const bow = route.bow ?? Math.max(20, Math.min(80, span * 0.4));
    const n1 = SIDE_NORMAL[route.fromSide] || SIDE_NORMAL.right;
    const n2 = SIDE_NORMAL[route.toSide] || SIDE_NORMAL.left;
    const c1 = { x: a.x + n1.x * bow, y: a.y + n1.y * bow };
    const c2 = { x: b.x + n2.x * bow, y: b.y + n2.y * bow };
    const mid = {
        x: round1((a.x + 3 * c1.x + 3 * c2.x + b.x) / 8),
        y: round1((a.y + 3 * c1.y + 3 * c2.y + b.y) / 8),
    };
    return {
        d: `M ${round1(a.x)} ${round1(a.y)} C ${round1(c1.x)} ${round1(c1.y)}, ${round1(c2.x)} ${round1(c2.y)}, ${round1(b.x)} ${round1(b.y)}`,
        arrow: arrowPath(b, direction(c2, b)),
        mid: edge.labelAt || mid,
    };
}
