/**
 * Touchpad or mouse wheel? And what should a wheel event do to the canvas?
 *
 * Browsers send both devices as the same `wheel` event, so the routine canvas
 * has to guess per gesture. The behaviour it is aiming for is the Figma/Miro
 * one:
 *
 *   touchpad, two fingers      pan, in any direction, 1:1 with the fingers
 *   touchpad, pinch            zoom around the fingers (Chrome, Edge and
 *                              Firefox send a pinch as a wheel event with
 *                              ctrlKey set; Safari sends gesture events, which
 *                              useCanvasWheel handles next to this)
 *   mouse wheel                zoom around the pointer, exactly as fast as
 *                              React Flow's own wheel zoom always was
 *   Shift + mouse wheel        pan sideways
 *   Ctrl/Cmd + either          zoom
 *
 * The guess (`deviceOfSample`), from the first event of a gesture:
 *
 *   - deltaMode 1 or 2 (lines, pages): only a wheel scrolls by the line.
 *     `deltaMode` must be read BEFORE the deltas: Firefox converts line
 *     deltas to pixels for pages that read the deltas first.
 *   - movement on both axes at once: fingers, not a wheel.
 *   - one axis, 40 px or more: a wheel notch. Notches are 100 or 120 px in
 *     Chrome and Edge, 53 or 120 on Linux, and scaled by the browser zoom
 *     (90.9 at 110%), so the size is the signal, not whether it is an
 *     integer. A touchpad gesture starts with small movements.
 *   - one axis, a multiple of 4.000244140625: Chrome's mouse wheel on macOS.
 *   - anything else small: a touchpad.
 *
 * A gesture is a burst: events closer than GESTURE_GAP_MS apart belong to the
 * one that started it, and keep its device (`classifyWheel`). So a flick's
 * momentum tail, whose deltas can grow past 40 px, never turns a pan into a
 * zoom halfway, and a free-spinning wheel stays a zoom however small its late
 * deltas get.
 *
 * Everything here is pure; the DOM side is flow/useCanvasWheel.ts.
 */

export type WheelDevice = 'touchpad' | 'mouse';

/** The parts of a WheelEvent this module reads. */
export interface WheelSample {
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    /** Milliseconds on any monotonic clock (`event.timeStamp`). */
    timeStamp: number;
}

/** What the last gesture was, for the next event to continue. */
export interface WheelMemory {
    device: WheelDevice | null;
    lastAt: number;
}

export type WheelIntent =
    | { kind: 'pan'; dx: number; dy: number }
    | { kind: 'zoom'; factor: number }
    | { kind: 'none' };

export interface Viewport {
    x: number;
    y: number;
    zoom: number;
}

export interface ZoomLimits {
    minZoom: number;
    maxZoom: number;
}

/** Events this close together are one gesture and keep one device. */
export const GESTURE_GAP_MS = 400;
/** A single-axis delta this large starts a mouse-wheel gesture. */
export const NOTCH_MIN_PX = 40;
/** Chrome on macOS reports a mouse wheel step as a multiple of this. */
const MAC_CHROME_WHEEL_STEP = 4.000244140625;
/** Pixels per line and per page for deltaMode 1 and 2. 20 per line is what React Flow's own pan-on-scroll uses. */
const LINE_PX = 20;
const PAGE_PX = 800;
/**
 * The most one pinch event may zoom. Chrome reports a pinch as
 * deltaY = -100 * ln(scale), so exp(-deltaY / 100) follows the fingers 1:1;
 * the cap only catches an outlier event.
 */
export const PINCH_STEP_MAX = 1.25;
/** The most one mouse-wheel event may zoom. A notch is 2^0.2 = 1.149; only a page-mode delta gets near this. */
export const WHEEL_STEP_MAX = 2;

export const EMPTY_WHEEL_MEMORY: WheelMemory = Object.freeze({ device: null, lastAt: Number.NEGATIVE_INFINITY });

function isMacChromeWheelStep(d: number): boolean {
    const steps = d / MAC_CHROME_WHEEL_STEP;
    return steps >= 1 && Math.abs(steps - Math.round(steps)) < 1e-6;
}

/**
 * The device a single event looks like, on its own. Null when the event moves
 * nothing (Safari sends empty events at a gesture's edges): no evidence.
 */
export function deviceOfSample(s: WheelSample): WheelDevice | null {
    if (s.deltaMode !== 0) return 'mouse';
    const ax = Math.abs(s.deltaX);
    const ay = Math.abs(s.deltaY);
    if (ax !== 0 && ay !== 0) return 'touchpad';
    const d = ax || ay;
    if (d === 0) return null;
    if (d >= NOTCH_MIN_PX) return 'mouse';
    if (isMacChromeWheelStep(d)) return 'mouse';
    return 'touchpad';
}

