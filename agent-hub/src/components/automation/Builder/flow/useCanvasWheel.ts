import { useEffect } from 'react';
import type { RefObject } from 'react';
import {
    EMPTY_WHEEL_MEMORY, PINCH_STEP_MAX, classifyWheel, panViewport, wheelIntent, zoomViewportAt,
} from './wheelInput';
import type { Viewport, WheelIntent, WheelMemory, WheelSample, ZoomLimits } from './wheelInput';

/**
 * Wheel, touchpad and pinch input for the automation canvas.
 *
 * React Flow can do "wheel zooms" or "wheel pans", not both, and its pinch
 * path zooms ten times slower off macOS. So this hook owns every wheel event
 * over the canvas: flow/wheelInput.ts decides per gesture whether it came from
 * a touchpad (two fingers pan, pinch zooms around the fingers) or a mouse
 * (the wheel zooms, as it always did; Shift+wheel pans sideways), and the
 * result is applied through React Flow's own viewport, so the zoom stack,
 * the LOD breaks and the build camera see an ordinary move.
 *
 * Scope, so that nothing else changes:
 *   - Only events whose target is inside React Flow's renderer (the pane, the
 *     cards, the edges) move the canvas. The overlays drawn over it (legend,
 *     zoom stack, line colours, the south bar, the minimap) are outside the
 *     renderer, and their own lists keep scrolling natively. A pinch over one
 *     of them is still kept from zooming the whole browser page.
 *   - Inside the renderer, `.nowheel` (React Flow's opt-out) and text being
 *     edited (a note's textarea) keep their native scroll.
 *   - The listener sits on the wrapper in the CAPTURE phase and stops the
 *     events it handles, so React Flow's own wheel handler never sees them.
 *     Everything else about the canvas (drag to select, Space or the middle
 *     button to pan, touchscreen pinch, double-click) stays React Flow's.
 *
 * Safari reports a trackpad pinch as gesturestart/gesturechange/gestureend
 * instead of ctrl+wheel; those are handled here too, zooming by the gesture's
 * cumulative scale from where it started.
 */

/** What the hook needs from React Flow's instance (`useReactFlow()`). */
export interface CanvasCamera {
    getViewport(): Viewport;
    setViewport(viewport: Viewport): unknown;
}

/** What the hook reads from React Flow's store (`useStoreApi()`). */
export interface CanvasStore {
    getState(): ZoomLimits & { userSelectionActive?: boolean };
}

export interface UseCanvasWheelOptions {
    /** The element around <ReactFlow>. Listeners go on it. */
    wrapperRef: RefObject<HTMLElement | null>;
    rf: CanvasCamera | null | undefined;
    store: CanvasStore | null | undefined;
    /** False on a read-only canvas, and while no canvas is mounted. */
    enabled: boolean;
}

/** React Flow's pan-and-zoom surface: the pane plus everything drawn on it. */
export const CANVAS_SURFACE_SELECTOR = '.react-flow__renderer';
const NO_WHEEL_SELECTOR = '.nowheel';
// Only what can scroll its own text. A one-line input cannot, and a scroll
// that starts over one should still move the canvas.
const TEXT_EDIT_SELECTOR = 'textarea, [contenteditable=""], [contenteditable="true"]';
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };

/** Safari's GestureEvent, which lib.dom does not describe. */
interface GestureLike extends Event {
    scale?: number;
    clientX?: number;
    clientY?: number;
}

type WheelRoute = { kind: 'overlay' } | { kind: 'native' } | { kind: 'canvas'; surface: Element };

