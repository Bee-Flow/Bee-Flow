import { edgeKey } from './branchEdges';
import type { DiagramDefinition, DiagramStep } from './diagramPaneTypes';
import type { Viewport } from '@xyflow/system';
import type { BiasTowardNewestArgs } from './buildChoreography.types';
import { CARD_W, CARD_H, LINEAR_ZOOM_DELTA, PUSH_REASONS, WIDE_REASONS } from './buildChoreography.constants';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Every positionable node of a definition: trigger(s) first, then steps — the same roots `flowOrder` uses. */
export function nodesOf(def: DiagramDefinition) {
    const roots = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])];
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const out = new Map<string, DiagramStep>();
    for (const n of [...roots, ...steps]) {
        if (n && n.id != null && !out.has(n.id)) out.set(n.id, n);
    }
    return out;
}

/**
 * Key-order-insensitive serialisation. The server re-serialises the whole
 * definition per draft, so two semantically equal steps can arrive with their
 * keys in a different order; a plain JSON.stringify would then flag every card
 * as "touched" on every tool call and the wash would never stop playing.
 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** A step minus its `position`: a card that only moved was not edited. */
export function contentOf(step: DiagramStep | null | undefined) {
    if (!step || typeof step !== 'object') return stableStringify(step);
    const { position: _position, ...rest } = step;
    return stableStringify(rest);
}

export function edgeKeysOf(def: DiagramDefinition) {
    const out = new Set<string>();
    for (const e of Array.isArray(def?.edges) ? def.edges : []) {
        if (e && e.from != null && e.to != null) out.add(edgeKey(e));
    }
    return out;
}

