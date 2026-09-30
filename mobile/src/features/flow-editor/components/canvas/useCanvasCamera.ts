/**
 * The canvas camera as live state: the pan, pinch and double-tap gestures,
 * the world view's transform, and what React needs to know about it.
 *
 * The viewport lives in Reanimated shared values and every gesture updates
 * it on the UI thread (viewport.ts's worklets), so panning and zooming never
 * re-render a node. React hears about the camera only when something it
 * draws differently changes: the level of detail (tiles below 60%), the
 * lines' resolution, and the patch of world worth mounting (the visible
 * rect, grown by half a screen and snapped to a grid) — a reaction that
 * fires a handful of times across a whole pinch, not every frame.
 *
 * Shared values are read and written with get()/set(), the React Compiler's
 * spelling: an assignment to `.value` looks to it like mutating a hook's
 * return value.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import { useAnimatedReaction, useAnimatedStyle, useSharedValue, withDecay, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { resolutionFor } from './edgePath';
import {
    clampToContent, doubleTapScale, firstView, fitInside, focusViewport, lodFor, NO_INSETS, panLimits, pinchViewport, snapRect, visibleRect, zoomAround, zoomBy,
    type Insets, type Lod, type Point, type Rect, type Size, type Viewport,
} from './viewport';

/** The grid the mounted patch of world snaps to. */
const CULL_CELL = 512;
const MOVE = { duration: 220 };

export interface CameraView {
    lod: Lod;
    /** The lines' resolution (edgePath resolutionFor). */
    res: number;
    /** What part of the world is worth mounting; null until the camera reports. */
    rect: Rect | null;
}

interface ViewKey {
    lod: Lod;
    res: number;
    x: number;
    y: number;
    w: number;
    h: number;
}

type Limits = { bounds: SharedValue<Rect | null>; size: SharedValue<Size> };
type Axes = { tx: SharedValue<number>; ty: SharedValue<number>; scale: SharedValue<number> };

function useCameraGestures({ tx, ty, scale }: Axes, { bounds, size }: Limits) {
    const panStart = useSharedValue<Point>({ x: 0, y: 0 });
    const lastPan = useSharedValue<Point>({ x: 0, y: 0 });
    const pinchStart = useSharedValue<Viewport>({ x: 0, y: 0, scale: 1 });
    const pinchOrigin = useSharedValue<Point>({ x: 0, y: 0 });
    const pinching = useSharedValue(false);
    return useMemo(() => {
        const put = (vp: Viewport) => {
            'worklet';
            const next = clampToContent(vp, bounds.get(), size.get());
            tx.set(next.x);
            ty.set(next.y);
            scale.set(next.scale);
        };
        const pan = Gesture.Pan()
            .withTestId('canvas-pan')
            .averageTouches(true)
            .onStart((e) => {
                panStart.set({ x: tx.get() - e.translationX, y: ty.get() - e.translationY });
            })
            .onUpdate((e) => {
                lastPan.set({ x: e.translationX, y: e.translationY });
                if (!pinching.get()) put({ x: panStart.get().x + e.translationX, y: panStart.get().y + e.translationY, scale: scale.get() });
            })
            .onEnd((e) => {
                // A flick glides on and slows, as every phone list does; it
                // stops where the flow would leave the screen.
                const content = bounds.get();
                if (pinching.get() || !content) return;
                const limits = panLimits(content, size.get(), scale.get());
                tx.set(withDecay({ velocity: e.velocityX, clamp: limits.x }));
                ty.set(withDecay({ velocity: e.velocityY, clamp: limits.y }));
            });
        const pinch = Gesture.Pinch()
            .withTestId('canvas-pinch')
            .onStart((e) => {
                pinching.set(true);
                pinchStart.set({ x: tx.get(), y: ty.get(), scale: scale.get() });
                pinchOrigin.set({ x: e.focalX, y: e.focalY });
            })
            .onUpdate((e) => {
                put(pinchViewport(pinchStart.get(), pinchOrigin.get(), { x: e.focalX, y: e.focalY }, e.scale));
            })
            .onFinalize(() => {
                // A finger that stays down pans on from where the pinch left the view.
                pinching.set(false);
                panStart.set({ x: tx.get() - lastPan.get().x, y: ty.get() - lastPan.get().y });
            });
        const doubleTap = Gesture.Tap()
            .withTestId('canvas-double-tap')
            .numberOfTaps(2)
            .maxDelay(260)
            .onEnd((e, success) => {
                if (!success) return;
                const next = zoomAround({ x: tx.get(), y: ty.get(), scale: scale.get() }, { x: e.x, y: e.y }, doubleTapScale(scale.get()));
                tx.set(withTiming(next.x, MOVE));
                ty.set(withTiming(next.y, MOVE));
                scale.set(withTiming(next.scale, MOVE));
            });
        return Gesture.Race(doubleTap, Gesture.Simultaneous(pan, pinch));
    }, [tx, ty, scale, bounds, size, panStart, lastPan, pinchStart, pinchOrigin, pinching]);
}

