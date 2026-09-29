/**
 * The geometry of the egress map, in pixels: the curve of each line, the
 * box the opening view has to show, the zoom transform that shows it, and
 * which pins merge into one bubble. Pure and tested (mapGeometry.test.ts);
 * what the points MEAN is mapModel.ts.
 *
 * ── Three coordinate spaces ───────────────────────────────────────────────
 *   lon/lat   what the server sends (the city, the edge, or a country pin)
 *   base      the projected world at zoom 1, in CSS pixels of the card
 *   screen    base after the d3-zoom transform: k·base + (x, y)
 * Countries are drawn in base space under a <g transform>, with
 * non-scaling strokes. Lines and pins are drawn in SCREEN space, so a pin
 * keeps its size and a dashed line keeps its dash length at any zoom.
 */

export type Pt = [number, number];
export type Box = [Pt, Pt];
export interface ZoomState { k: number; x: number; y: number }
export interface Size { w: number; h: number }

export const K_MIN = 1;
export const K_MAX = 8;
export const FIT_PADDING = 32;
export const CLUSTER_RADIUS = 14;
/** How far a line bows away from the straight chord, as a share of its length. */
export const BOW = 0.18;

/** Anything with a place on the map: a destination, once placed. */
export interface PlacedPoint { host: string; xy: Pt; total: number; piiEvents: number }

/* ── Lines ───────────────────────────────────────────────────────────── */

export interface Arc { host: string; from: Pt; ctrl: Pt; to: Pt }

/**
 * The control point of a quadratic Bezier from a to b: the chord's midpoint,
 * pushed sideways by `bow` of the chord's length, on the side that points up
 * the screen (north). Two lines to neighbouring cities then fan out instead
 * of lying on top of each other, and a line never dips toward the equator.
 */
export function arcControl(a: Pt, b: Pt, bow = BOW): Pt {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (len < 1e-6) return mid;
    // The two perpendiculars are (dy, -dx) and (-dy, dx); take the one whose
    // y is negative (up the screen). A vertical chord has no "up" side, so it
    // bends east.
    let nx = dy / len;
    let ny = -dx / len;
    if (ny > 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
    return [mid[0] + nx * bow * len, mid[1] + ny * bow * len];
}

/** One line per placed destination, from the origin. None without an origin. */
export function buildArcs(origin: Pt | null, placed: PlacedPoint[], bow = BOW): Arc[] {
    if (!origin) return [];
    const arcs: Arc[] = [];
    for (const d of placed) {
        // A destination that sits on the origin (an edge in your own city)
        // has no line to draw; its pin says enough.
        if (Math.hypot(d.xy[0] - origin[0], d.xy[1] - origin[1]) < 1) continue;
        arcs.push({ host: d.host, from: origin, ctrl: arcControl(origin, d.xy, bow), to: d.xy });
    }
    return arcs;
}

export function applyZoom(p: Pt, t: ZoomState): Pt {
    return [p[0] * t.k + t.x, p[1] * t.k + t.y];
}

/** An arc in screen space. A uniform scale plus a translation keeps a Bezier a Bezier. */
export function arcPath(arc: Arc, t: ZoomState): string {
    const [a, c, b] = [applyZoom(arc.from, t), applyZoom(arc.ctrl, t), applyZoom(arc.to, t)];
    const f = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    return `M${f(a)} Q${f(c)} ${f(b)}`;
}

/** Top-left of a tooltip next to `anchor`: right of it when it fits, else left, always inside the card. */
export function tooltipPosition(anchor: Pt, tip: Size, box: Size, gap = 14, margin = 6): Pt {
    let x = anchor[0] + gap;
    if (x + tip.w > box.w - margin) x = anchor[0] - gap - tip.w;
    x = Math.max(margin, Math.min(x, box.w - tip.w - margin));
    const y = Math.max(margin, Math.min(anchor[1] - tip.h / 2, box.h - tip.h - margin));
    return [Math.round(x), Math.round(y)];
}

/* ── Framing ─────────────────────────────────────────────────────────── */

export function boxOf(points: Pt[]): Box | null {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x0 === Infinity ? null : [[x0, y0], [x1, y1]];
}

/**
 * Everything the opening view has to show: the origin, every pin, and every
 * line INCLUDING its control point. A curve always lies inside the triangle
 * of its three points, so a box around all three can never cut a line off,
 * which is the bug the old Mercator frame had with Canada.
 */
export function trafficBounds(origin: Pt | null, placed: PlacedPoint[], arcs: Arc[]): Box | null {
    const pts: Pt[] = [];
    if (origin) pts.push(origin);
    for (const d of placed) pts.push(d.xy);
    for (const a of arcs) pts.push(a.ctrl);
    return boxOf(pts);
}

export function unionBox(a: Box, b: Box | null): Box {
    if (!b) return a;
    return [[Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])], [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])]];
}