function asElement(target: EventTarget | null): Element | null {
    return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function surfaceOf(el: Element | null, wrapper: Element): Element | null {
    const surface = el?.closest(CANVAS_SURFACE_SELECTOR) ?? null;
    return surface && wrapper.contains(surface) ? surface : null;
}

/** Who a wheel event belongs to: an overlay, an element's own scroll, or the canvas. */
function routeWheel(e: WheelEvent, wrapper: Element): WheelRoute {
    const target = asElement(e.target);
    const surface = surfaceOf(target, wrapper);
    if (!surface || !target) return { kind: 'overlay' };
    const zooming = e.ctrlKey || e.metaKey;
    if (target.closest(NO_WHEEL_SELECTOR) || (!zooming && target.closest(TEXT_EDIT_SELECTOR))) return { kind: 'native' };
    return { kind: 'canvas', surface };
}

function sampleOf(e: WheelEvent): WheelSample {
    return {
        // deltaMode first: Firefox converts line deltas to pixels for a page
        // that reads the deltas before it.
        deltaMode: e.deltaMode,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        timeStamp: e.timeStamp || performance.now(),
    };
}

/** Pan and zoom through React Flow's viewport, inside React Flow's zoom limits. */
function cameraMoves(rf: CanvasCamera, store: CanvasStore) {
    const zoomAt = (surface: Element, factor: number, clientX: number, clientY: number) => {
        const vp = rf.getViewport();
        const rect = surface.getBoundingClientRect();
        const { minZoom, maxZoom } = store.getState();
        const next = zoomViewportAt(vp, factor, { x: clientX - rect.left, y: clientY - rect.top }, { minZoom, maxZoom });
        if (next !== vp) rf.setViewport(next);
    };
    const apply = (intent: WheelIntent, surface: Element, clientX: number, clientY: number) => {
        if (intent.kind === 'zoom') {
            zoomAt(surface, intent.factor, clientX, clientY);
        } else if (intent.kind === 'pan') {
            const vp = rf.getViewport();
            const next = panViewport(vp, intent.dx, intent.dy);
            if (next !== vp) rf.setViewport(next);
        }
    };
    return { zoomAt, apply };
}

/** Safari's pinch: gesture events with a cumulative `scale`. */
function listenSafariPinch(wrapper: HTMLElement, rf: CanvasCamera, store: CanvasStore, zoomAt: ReturnType<typeof cameraMoves>['zoomAt']) {
    let gesture: { startZoom: number; surface: Element } | null = null;
    const onStart = (e: Event) => {
        e.preventDefault();
        const target = asElement(e.target);
        const surface = surfaceOf(target, wrapper);
        gesture = surface && !target?.closest(NO_WHEEL_SELECTOR) && !store.getState().userSelectionActive
            ? { startZoom: rf.getViewport().zoom, surface }
            : null;
    };
    const onChange = (e: Event) => {
        e.preventDefault();
        const g = e as GestureLike;
        if (!gesture || !(typeof g.scale === 'number' && g.scale > 0)) return;
        // Absolute from the gesture's start, capped per event like a pinch.
        const wanted = (gesture.startZoom * g.scale) / rf.getViewport().zoom;
        const factor = Math.min(PINCH_STEP_MAX, Math.max(1 / PINCH_STEP_MAX, wanted));
        const rect = gesture.surface.getBoundingClientRect();
        zoomAt(gesture.surface, factor, g.clientX ?? rect.left + rect.width / 2, g.clientY ?? rect.top + rect.height / 2);
    };
    const onEnd = (e: Event) => {
        e.preventDefault();
        gesture = null;
    };
    const pairs: [string, (e: Event) => void][] = [['gesturestart', onStart], ['gesturechange', onChange], ['gestureend', onEnd]];
    for (const [type, fn] of pairs) wrapper.addEventListener(type, fn, LISTENER_OPTIONS);
    return {
        active: () => gesture !== null,
        detach: () => { for (const [type, fn] of pairs) wrapper.removeEventListener(type, fn, LISTENER_OPTIONS); },
    };
}

/** Wire the wrapper; returns the detach. */
function listenCanvasWheel(wrapper: HTMLElement, rf: CanvasCamera, store: CanvasStore): () => void {
    let memory: WheelMemory = EMPTY_WHEEL_MEMORY;
    const camera = cameraMoves(rf, store);
    const pinch = listenSafariPinch(wrapper, rf, store, camera.zoomAt);
    const onWheel = (e: WheelEvent) => {
        const route = routeWheel(e, wrapper);
        if (route.kind !== 'canvas') {
            // A pinch must not zoom the browser page. An element's own scroll
            // stays native, and out of React Flow's reach (its handler would
            // preventDefault it); an overlay is not React Flow's anyway.
            if (e.ctrlKey) e.preventDefault();
            if (route.kind === 'native') e.stopPropagation();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        // React Flow's rule: no pan or zoom while a selection box is drawn.
        // And during a Safari pinch the gesture events carry the zoom.
        if (store.getState().userSelectionActive || (pinch.active() && e.ctrlKey)) return;
        const sample = sampleOf(e);
        const classified = classifyWheel(memory, sample);
        memory = classified.memory;
        camera.apply(wheelIntent(classified.device, sample), route.surface, e.clientX, e.clientY);
    };
    wrapper.addEventListener('wheel', onWheel, LISTENER_OPTIONS);
    return () => {
        wrapper.removeEventListener('wheel', onWheel, LISTENER_OPTIONS);
        pinch.detach();
    };
}

export function useCanvasWheel({ wrapperRef, rf, store, enabled }: UseCanvasWheelOptions): void {
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!enabled || !wrapper || !rf || !store) return undefined;
        return listenCanvasWheel(wrapper, rf, store);
    }, [enabled, rf, store, wrapperRef]);
}
