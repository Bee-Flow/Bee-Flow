/**
 * The canvas camera, as pure math: where the flow sits on the screen, how
 * far it is zoomed, and every move a finger or a button makes to that — the
 * phone's half of what React Flow does for the web's DiagramPane (fitView,
 * zoomIn/zoomOut, pinch, and the zoom stack's limits).
 *
 * A viewport maps a point of the flow ("world", the definition's own
 * coordinates) to the screen: `screen = world × scale + (x, y)`. Every
 * function is a worklet, so the gesture handlers run them on the UI thread
 * without a round trip through React; they are ordinary functions in a test.
 *
 * Level of detail follows the web's useZoomLod.js in spirit — a card that is
 * too small to read draws as a shape — with ONE break, at 60%: a phone card
 * at 60% is 144dp wide, and its 11px kicker is already below what a phone
 * shows legibly, so the web's middle level (name, no summary) has no room.
 */

export interface Point {
    x: number;
    y: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface Rect extends Point, Size {}

export interface Viewport extends Point {
    scale: number;
}

/** React Flow's default zoom range on the web is 0.5–2; a phone needs to see further out. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
/** The web's fitView padding (DiagramPane `fitViewOptions.padding`). */
export const FIT_PADDING = 0.08;
/** Fit never enlarges past 100%: two cards filling a phone read worse than two cards. */
export const FIT_MAX_SCALE = 1;
/** One press of zoom in / zoom out (React Flow's zoomIn step). */
export const ZOOM_STEP = 1.2;
/** Below this the cards draw as tiles: the family colour and the glyph. */
export const COMPACT_BELOW = 0.6;
/** However far a pan goes, this much of the flow stays on screen. */
export const KEEP_VISIBLE = 48;

export type Lod = 'tile' | 'card';

export function clampScale(scale: number): number {
    'worklet';
    if (!Number.isFinite(scale)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function lodFor(scale: number): Lod {
    'worklet';
    return scale < COMPACT_BELOW ? 'tile' : 'card';
}

export function screenToWorld(vp: Viewport, p: Point): Point {
    'worklet';
    return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

export function worldToScreen(vp: Viewport, p: Point): Point {
    'worklet';
    return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

/** Zoom to `scale` (clamped) keeping the world point under `focal` where it is. */
export function zoomAround(vp: Viewport, focal: Point, scale: number): Viewport {
    'worklet';
    const next = clampScale(scale);
    const world = screenToWorld(vp, focal);
    return { x: focal.x - world.x * next, y: focal.y - world.y * next, scale: next };
}

/**
 * A pinch, from the viewport it started on: the world point under the
 * fingers' first midpoint follows the midpoint wherever it goes (so two
 * fingers pan while they zoom), at the start scale × the pinch factor.
 */
export function pinchViewport(start: Viewport, origin: Point, focal: Point, factor: number): Viewport {
    'worklet';
    const scale = clampScale(start.scale * factor);
    const world = screenToWorld(start, origin);
    return { x: focal.x - world.x * scale, y: focal.y - world.y * scale, scale };
}

/** Zoom in or out around the middle of the screen (the zoom buttons). */
export function zoomBy(vp: Viewport, size: Size, factor: number): Viewport {
    'worklet';
    return zoomAround(vp, { x: size.width / 2, y: size.height / 2 }, vp.scale * factor);
}

/** Double-tap: twice as close each time, and from the closest back to 100%. */
export function doubleTapScale(scale: number): number {
    'worklet';
    return scale >= MAX_SCALE - 0.01 ? 1 : clampScale(scale * 2);
}

/** One axis of a fit: centred when the content fits, from its start (plus the padding) when it does not. */
function fitAxis(start: number, extent: number, room: number, scale: number): number {
    'worklet';
    const drawn = extent * scale;
    if (drawn <= room) return room / 2 - (start + extent / 2) * scale;
    return (room * FIT_PADDING) / 2 - start * scale;
}

/**
 * The viewport that shows `rect` whole — React Flow's getViewportForBounds
 * (the same padding rule), held between `minScale` and `maxScale`. When the
 * floor cannot fit it, the flow's start (its trigger, top left) stays on
 * screen rather than its middle.
 */
export function fitRect(rect: Rect, size: Size, { minScale = MIN_SCALE, maxScale = FIT_MAX_SCALE }: { minScale?: number; maxScale?: number } = {}): Viewport {
    'worklet';
    if (size.width <= 0 || size.height <= 0 || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, scale: 1 };
    const zoom = Math.min(size.width / (rect.width * (1 + FIT_PADDING)), size.height / (rect.height * (1 + FIT_PADDING)));
    const scale = Math.min(Math.max(clampScale(zoom), clampScale(minScale)), clampScale(maxScale));
    return { x: fitAxis(rect.x, rect.width, size.width, scale), y: fitAxis(rect.y, rect.height, size.height, scale), scale };
}

/** Room at the canvas's edges that controls float over, which a fit keeps the flow out of. */
export interface Insets {
    top: number;
    bottom: number;
}

export const NO_INSETS: Insets = { top: 0, bottom: 0 };

/** fitRect inside the part of the screen no control covers. */
export function fitInside(rect: Rect, size: Size, insets: Insets, opts: { minScale?: number; maxScale?: number } = {}): Viewport {
    'worklet';
    const room = { width: size.width, height: Math.max(1, size.height - insets.top - insets.bottom) };
    const vp = fitRect(rect, room, opts);
    return { x: vp.x, y: vp.y + insets.top, scale: vp.scale };
}

/**
 * The first view of an automation: the whole of it when that is still readable,
 * else its start at the smallest size a card is drawn as a card — a phone
 * that opens on a field of tiles has to be zoomed before anything can be
 * read or tapped. Fit shows the whole of it at any size.
 */
export function firstView(rect: Rect, size: Size, insets: Insets = NO_INSETS): Viewport {
    'worklet';
    return fitInside(rect, size, insets, { minScale: COMPACT_BELOW });
}

/**
 * Bring `rect` (a node just added) into view: null when it already is,
 * whole, inside the part of the screen no control covers; else the viewport
 * with it in the middle of that part, at the current zoom or at least the
 * size a card reads at.
 */
export function focusViewport(vp: Viewport, rect: Rect, size: Size, insets: Insets = NO_INSETS): Viewport | null {
    'worklet';
    if (size.width <= 0 || size.height <= 0) return null;
    const top = worldToScreen(vp, { x: rect.x, y: rect.y });
    const bottom = worldToScreen(vp, { x: rect.x + rect.width, y: rect.y + rect.height });
    const inView = top.x >= 0 && bottom.x <= size.width && top.y >= insets.top && bottom.y <= size.height - insets.bottom;
    if (inView && vp.scale >= COMPACT_BELOW) return null;
    const scale = Math.max(vp.scale, COMPACT_BELOW);
    const room = size.height - insets.top - insets.bottom;
    return {
        x: size.width / 2 - (rect.x + rect.width / 2) * scale,
        y: insets.top + room / 2 - (rect.y + rect.height / 2) * scale,
        scale,
    };
}

/** One axis of the pan limit; `span` is the content's [start, extent] on it. */
function clampAxis(t: number, span: [number, number], room: number, scale: number): number {
    'worklet';
    const [start, extent] = span;
    const keep = Math.min(KEEP_VISIBLE, room / 2, (extent * scale) / 2);
    const lo = keep - (start + extent) * scale;
    const hi = room - keep - start * scale;
    return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, t));
}

/** How far a pan may go on each axis at `scale`: [lowest, highest] translation. */
export function panLimits(content: Rect, size: Size, scale: number): { x: [number, number]; y: [number, number] } {
    'worklet';
    const axis = (start: number, extent: number, room: number): [number, number] => {
        const keep = Math.min(KEEP_VISIBLE, room / 2, (extent * scale) / 2);
        const lo = keep - (start + extent) * scale;
        const hi = room - keep - start * scale;
        return lo > hi ? [(lo + hi) / 2, (lo + hi) / 2] : [lo, hi];
    };
    return { x: axis(content.x, content.width, size.width), y: axis(content.y, content.height, size.height) };
}

/** A pan that cannot lose the flow: at least KEEP_VISIBLE of it stays on screen, on both axes. */
export function clampToContent(vp: Viewport, content: Rect | null, size: Size): Viewport {
    'worklet';
    if (!content || size.width <= 0 || size.height <= 0) return vp;
    return {
        x: clampAxis(vp.x, [content.x, content.width], size.width, vp.scale),
        y: clampAxis(vp.y, [content.y, content.height], size.height, vp.scale),
        scale: vp.scale,
    };
}

/** What part of the world the screen shows, grown by `margin` screens on every side. */
export function visibleRect(vp: Viewport, size: Size, margin = 0.5): Rect {
    'worklet';
    const w = size.width / vp.scale;
    const h = size.height / vp.scale;
    const origin = screenToWorld(vp, { x: 0, y: 0 });
    return { x: origin.x - w * margin, y: origin.y - h * margin, width: w * (1 + 2 * margin), height: h * (1 + 2 * margin) };
}

/**
 * The visible rect snapped outwards to a grid of `cell` world units, so that
 * panning a little does not change it: the canvas re-culls only when the
 * snapped rect moves.
 */
export function snapRect(rect: Rect, cell: number): Rect {
    'worklet';
    const x0 = Math.floor(rect.x / cell) * cell;
    const y0 = Math.floor(rect.y / cell) * cell;
    const x1 = Math.ceil((rect.x + rect.width) / cell) * cell;
    const y1 = Math.ceil((rect.y + rect.height) / cell) * cell;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function intersects(a: Rect, b: Rect): boolean {
    'worklet';
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Room around the content inside the world view, so a drag or a new step stays touchable. */
export const FRAME_MARGIN = 1024;
/** The world view's box snaps to this grid, so it (and every node's offset in it) rarely changes. */
export const FRAME_CELL = 2048;

/**
 * The box of the view the whole flow is drawn in. Android delivers a touch
 * to a child only inside its parent's box, so the box must hold every node;
 * a node sits in it at `world − frame.x/y`.
 */
export function worldFrame(bounds: Rect | null): Rect {
    if (!bounds) return { x: -FRAME_CELL, y: -FRAME_CELL, width: 2 * FRAME_CELL, height: 2 * FRAME_CELL };
    const grown = { x: bounds.x - FRAME_MARGIN, y: bounds.y - FRAME_MARGIN, width: bounds.width + 2 * FRAME_MARGIN, height: bounds.height + 2 * FRAME_MARGIN };
    return snapRect(grown, FRAME_CELL);
}

/** The smallest rect holding every one of `rects`; null for none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
    if (rects.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width);
        y1 = Math.max(y1, r.y + r.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