function unionRect(rects: ({ x: number; y: number; width: number; height: number } | null | undefined)[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
        if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        const w = Number.isFinite(r.width) ? r.width : 0;
        const h = Number.isFinite(r.height) ? r.height : 0;
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + w);
        maxY = Math.max(maxY, r.y + h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * React Flow's `parsePadding` for a numeric padding, verbatim
 * (`@xyflow/system parsePadding`): NOT `viewport × padding`. For 0.12 on a
 * 1100 px canvas this is 58 px a side (≈5.3 %), which is why a 6-card graph
 * lands at zoom 0.647 and not the 0.6 a naive 12 % would predict.
 */
function paddingPx(padding: number, viewportLength: number) {
    return Math.floor((viewportLength - viewportLength / (1 + padding)) * 0.5);
}

/**
 * `@xyflow/system getViewportForBounds` for a symmetric numeric padding,
 * re-implemented so the push-in can be computed from the layout's own rects
 * without waiting for measurement (`setViewport` is immediate; `fitView`
 * queues until nodes are initialised). Kept as a straight port so a wide shot
 * from here matches what `fitView` with the same options would produce.
 */
export function viewportForBounds(bounds: { x: number; y: number; width: number; height: number; }, size: { width: number; height: number; }, { minZoom, maxZoom, padding }: { minZoom: number; maxZoom: number; padding: number }) {
    const { width, height } = size;
    const px = paddingPx(padding, width);
    const py = paddingPx(padding, height);
    const zoom = clamp(Math.min((width - 2 * px) / bounds.width, (height - 2 * py) / bounds.height), minZoom, maxZoom);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    let x = width / 2 - cx * zoom;
    let y = height / 2 - cy * zoom;
    // React Flow then nudges the view so no side ends up with less than the
    // requested padding (only matters with asymmetric paddings or a clamped
    // zoom); ported for fidelity.
    const applied = appliedPadding(bounds, { x, y, zoom }, size);
    x += -Math.min(applied.left - px, 0) + Math.min(applied.right - px, 0);
    y += -Math.min(applied.top - py, 0) + Math.min(applied.bottom - py, 0);
    return { x, y, zoom, px, py };
}

function appliedPadding(bounds: { x: number; y: number; width: number; height: number }, { x, y, zoom }: { x: number; y: number; zoom: number }, { width, height }: { width: number; height: number }) {
    return {
        left: Math.floor(bounds.x * zoom + x),
        top: Math.floor(bounds.y * zoom + y),
        right: Math.floor(width - ((bounds.x + bounds.width) * zoom + x)),
        bottom: Math.floor(height - ((bounds.y + bounds.height) * zoom + y)),
    };
}

/**
 * Shift a one-axis view offset so the flow interval [start, start + length)
 * sits inside the padded viewport (`{ length, pad }`, screen px), moving as
 * little as possible; used to keep a biased push-in honest.
 */
function keepInside(offset: number, { start, length }: { start: number; length: number }, zoom: number, view: { length: number; pad: number }) {
    const lo = start * zoom + offset;
    const hi = (start + length) * zoom + offset;
    if (lo < view.pad) return offset + (view.pad - lo);
    if (hi > view.length - view.pad) return offset - (hi - (view.length - view.pad));
    return offset;
}

export function biasTowardNewest({ zoom, px, py }: BiasTowardNewestArgs, frame: { x: number; y: number; width: number; height: number; }, newest: { x: number; y: number; width: number; height: number; }, { width, height }: { width: number; height: number }) {
    const nw = Number.isFinite(newest.width) ? newest.width : CARD_W;
    const nh = Number.isFinite(newest.height) ? newest.height : CARD_H;
    const cx = 0.4 * (frame.x + frame.width / 2) + 0.6 * (newest.x + nw / 2);
    const cy = 0.4 * (frame.y + frame.height / 2) + 0.6 * (newest.y + nh / 2);
    const fitsX = frame.width * zoom <= width - 2 * px;
    const fitsY = frame.height * zoom <= height - 2 * py;
    const spanX = fitsX ? { start: frame.x, length: frame.width } : { start: newest.x, length: nw };
    const spanY = fitsY ? { start: frame.y, length: frame.height } : { start: newest.y, length: nh };
    return {
        x: keepInside(width / 2 - cx * zoom, spanX, zoom, { length: width, pad: px }),
        y: keepInside(height / 2 - cy * zoom, spanY, zoom, { length: height, pad: py }),
    };
}

/**
 * React Flow's 'smooth' interpolation zooms out and back in; on a pan whose
 * zoom barely changes that reads as a hiccup, so such a move goes linear.
 */
export function interpolateFor(kind: string, zoom: number, current: Viewport | undefined) {
    const currentZoom = Number(current?.zoom);
    if (kind === 'wide' || !Number.isFinite(currentZoom)) return 'smooth';
    return Math.abs(zoom - currentZoom) < LINEAR_ZOOM_DELTA ? 'linear' : 'smooth';
}

/** `{ width, height }` when there is a viewport to frame in, else null. */
export function viewportSize(viewport: { width: number; height: number; offsetX?: number } | null | undefined) {
    const width = Number(viewport?.width) || 0;
    const height = Number(viewport?.height) || 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/** The union of cards and ghost, or null when there is nothing with area to frame. */
export function frameOf(cards: { x: number; y: number; width: number; height: number }[], ghostRect: { x: number; y: number; width: number; height: number } | null | undefined) {
    const frame = unionRect([...cards, ghostRect]);
    return frame && frame.width > 0 && frame.height > 0 ? frame : null;
}

/** A rect with a usable position, else null — the newest card may be missing on a wide shot. */
export function placedRect(rect: { x: number; y: number; width: number; height: number } | undefined) {
    return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) ? rect : null;
}

export function movesFor(reason: string | undefined, rowWrapped: boolean) {
    const isPush = PUSH_REASONS.has(reason);
    const isWide = WIDE_REASONS.has(reason);
    if (!isPush && !isWide) return null;
    if (rowWrapped || reason === 'wrap') return ['wide', 'push'];
    return isPush ? ['push'] : ['wide'];
}