/** Tell React about the camera only when what it draws changes. */
function useCameraView({ tx, ty, scale }: Axes, size: SharedValue<Size>): CameraView {
    const [view, setView] = useState<CameraView>({ lod: 'card', res: 1, rect: null });
    const apply = (k: ViewKey) => setView({ lod: k.lod, res: k.res, rect: { x: k.x, y: k.y, width: k.w, height: k.h } });
    useAnimatedReaction(
        (): ViewKey | null => {
            const s = size.get();
            if (s.width <= 0 || s.height <= 0) return null;
            const vp = { x: tx.get(), y: ty.get(), scale: scale.get() };
            const r = snapRect(visibleRect(vp, s, 0.5), CULL_CELL);
            return { lod: lodFor(vp.scale), res: resolutionFor(vp.scale), x: r.x, y: r.y, w: r.width, h: r.height };
        },
        (next, prev) => {
            if (!next) return;
            const same = prev && next.lod === prev.lod && next.res === prev.res && next.x === prev.x && next.y === prev.y && next.w === prev.w && next.h === prev.h;
            if (!same) scheduleOnRN(apply, next);
        },
    );
    return view;
}

export interface Camera {
    gesture: ReturnType<typeof useCameraGestures>;
    worldStyle: ReturnType<typeof useAnimatedStyle>;
    onLayout: (e: LayoutChangeEvent) => void;
    view: CameraView;
    /** The patch to mount before the camera reports one: where the first fit puts it. */
    initialRect: Rect | null;
    /** The canvas's size on screen. */
    size: Size;
    scale: SharedValue<number>;
    /** The whole flow, however small. */
    fit: () => void;
    /** The first view again: readable, the flow's start in view. */
    fitReadable: () => void;
    zoomBy: (factor: number) => void;
    zoomTo: (scale: number) => void;
    /** Fit again as soon as the content next changes (after Arrange). */
    fitNext: () => void;
    /** Glide to `rect` (a node just added) unless it is already on screen. */
    focus: (rect: Rect) => void;
}

/**
 * The camera over `content` (the scene's bounds), drawn in a world view whose
 * top left is `frame`'s; `insets` is what the controls cover at the top and
 * the bottom, which a fit keeps the flow out of.
 */
export function useCanvasCamera(content: Rect | null, frame: Rect, insets: Insets = NO_INSETS): Camera {
    const axes: Axes = { tx: useSharedValue(0), ty: useSharedValue(0), scale: useSharedValue(1) };
    const { tx, ty, scale } = axes;
    const size = useSharedValue<Size>({ width: 0, height: 0 });
    const bounds = useSharedValue<Rect | null>(content);
    const origin = useSharedValue<Point>({ x: frame.x, y: frame.y });
    const [box, setBox] = useState<Size>({ width: 0, height: 0 });
    // Fit once there is content and room to fit it in; again only on request (after Arrange).
    const needsFit = useRef(true);

    useEffect(() => bounds.set(content), [bounds, content]);
    useEffect(() => origin.set({ x: frame.x, y: frame.y }), [origin, frame.x, frame.y]);

    const gesture = useCameraGestures(axes, { bounds, size });
    const view = useCameraView(axes, size);
    const worldStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.get() + scale.get() * origin.get().x }, { translateY: ty.get() + scale.get() * origin.get().y }, { scale: scale.get() }],
    }));

    const setViewport = (vp: Viewport, animate: boolean) => {
        tx.set(animate ? withTiming(vp.x, MOVE) : vp.x);
        ty.set(animate ? withTiming(vp.y, MOVE) : vp.y);
        scale.set(animate ? withTiming(vp.scale, MOVE) : vp.scale);
    };
    const current = (): Viewport => ({ x: tx.get(), y: ty.get(), scale: scale.get() });

    useEffect(() => {
        if (!needsFit.current || !content || box.width <= 0) return;
        needsFit.current = false;
        setViewport(firstView(content, box, insets), false);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fit when the content arrives (or after Arrange), not on every camera change
    }, [content, box]);

    return {
        gesture,
        worldStyle,
        view,
        initialRect: content && box.width > 0 ? snapRect(visibleRect(firstView(content, box, insets), box, 0.5), CULL_CELL) : null,
        size: box,
        scale,
        onLayout: (e) => {
            const { width, height } = e.nativeEvent.layout;
            size.set({ width, height });
            setBox({ width, height });
        },
        fit: () => {
            if (content && box.width > 0) setViewport(fitInside(content, box, insets), true);
        },
        fitReadable: () => {
            if (content && box.width > 0) setViewport(firstView(content, box, insets), true);
        },
        zoomBy: (factor) => setViewport(zoomBy(current(), box, factor), true),
        zoomTo: (next) => setViewport(zoomAround(current(), { x: box.width / 2, y: box.height / 2 }, next), true),
        fitNext: () => {
            needsFit.current = true;
        },
        focus: (rect) => {
            const next = focusViewport(current(), rect, box, insets);
            if (next) setViewport(next, true);
        },
    };
}