/**
 * The device for this event: the running gesture's while the burst lasts,
 * otherwise this event's own look. Returns the memory for the next event.
 */
export function classifyWheel(memory: WheelMemory, s: WheelSample): { device: WheelDevice; memory: WheelMemory } {
    const gap = s.timeStamp - memory.lastAt;
    const inGesture = memory.device !== null && gap >= 0 && gap < GESTURE_GAP_MS;
    if (inGesture && memory.device) {
        return { device: memory.device, memory: { device: memory.device, lastAt: s.timeStamp } };
    }
    const seen = deviceOfSample(s);
    // An empty event neither starts a gesture nor tells us anything.
    if (seen === null) return { device: memory.device ?? 'touchpad', memory };
    return { device: seen, memory: { device: seen, lastAt: s.timeStamp } };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function unitPx(deltaMode: number): number {
    if (deltaMode === 1) return LINE_PX;
    if (deltaMode === 2) return PAGE_PX;
    return 1;
}

/** How much one zooming event scales the canvas (> 1 zooms in). */
export function zoomFactor(device: WheelDevice, s: WheelSample): number {
    if (device === 'touchpad') {
        return clamp(Math.exp((-s.deltaY * unitPx(s.deltaMode)) / 100), 1 / PINCH_STEP_MAX, PINCH_STEP_MAX);
    }
    // React Flow's (and d3-zoom's) wheel speed, unchanged for mouse users.
    const perUnit = s.deltaMode === 1 ? 0.05 : s.deltaMode === 2 ? 1 : 0.002;
    return clamp(2 ** (-s.deltaY * perUnit), 1 / WHEEL_STEP_MAX, WHEEL_STEP_MAX);
}

/** What one wheel event asks of the canvas, given the device it came from. */
export function wheelIntent(device: WheelDevice, s: WheelSample): WheelIntent {
    if (s.deltaX === 0 && s.deltaY === 0) return { kind: 'none' };
    const unit = unitPx(s.deltaMode);
    if (s.ctrlKey || s.metaKey) return { kind: 'zoom', factor: zoomFactor(device, s) };
    if (device === 'touchpad') return { kind: 'pan', dx: s.deltaX * unit, dy: s.deltaY * unit };
    // A mouse. Shift turns the wheel sideways: some platforms already moved
    // the delta to X by then, others leave it on Y with shiftKey set.
    if (s.shiftKey) return { kind: 'pan', dx: (s.deltaX !== 0 ? s.deltaX : s.deltaY) * unit, dy: 0 };
    // A tilt wheel's sideways click.
    if (s.deltaY === 0) return { kind: 'pan', dx: s.deltaX * unit, dy: 0 };
    return { kind: 'zoom', factor: zoomFactor('mouse', s) };
}

/**
 * Clamp a zoom step to the limits, in the direction of travel only. A
 * programmatic fit may leave the canvas outside them (the build camera fits
 * down to 20%, React Flow's wheel floor is 50%); a step towards the range is
 * taken as asked, and a step away from it leaves the zoom where it is, where
 * a plain clamp would jump the canvas from 20% to 50% on a zoom-OUT.
 */
export function clampZoomStep(current: number, next: number, { minZoom, maxZoom }: ZoomLimits): number {
    if (next < current) return Math.max(next, Math.min(minZoom, current));
    if (next > current) return Math.min(next, Math.max(maxZoom, current));
    return current;
}

/**
 * The viewport after scaling by `factor` around `point` (pixels from the
 * canvas's top-left corner), so the spot under the pointer stays put.
 * Returns the same object when the zoom cannot move.
 */
export function zoomViewportAt(vp: Viewport, factor: number, point: { x: number; y: number }, limits: ZoomLimits): Viewport {
    if (!Number.isFinite(factor) || factor <= 0 || !(vp.zoom > 0)) return vp;
    const zoom = clampZoomStep(vp.zoom, vp.zoom * factor, limits);
    if (zoom === vp.zoom) return vp;
    const r = zoom / vp.zoom;
    return { x: point.x - (point.x - vp.x) * r, y: point.y - (point.y - vp.y) * r, zoom };
}

/** The viewport after the content moves by (-dx, -dy) screen pixels: the scroll direction, as on any page. */
export function panViewport(vp: Viewport, dx: number, dy: number): Viewport {
    if (dx === 0 && dy === 0) return vp;
    return { x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom };
}