/** d3-zoom's own constrain, so a fit computed here is the view d3 will keep. */
export function constrainTransform(t: ZoomState, size: Size, extent: Box): ZoomState {
    const inv = (v: number, o: number) => (v - o) / t.k;
    const dx0 = inv(0, t.x) - extent[0][0];
    const dx1 = inv(size.w, t.x) - extent[1][0];
    const dy0 = inv(0, t.y) - extent[0][1];
    const dy1 = inv(size.h, t.y) - extent[1][1];
    const sx = dx1 > dx0 ? (dx0 + dx1) / 2 : Math.min(0, dx0) || Math.max(0, dx1);
    const sy = dy1 > dy0 ? (dy0 + dy1) / 2 : Math.min(0, dy0) || Math.max(0, dy1);
    return { k: t.k, x: t.x + t.k * sx, y: t.y + t.k * sy };
}

/**
 * The zoom transform that shows `bounds` with `padding` pixels to spare,
 * with the zoom clamped to [kMin, kMax]. No bounds: the whole world.
 */
export function fitTransform(
    bounds: Box | null,
    size: Size,
    { padding = FIT_PADDING, kMin = K_MIN, kMax = K_MAX, extent }: { padding?: number; kMin?: number; kMax?: number; extent?: Box } = {},
): ZoomState {
    if (!bounds || size.w <= 0 || size.h <= 0) return { k: 1, x: 0, y: 0 };
    const bw = bounds[1][0] - bounds[0][0];
    const bh = bounds[1][1] - bounds[0][1];
    const availW = Math.max(1, size.w - 2 * padding);
    const availH = Math.max(1, size.h - 2 * padding);
    const raw = Math.min(bw > 0 ? availW / bw : Infinity, bh > 0 ? availH / bh : Infinity);
    const k = Math.max(kMin, Math.min(kMax, Number.isFinite(raw) ? raw : kMax));
    const cx = (bounds[0][0] + bounds[1][0]) / 2;
    const cy = (bounds[0][1] + bounds[1][1]) / 2;
    const t = { k, x: size.w / 2 - k * cx, y: size.h / 2 - k * cy };
    return extent ? constrainTransform(t, size, extent) : t;
}

/* ── Pins ────────────────────────────────────────────────────────────── */

export interface PinCluster<T extends PlacedPoint = PlacedPoint> {
    key: string;
    /** Screen-space position of the biggest member. */
    at: Pt;
    members: T[];
    total: number;
    piiEvents: number;
}

/**
 * Merge pins that would overlap on screen at the current zoom into one
 * bubble. Greedy from the busiest destination down, so the bubble sits where
 * most of the traffic went and the grouping is the same on every render.
 */
export function clusterPins<T extends PlacedPoint>(placed: T[], t: ZoomState, radius = CLUSTER_RADIUS): PinCluster<T>[] {
    const order = [...placed].sort((a, b) => (b.total - a.total) || a.host.localeCompare(b.host));
    const clusters: PinCluster<T>[] = [];
    for (const d of order) {
        const at = applyZoom(d.xy, t);
        const home = clusters.find(c => Math.hypot(c.at[0] - at[0], c.at[1] - at[1]) <= radius);
        if (home) {
            home.members.push(d);
            home.total += d.total;
            home.piiEvents += d.piiEvents;
        } else {
            clusters.push({ key: d.host, at, members: [d], total: d.total, piiEvents: d.piiEvents });
        }
    }
    return clusters;
}

/** Would these pins still overlap at the deepest zoom? Then zooming cannot separate them. */
export function isSameSpot(cluster: PinCluster<PlacedPoint>, kMax = K_MAX, radius = CLUSTER_RADIUS): boolean {
    const [a] = cluster.members;
    return cluster.members.every(m => Math.hypot(m.xy[0] - a.xy[0], m.xy[1] - a.xy[1]) * kMax <= radius);
}
